/**
 * Frames one module of the graph viewer — the camera move behind the focus
 * button in a module's header.
 *
 * A focus moves the viewport and nothing else: Vue Flow fits its view around
 * the module's node and, while the module is open, the items inside it, read
 * from wherever they are now. A module the reader dragged somewhere is
 * followed there rather than snapped back to the layout.
 */

/** How long the camera takes to reach the module. */
export const MODULE_FOCUS_DURATION_MS = 650

/**
 * Room left around the module, as Vue Flow reads a number: the module is
 * fitted as though it were a fifth larger, so it fills about five-sixths of the
 * viewport.
 */
export const MODULE_FOCUS_PADDING = 0.2

/**
 * The closest a focus zooms in.
 *
 * A collapsed module is only its header, small enough that fitting the
 * viewport to it would zoom in as far as the canvas allows. Capped, it comes
 * out a little larger than life; an open module is usually big enough that
 * fitting it never reaches the cap.
 */
export const MODULE_FOCUS_MAX_ZOOM = 1.2

/**
 * The farthest a focus zooms out — the same floor as the viewer's canvas
 * (`:min-zoom` in `GraphViewer.vue`), so even a module larger than the viewport
 * is framed whole.
 */
export const MODULE_FOCUS_MIN_ZOOM = 0.05

/** The `fitView` options a module focus is made with. */
export type ModuleFocusFitViewOptions = {
  /** Ids of the nodes to frame. */
  nodes: string[]
  duration: number
  padding: number
  maxZoom: number
  minZoom: number
}

/** The id the viewer gives a module's node. */
export function getModuleNodeId(moduleName: string): string {
  return `module-${moduleName}`
}

/**
 * The nodes a focus on a module frames: the module's own node first, then
 * every item inside it.
 *
 * A collapsed module has no items on the canvas, so it is framed alone. An
 * open one is framed with its items — the nodes whose `parentNode` is the
 * module's id, matched exactly, so `module-User` never claims the items of
 * `module-UserModule`.
 *
 * A module that is not on the canvas comes back as its own id alone, never as
 * an empty list. Vue Flow reads an empty `nodes` list as every node, which
 * would send the camera out to the whole graph; given an id it cannot find, it
 * frames nothing and leaves the viewport where it was.
 */
export function resolveModuleFocusTargetNodeIds(
  moduleName: string,
  nodes: ReadonlyArray<{ id: string, parentNode?: string }>
): string[] {
  const moduleNodeId = getModuleNodeId(moduleName)
  if (!nodes.some(node => node.id === moduleNodeId)) {
    return [moduleNodeId]
  }

  const itemNodeIds = nodes
    .filter(node => node.parentNode === moduleNodeId)
    .map(node => node.id)

  return [moduleNodeId, ...itemNodeIds]
}

/**
 * The `fitView` options that frame `targetNodeIds`.
 *
 * Each override replaces only its own default, and one left `undefined` keeps
 * it. A `duration` of `0` is an instant jump, honoured rather than mistaken for
 * a missing value.
 */
export function buildModuleFocusFitViewOptions(
  targetNodeIds: readonly string[],
  overrides: Partial<Omit<ModuleFocusFitViewOptions, 'nodes'>> = {}
): ModuleFocusFitViewOptions {
  return {
    nodes: [...targetNodeIds],
    duration: overrides.duration ?? MODULE_FOCUS_DURATION_MS,
    padding: overrides.padding ?? MODULE_FOCUS_PADDING,
    maxZoom: overrides.maxZoom ?? MODULE_FOCUS_MAX_ZOOM,
    minZoom: overrides.minZoom ?? MODULE_FOCUS_MIN_ZOOM
  }
}
