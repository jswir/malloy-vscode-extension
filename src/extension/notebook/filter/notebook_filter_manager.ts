import * as vscode from 'vscode';
import * as Malloy from '@malloydata/malloy-interfaces';
import {ModelDef, modelDefToModelInfo} from '@malloydata/malloy';
import {v1 as uuid} from 'uuid';
import {
  parseNotebookFilterAnnotation,
  extractDimensionSpecs,
  getDimensionKey,
  generateFilterClause,
  injectWhereClause,
  extractSourceFromQuery,
  getJoinedSources,
  groupSpecsBySourceModel,
  buildDimensionalIndexQuery,
  parseIndexQueryResult,
  serializeDimensionValues,
} from '@malloydata/notebook-filters';
import type {
  DimensionSpec,
  DimensionValues,
  FilterSelection,
  SerializedDimensionValues,
} from '@malloydata/notebook-filters';
import {WorkerConnection} from '../../worker_connection';
import {
  getDocumentMetadata,
  runMalloyQuery,
} from '../../commands/utils/run_query_utils';
import {DocumentMetadata, QuerySpec} from '../../../common/types/query_spec';
import {noAwait} from '../../../util/no_await';
import type {
  FilterRendererData,
  FilterHostMessage,
} from './filter_types';

interface NotebookFilterState {
  dimensionSpecs: DimensionSpec[];
  activeFilters: FilterSelection[];
  availableValues: SerializedDimensionValues;
  filterCellIndex: number;
  sourceInfoMap: Map<string, Malloy.SourceInfo>;
  sourceJoinsMap: Map<string, Set<string>>;
  dimensionToSourceMap: Map<string, string>;
  documentMeta: DocumentMetadata;
}

export class NotebookFilterManager {
  private notebooks = new Map<string, NotebookFilterState>();
  private reExecuteTimeout: ReturnType<typeof setTimeout> | undefined;
  private reExecuteCancellation: vscode.CancellationTokenSource | undefined;
  private filterMessaging:
    | vscode.NotebookRendererMessaging
    | undefined;
  private _controller: vscode.NotebookController | undefined;
  private indexCache = new Map<string, SerializedDimensionValues>();

  constructor(
    private context: vscode.ExtensionContext,
    private worker: WorkerConnection
  ) {}

  setController(controller: vscode.NotebookController) {
    this._controller = controller;
  }

  setMessaging(messaging: vscode.NotebookRendererMessaging) {
    this.filterMessaging = messaging;
  }

  /**
   * Check if a cell contains ##(filters) annotation.
   */
  static cellHasFilters(cellText: string): boolean {
    return cellText.split('\n').some(line =>
      line.trim().startsWith('##(filters)')
    );
  }

  /**
   * Initialize filters for a notebook cell that contains ##(filters).
   * Called during cell execution.
   */
  async initializeFilters(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    cancellationToken: vscode.CancellationToken
  ): Promise<FilterRendererData | null> {
    const notebookUri = notebook.uri.toString();
    const cellText = cell.document.getText();
    const documentMeta = getDocumentMetadata(cell.document);

    // Invalidate cache since the model may have changed
    this.indexCache.delete(notebookUri);

    // Extract ##(filters) annotation from cell text
    const annotations = cellText
      .split('\n')
      .filter(line => line.trim().startsWith('##'))
      .map(line => line.trim());

    const filterConfig = parseNotebookFilterAnnotation(annotations);
    if (!filterConfig || filterConfig.filters.length === 0) {
      return null;
    }

    // Compile the model to get SourceInfo
    let modelDef: ModelDef;
    try {
      modelDef = await this.worker.sendRequest('malloy/compile', {
        documentMeta,
      });
    } catch (error) {
      console.error('Failed to compile model for filters:', error);
      return null;
    }

    if (cancellationToken.isCancellationRequested) return null;

    const modelInfo = modelDefToModelInfo(modelDef);

    // Build sourceInfoMap from ModelInfo entries
    const sourceInfoMap = new Map<string, Malloy.SourceInfo>();
    for (const entry of modelInfo.entries) {
      if (entry.kind === 'source') {
        // ModelEntryValueWithSource = {kind: 'source'} & SourceInfo
        sourceInfoMap.set(entry.name, entry as Malloy.SourceInfo);
      }
    }

    // Get the model path (notebook file name)
    const modelPath = cell.document.uri.path.split('/').pop() || '';

    // Extract dimension specs from SourceInfo + filter config
    const dimensionSpecs = extractDimensionSpecs(
      sourceInfoMap,
      filterConfig.filters,
      modelPath
    );

    if (dimensionSpecs.length === 0) {
      return null;
    }

    // Build lookup maps
    const dimensionToSourceMap = new Map<string, string>();
    for (const spec of dimensionSpecs) {
      const key = getDimensionKey(spec);
      dimensionToSourceMap.set(key, spec.source);
    }

    const sourceJoinsMap = new Map<string, Set<string>>();
    for (const [sourceName, sourceInfo] of sourceInfoMap) {
      sourceJoinsMap.set(sourceName, getJoinedSources(sourceInfo));
    }

    // Fetch initial filter values via index queries
    let availableValues: SerializedDimensionValues = {};
    try {
      availableValues = await this.fetchFilterValues(
        dimensionSpecs,
        documentMeta,
        cancellationToken
      );
    } catch (error) {
      console.error('Failed to fetch filter values:', error);
    }

    if (cancellationToken.isCancellationRequested) return null;

    // Store notebook filter state
    const state: NotebookFilterState = {
      dimensionSpecs,
      activeFilters: [],
      availableValues,
      filterCellIndex: cell.index,
      sourceInfoMap,
      sourceJoinsMap,
      dimensionToSourceMap,
      documentMeta,
    };
    this.notebooks.set(notebookUri, state);

    // Build renderer data
    const rendererData: FilterRendererData = {
      dimensionSpecs,
      availableValues,
      filterState: [],
    };

    return rendererData;
  }

  /**
   * Handle a filter change message from the renderer.
   */
  async handleFilterChange(
    notebookUri: string,
    key: string,
    selection: FilterSelection | null
  ): Promise<void> {
    const state = this.notebooks.get(notebookUri);
    if (!state) return;

    // Update active filters
    if (selection) {
      const existingIdx = state.activeFilters.findIndex(
        f =>
          getDimensionKey({
            dimensionName: f.dimensionName,
            source: f.source,
            filterType: 'NONE',
            model: '',
          }) === key
      );
      if (existingIdx >= 0) {
        state.activeFilters[existingIdx] = selection;
      } else {
        state.activeFilters.push(selection);
      }
    } else {
      state.activeFilters = state.activeFilters.filter(
        f =>
          getDimensionKey({
            dimensionName: f.dimensionName,
            source: f.source,
            filterType: 'NONE',
            model: '',
          }) !== key
      );
    }

    // Debounce re-execution
    if (this.reExecuteTimeout) {
      clearTimeout(this.reExecuteTimeout);
    }
    this.reExecuteTimeout = setTimeout(() => {
      noAwait(this.reExecuteFilteredCells(notebookUri));
    }, 300);
  }

  /**
   * Handle clear all filters message from the renderer.
   */
  async handleClearAll(notebookUri: string): Promise<void> {
    const state = this.notebooks.get(notebookUri);
    if (!state) return;

    state.activeFilters = [];

    // Re-execute without filters
    if (this.reExecuteTimeout) {
      clearTimeout(this.reExecuteTimeout);
    }
    noAwait(this.reExecuteFilteredCells(notebookUri));
  }

  /**
   * Re-execute query cells in the notebook with current active filters.
   */
  private async reExecuteFilteredCells(notebookUri: string): Promise<void> {
    const state = this.notebooks.get(notebookUri);
    if (!state) return;

    // Cancel any in-flight re-execution
    if (this.reExecuteCancellation) {
      this.reExecuteCancellation.cancel();
      this.reExecuteCancellation.dispose();
    }
    this.reExecuteCancellation = new vscode.CancellationTokenSource();
    const cancellationToken = this.reExecuteCancellation.token;

    // Find the notebook document
    const notebook = vscode.workspace.notebookDocuments.find(
      doc => doc.uri.toString() === notebookUri
    );
    if (!notebook) return;

    // Send loading state to renderer
    this.sendToRenderer({type: 'loading', loading: true});

    try {
      // Optionally re-fetch filter values with active filters applied
      if (state.activeFilters.length > 0) {
        try {
          const tokenSource = new vscode.CancellationTokenSource();
          const updatedValues = await this.fetchFilterValues(
            state.dimensionSpecs,
            state.documentMeta,
            tokenSource.token,
            state.activeFilters
          );
          state.availableValues = updatedValues;
          tokenSource.dispose();

          // Send updated values to renderer
          this.sendToRenderer({
            type: 'updateValues',
            values: updatedValues,
          });
        } catch (error) {
          console.error('Failed to refetch filter values:', error);
        }
      }

      // Re-execute each query cell
      for (const cell of notebook.getCells()) {
        if (cancellationToken.isCancellationRequested) break;
        if (cell.kind !== vscode.NotebookCellKind.Code) continue;
        if (cell.index === state.filterCellIndex) continue;

        const cellText = cell.document.getText();
        const hasQuery =
          cellText.includes('run:') ||
          cellText.includes('->') ||
          /^\s*(run|query)\s*:/m.test(cellText);

        if (!hasQuery) continue;

        // Check if this query's source has active filters
        const querySourceName = extractSourceFromQuery(cellText);
        if (!querySourceName) continue;

        const joinedSources =
          state.sourceJoinsMap.get(querySourceName) || new Set<string>();

        const filtersForSource = state.activeFilters.filter(filter => {
          return (
            filter.source === querySourceName ||
            joinedSources.has(filter.source)
          );
        });

        let queryToExecute = cellText;
        if (filtersForSource.length > 0) {
          const filterClause = generateFilterClause(
            filtersForSource,
            state.dimensionToSourceMap,
            querySourceName
          );
          if (filterClause) {
            queryToExecute = injectWhereClause(cellText, filterClause);
          }
        }

        // Execute the query
        try {
          const querySpec: QuerySpec = {
            type: 'string',
            text: queryToExecute,
            documentMeta: state.documentMeta,
          };
          const tokenSource = new vscode.CancellationTokenSource();
          const result = await runMalloyQuery(
            this.context,
            this.worker,
            querySpec,
            `filter-${notebookUri}-${cell.index}`,
            `Filtered query (cell ${cell.index})`,
            {withWebview: false},
            tokenSource.token
          );
          tokenSource.dispose();

          if (result?.resultJson && this._controller) {
            const items: vscode.NotebookCellOutputItem[] = [];
            if (result.resultJson.queryResult.structs.length) {
              items.push(
                vscode.NotebookCellOutputItem.json(
                  result.resultJson,
                  'x-application/malloy-results'
                )
              );
            }
            items.push(
              vscode.NotebookCellOutputItem.json(
                result.resultJson.queryResult.result
              )
            );
            items.push(
              vscode.NotebookCellOutputItem.text(
                result.resultJson.queryResult.sql,
                'text/x-sql'
              )
            );

            // Use cell execution to update outputs
            const cellExecution =
              this._controller.createNotebookCellExecution(cell);
            cellExecution.start(Date.now());
            const output = new vscode.NotebookCellOutput(items);
            await cellExecution.replaceOutput([output]);
            cellExecution.end(true, Date.now());
          }
        } catch (error) {
          console.error(
            `Error re-executing cell ${cell.index} with filters:`,
            error
          );
        }
      }
    } finally {
      this.sendToRenderer({type: 'loading', loading: false});
    }
  }

  /**
   * Run index queries to fetch available values for dimension specs.
   * Results for unfiltered queries are cached per notebook URI + source.
   */
  private async fetchFilterValues(
    dimensionSpecs: DimensionSpec[],
    documentMeta: DocumentMetadata,
    cancellationToken: vscode.CancellationToken,
    activeFilters: FilterSelection[] = []
  ): Promise<SerializedDimensionValues> {
    const isUnfiltered = activeFilters.length === 0;
    const notebookUri = documentMeta.uri;

    // Check cache for unfiltered queries
    if (isUnfiltered) {
      const cacheKey = `${notebookUri}`;
      const cached = this.indexCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const sourceModelGroups = groupSpecsBySourceModel(dimensionSpecs);
    const mergedValues = new Map<string, Array<{value: unknown; count?: number}>>();

    for (const [key, specs] of sourceModelGroups) {
      const [source] = key.split('|');
      const indexQuery = buildDimensionalIndexQuery(
        source,
        specs,
        10000,
        activeFilters
      );
      if (!indexQuery) continue;

      if (cancellationToken.isCancellationRequested) break;

      try {
        const querySpec: QuerySpec = {
          type: 'string',
          text: indexQuery,
          documentMeta,
        };
        const tokenSource = new vscode.CancellationTokenSource();
        const result = await runMalloyQuery(
          this.context,
          this.worker,
          querySpec,
          `filter-index-${uuid()}`,
          `Filter index query for ${source}`,
          {withWebview: false},
          tokenSource.token
        );
        tokenSource.dispose();

        if (result?.resultJson) {
          const resultData = result.resultJson.queryResult.result;
          const resultStr =
            typeof resultData === 'string'
              ? resultData
              : JSON.stringify(resultData);

          const parsed = parseIndexQueryResult(resultStr, specs);
          for (const [dimKey, values] of parsed.values) {
            mergedValues.set(dimKey, values);
          }
        }
      } catch (error) {
        console.error(`Error fetching index for source ${source}:`, error);
      }
    }

    const serialized = serializeDimensionValues(mergedValues as DimensionValues);

    // Cache unfiltered results
    if (isUnfiltered) {
      this.indexCache.set(`${notebookUri}`, serialized);
    }

    return serialized;
  }

  /**
   * Send a message to the filter renderer.
   */
  private sendToRenderer(message: FilterHostMessage): void {
    if (this.filterMessaging) {
      noAwait(this.filterMessaging.postMessage(message));
    }
  }

  /**
   * Invalidate cached index values for a notebook (e.g. when model changes).
   */
  invalidateCache(notebookUri: string): void {
    this.indexCache.delete(notebookUri);
  }

  /**
   * Clean up state for a notebook.
   */
  disposeNotebook(notebookUri: string): void {
    this.notebooks.delete(notebookUri);
    this.indexCache.delete(notebookUri);
  }

  dispose(): void {
    if (this.reExecuteTimeout) {
      clearTimeout(this.reExecuteTimeout);
    }
    if (this.reExecuteCancellation) {
      this.reExecuteCancellation.cancel();
      this.reExecuteCancellation.dispose();
    }
    this.notebooks.clear();
    this.indexCache.clear();
  }
}
