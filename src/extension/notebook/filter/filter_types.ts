import type {
  DimensionSpec,
  FilterSelection,
  DimensionFilterState,
  SerializedDimensionValues,
} from '@malloydata/notebook-filters';

/**
 * Data sent as cell output for the filter renderer to read on mount.
 */
export interface FilterRendererData {
  dimensionSpecs: DimensionSpec[];
  availableValues: SerializedDimensionValues;
  filterState: SerializedFilterState;
}

/**
 * Serialized filter state for transport between extension host and renderer.
 * Map entries are serialized as arrays of [key, value] pairs.
 */
export type SerializedFilterState = Array<
  [string, {selection: FilterSelection | null}]
>;

/**
 * Messages from extension host to renderer.
 */
export type FilterHostMessage =
  | {type: 'updateValues'; values: SerializedDimensionValues}
  | {type: 'updateState'; state: SerializedFilterState}
  | {type: 'loading'; loading: boolean}
  | {type: 'error'; message: string};

/**
 * Messages from renderer to extension host.
 */
export type FilterRendererMessage =
  | {type: 'filterChanged'; key: string; selection: FilterSelection | null}
  | {type: 'clearAll'}
  | {type: 'ready'; notebookUri: string};
