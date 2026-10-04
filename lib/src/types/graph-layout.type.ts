/**
 * A node's position on the viewer canvas, in canvas units.
 */
export type GraphLayoutPosition = {
  x: number;
  y: number;
};

/**
 * Where one module sits on the canvas, and where its items sit inside it.
 */
export type GraphLayoutModule = {
  position: GraphLayoutPosition;

  /** Whether the module is drawn collapsed. Absent means expanded. */
  isCollapsed?: boolean;

  /**
   * Item positions keyed by the viewer's item id. The library treats the keys
   * as opaque; the viewer draws items relative to their module.
   */
  items?: Record<string, GraphLayoutPosition>;
};

/**
 * The arrangement of a graph in the viewer, served at `{path}/layout.json`.
 * Persisted according to `ui.layout.saveAs`: `'file'` (default) saves to
 * `./.muse` relative to `process.cwd()`; `'runtime'` keeps it in memory only,
 * resetting on restart.
 */
export type GraphLayout = {
  $schema?: string;
  version: '1';
  /** Keyed by module class name, as in `GraphOutput.modules`. */
  modules: Record<string, GraphLayoutModule>;
};
