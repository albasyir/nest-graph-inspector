/**
 * Colours the graph viewer's edges by the relationship they draw.
 *
 * Four kinds of line meet in the viewer — a module importing another, a
 * provider injected into a provider, a dependency of a controller, and any of
 * those closing a cycle — and each gets its own colour, so a dense graph can be
 * read by hue instead of by tracing every line to its end.
 *
 * The colours are CSS custom properties rather than literals: the viewer's
 * light and dark themes each define shades that hold up under their own blend
 * mode. The literal after the comma is only a fallback for a page that never
 * defines the property.
 *
 * A collapsed module hides its providers and controllers, so a dependency
 * reaching into one is redrawn onto the module node. `placeDependencyEdge`
 * decides where, and keeps what the redrawn edge stands for, so it is still
 * coloured, toggled and flagged as a cycle like the edges it replaces.
 */

/** What an edge connects, which decides how it is drawn. */
export type EdgeRelationship = 'module' | 'provider' | 'controller' | 'circular'

/** A module importing another. */
export const MODULE_EDGE_COLOR = 'var(--mg-edge-module, #38bdf8)'
/** A provider injected into another provider, inside a module or across one. */
export const PROVIDER_EDGE_COLOR = 'var(--mg-edge-provider, #34d399)'
/** A dependency of a controller. */
export const CONTROLLER_EDGE_COLOR = 'var(--mg-edge-controller, #c084fc)'
/** Any edge that closes a circular dependency, whatever it connects. */
export const CIRCULAR_DEPENDENCY_EDGE_COLOR = 'var(--mg-edge-circular, #facc15)'

const EDGE_COLOR_BY_RELATIONSHIP: Readonly<Record<EdgeRelationship, string>> = {
  module: MODULE_EDGE_COLOR,
  provider: PROVIDER_EDGE_COLOR,
  controller: CONTROLLER_EDGE_COLOR,
  circular: CIRCULAR_DEPENDENCY_EDGE_COLOR
}

/**
 * Says what an edge between two graph nodes represents.
 *
 * Node ids carry their kind as a prefix — `module-`, `provider-`,
 * `controller-` — and that prefix is enough for most edges. One drawn between
 * nodes that stand in for its real ends names its `relationship` instead: a
 * provider dependency between two collapsed modules runs from one module node
 * to the other, but it is a provider edge, not an import. A cycle outranks
 * everything else, a named `relationship` included, because an edge closing
 * one is a problem whatever it connects; a controller at either end outranks a
 * provider at the other.
 */
export function resolveEdgeRelationship({
  source,
  target,
  isCircular,
  relationship
}: {
  source: string
  target: string
  isCircular?: boolean
  relationship?: EdgeRelationship
}): EdgeRelationship {
  if (isCircular) {
    return 'circular'
  }

  if (relationship) {
    return relationship
  }

  if (source.startsWith('module-') && target.startsWith('module-')) {
    return 'module'
  }

  if (isControllerEdge(source, target)) {
    return 'controller'
  }

  return 'provider'
}

/**
 * Whether an edge has a controller at either end.
 *
 * Dependency edges point from what is injected to what receives it, so a
 * controller is normally the target; the source counts too, because a
 * dependency can resolve to a controller's node.
 */
export function isControllerEdge(source: string, target: string): boolean {
  return source.startsWith('controller-') || target.startsWith('controller-')
}

/**
 * Whether an edge is drawn while no bright line is lit.
 *
 * `isNormallyVisible` is what the toggle governing the edge says. An edge with
 * a controller at either end must also pass "Show controller lines", whichever
 * way it points. So must one that names `relationship: 'controller'`, such as
 * a controller's dependency drawn onto the collapsed module hiding it; naming
 * any other relationship never exempts an edge with a controller end. Edges
 * with neither are untouched by that toggle.
 */
export function isEdgeNormallyVisible({
  source,
  target,
  isNormallyVisible,
  showControllerLines,
  relationship
}: {
  source: string
  target: string
  isNormallyVisible: boolean
  showControllerLines: boolean
  relationship?: EdgeRelationship
}): boolean {
  const isControllerLine
    = relationship === 'controller' || isControllerEdge(source, target)

  return isNormallyVisible && (!isControllerLine || showControllerLines)
}

/** The colour an edge of this relationship is drawn in. */
export function getEdgeColor(relationship: EdgeRelationship): string {
  return EDGE_COLOR_BY_RELATIONSHIP[relationship]
}

/** The class an edge of this relationship carries, for styling it by kind. */
export function getEdgeRelationClass(relationship: EdgeRelationship): string {
  return `edge-relation--${relationship}`
}

/** A dependency redrawn onto the collapsed module hiding one of its ends. */
export type RedirectedDependencyEdge = {
  type: 'redirected'
  /** The source item, or the collapsed module standing in for it. */
  source: string
  /** The target item, or the collapsed module standing in for it. */
  target: string
  /** What depends, read from the target's id before a module replaced it. */
  relationship: 'provider' | 'controller'
  /** Shared by every dependency drawn as this same edge. */
  key: string
  id: string
  /** Both ends are modules, so it runs where the import between them does. */
  isBetweenModules: boolean
  /** The item-to-item edge it stands for, where its cycles are recorded. */
  itemEdgeKey: string
}

/** How a dependency between two items is drawn. */
export type DependencyEdgePlacement
  = | { type: 'hidden' }
    | { type: 'direct', isInsideModule: boolean }
    | RedirectedDependencyEdge

/**
 * How a dependency between two items is drawn, given which of their modules
 * are collapsed.
 *
 * A collapsed module hides its items, so a dependency inside one has nothing
 * to be drawn between, and one crossing into or out of one is redrawn onto the
 * module node. The redrawn edge keeps what depends as its `relationship`, so a
 * controller's dependency stays a controller edge, and dependencies redrawn
 * onto the same ends for the same kind of dependent share one `key` — they are
 * drawn as one edge. Each remembers the item edge it stands for, because a
 * cycle is recorded under that edge's key, not under the ends drawn instead.
 */
export function placeDependencyEdge({
  source,
  target,
  sourceModule,
  targetModule,
  isSourceModuleCollapsed,
  isTargetModuleCollapsed
}: {
  source: string
  target: string
  sourceModule: string
  targetModule: string
  isSourceModuleCollapsed: boolean
  isTargetModuleCollapsed: boolean
}): DependencyEdgePlacement {
  if (sourceModule === targetModule) {
    return isTargetModuleCollapsed
      ? { type: 'hidden' }
      : { type: 'direct', isInsideModule: true }
  }

  if (!isSourceModuleCollapsed && !isTargetModuleCollapsed) {
    return { type: 'direct', isInsideModule: false }
  }

  const drawnSource = isSourceModuleCollapsed
    ? `module-${sourceModule}`
    : source
  const drawnTarget = isTargetModuleCollapsed
    ? `module-${targetModule}`
    : target
  const relationship = target.startsWith('controller-')
    ? 'controller'
    : 'provider'
  const isBetweenModules = isSourceModuleCollapsed && isTargetModuleCollapsed

  return {
    type: 'redirected',
    source: drawnSource,
    target: drawnTarget,
    relationship,
    key: `${drawnSource}->${drawnTarget}:${relationship}`,
    id: isBetweenModules
      ? `e-agg-dep-${drawnSource}->${drawnTarget}-${relationship}`
      : `e-dep-${drawnSource}->${drawnTarget}-${relationship}`,
    isBetweenModules,
    itemEdgeKey: `${source}->${target}`
  }
}

/**
 * The cycles an edge closes, gathered from the item edges it stands for.
 *
 * An edge between two items closes the cycles recorded under its own key. One
 * redrawn onto a collapsed module stands for every item edge it replaced and
 * closes all of their cycles, so a cycle stays flagged while the items closing
 * it are hidden. Each cycle comes back once, however many of them it runs
 * through.
 */
export function collectCircularEdgeInfo<Info extends { id: number }>(
  itemEdgeKeys: readonly string[],
  circularEdges: ReadonlyMap<string, readonly Info[]>
): Info[] {
  const infoById = new Map<number, Info>()
  for (const itemEdgeKey of itemEdgeKeys) {
    for (const info of circularEdges.get(itemEdgeKey) ?? []) {
      infoById.set(info.id, info)
    }
  }

  return Array.from(infoById.values())
}
