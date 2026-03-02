import * as React from 'react';
import {createRoot, Root} from 'react-dom/client';
import type {ActivationFunction} from 'vscode-notebook-renderer';
import {
  FilterBar,
  useDimensionFilters,
  getDimensionKey,
  deserializeDimensionValues,
} from '@malloydata/notebook-filters';
import type {
  DimensionSpec,
  DimensionValues,
  FilterSelection,
  DimensionFilterState,
} from '@malloydata/notebook-filters';
import type {
  FilterRendererData,
  FilterHostMessage,
} from '../filter/filter_types';

const {useState, useEffect, useMemo, useCallback, useRef} = React;

interface FilterBarAdapterProps {
  initialData: FilterRendererData;
  postMessage: (message: unknown) => void;
  onDidReceiveMessage: (callback: (message: unknown) => void) => void;
}

function FilterBarAdapter({
  initialData,
  postMessage,
  onDidReceiveMessage,
}: FilterBarAdapterProps) {
  const {dimensionSpecs} = initialData;

  // Initialize filter state management from shared package
  const {filterStates, updateFilter, clearAllFilters, getActiveFilters} =
    useDimensionFilters({dimensionSpecs});

  // Track available values (updated from extension host)
  const [filterValues, setFilterValues] = useState<DimensionValues>(() =>
    deserializeDimensionValues(initialData.availableValues)
  );

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Listen for messages from extension host
  useEffect(() => {
    onDidReceiveMessage((raw: unknown) => {
      const message = raw as FilterHostMessage;
      switch (message.type) {
        case 'updateValues':
          setFilterValues(deserializeDimensionValues(message.values));
          break;
        case 'loading':
          setIsLoading(message.loading);
          break;
        case 'error':
          setError(message.message);
          break;
      }
    });
  }, [onDidReceiveMessage]);

  // Handle filter change - update local state and notify extension host
  const handleFilterChange = useCallback(
    (key: string, selection: FilterSelection | null) => {
      updateFilter(key, selection);
      postMessage({
        type: 'filterChanged',
        key,
        selection,
      });
    },
    [updateFilter, postMessage]
  );

  // Signal ready to extension host
  const readySent = useRef(false);
  useEffect(() => {
    if (!readySent.current) {
      readySent.current = true;
      postMessage({type: 'ready'});
    }
  }, [postMessage]);

  if (dimensionSpecs.length === 0) {
    return null;
  }

  return (
    <div className="malloy-filter-bar-container">
      {error && (
        <div
          style={{
            color: 'var(--vscode-errorForeground, #f44336)',
            padding: '8px',
            fontSize: '12px',
          }}
        >
          {error}
        </div>
      )}
      <FilterBar
        dimensionSpecs={dimensionSpecs}
        filterStates={filterStates}
        filterValues={filterValues}
        onFilterChange={handleFilterChange}
        retrievalFn={undefined}
        isLoading={isLoading}
      />
    </div>
  );
}

export const activate: ActivationFunction = ({postMessage, onDidReceiveMessage}) => {
  const roots = new Map<string, Root>();

  return {
    renderOutputItem(info, element) {
      const data: FilterRendererData = info.json();

      // Clean up previous root if re-rendering
      const existingRoot = roots.get(element.id);
      if (existingRoot) {
        existingRoot.unmount();
      }

      const container = document.createElement('div');
      container.className = 'malloy-filters-renderer';
      element.replaceChildren(container);

      // Inject basic styles for VS Code theme integration
      const style = document.createElement('style');
      style.textContent = `
        .malloy-filters-renderer {
          font-family: var(--vscode-font-family, sans-serif);
          font-size: var(--vscode-font-size, 13px);
          color: var(--vscode-foreground, #cccccc);
          padding: 8px 0;
        }
        .malloy-filters-renderer .MuiInputBase-root,
        .malloy-filters-renderer .MuiOutlinedInput-root {
          font-size: 13px;
        }
        .malloy-filters-renderer .MuiInputLabel-root {
          font-size: 13px;
        }
        .malloy-filters-renderer .MuiChip-root {
          font-size: 11px;
          height: 24px;
        }
      `;
      element.prepend(style);

      const root = createRoot(container);
      roots.set(element.id, root);

      const wrappedPostMessage = (message: unknown) => {
        postMessage?.(message);
      };

      const wrappedOnDidReceiveMessage = (callback: (message: unknown) => void) => {
        onDidReceiveMessage?.(({message}: {message: unknown}) => {
          callback(message);
        });
      };

      root.render(
        <FilterBarAdapter
          initialData={data}
          postMessage={wrappedPostMessage}
          onDidReceiveMessage={wrappedOnDidReceiveMessage}
        />
      );
    },
    disposeOutputItem(id) {
      if (id === undefined) {
        // All cells being removed - clean up all roots
        for (const root of roots.values()) {
          root.unmount();
        }
        roots.clear();
        return;
      }
      const root = roots.get(id);
      if (root) {
        root.unmount();
        roots.delete(id);
      }
    },
  };
};
