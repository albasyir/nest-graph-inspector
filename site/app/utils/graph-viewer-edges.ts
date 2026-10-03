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
 * `controller-` — and that prefix is all this reads. A cycle outranks
 * everything else, because an edge closing one is a problem whatever it
 * connects; a controller at either end outranks a provider at the other.
 */
export function resolveEdgeRelationship({
  source,
  target,
  isCircular
}: {
  source: string
  target: string
  isCircular?: boolean
}): EdgeRelationship {
  if (isCircular) {
    return 'circular'
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
 * way it points; edges without one are untouched by that toggle.
 */
export function isEdgeNormallyVisible({
  source,
  target,
  isNormallyVisible,
  showControllerLines
}: {
  source: string
  target: string
  isNormallyVisible: boolean
  showControllerLines: boolean
}): boolean {
  return (
    isNormallyVisible
    && (!isControllerEdge(source, target) || showControllerLines)
  )
}

/** The colour an edge of this relationship is drawn in. */
export function getEdgeColor(relationship: EdgeRelationship): string {
  return EDGE_COLOR_BY_RELATIONSHIP[relationship]
}

/** The class an edge of this relationship carries, for styling it by kind. */
export function getEdgeRelationClass(relationship: EdgeRelationship): string {
  return `edge-relation--${relationship}`
}
