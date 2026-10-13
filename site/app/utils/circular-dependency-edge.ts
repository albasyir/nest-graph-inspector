/**
 * Draws an edge that closes a circular dependency so the loop reads as one.
 *
 * Ordinary routing fails a cycle in three ways. Two nodes that depend on each
 * other are joined by two edges over one pair of handles, which a stepped path
 * draws on top of each other, so the pair reads as a single line. A node that
 * depends on itself has the same node at both ends, which leaves a path
 * between its handles nothing sensible to draw. And in the module deep dive,
 * where a dependency sits left of whatever injects it, the edge closing a
 * cycle runs backwards — out of one node's right side into another's left —
 * and a direct route between those handles crosses both nodes.
 *
 * So a cycle edge is a curve that bows to the left of the way it travels: the
 * two edges of a pair travel opposite ways, so they bow apart, and an edge
 * that has to double back bows far enough to pass beside the nodes rather
 * than through them. A self-loop leaves its node and comes back on the side
 * its handle faces. Each comes with where its label goes: on the curve, or
 * just past a self-loop, so the label never covers the loop it names.
 *
 * Pure geometry over what Vue Flow measured, so both viewers draw cycles alike.
 */

/** A side of a node, named as Vue Flow's `Position` values are. */
export type CircularEdgeSide = 'top' | 'right' | 'bottom' | 'left'

export type CircularEdgePoint = { x: number, y: number }

export type CircularEdgeGeometryInput = {
  sourceX: number
  sourceY: number
  /** The side the source handle sits on — a Vue Flow `Position`. */
  sourcePosition: string
  targetX: number
  targetY: number
  /** The side the target handle sits on — a Vue Flow `Position`. */
  targetPosition: string
  /** Whether the edge starts and ends on the same node. */
  isSelfLoop: boolean
}

export type CircularEdgeGeometry = {
  /** One cubic Bézier segment: start, two control points, end. */
  points: [CircularEdgePoint, CircularEdgePoint, CircularEdgePoint, CircularEdgePoint]
  /** SVG path data for `points`. */
  path: string
  labelX: number
  labelY: number
  /**
   * How the label is placed against (`labelX`, `labelY`), as a CSS transform:
   * centred on a curve, or beside a self-loop with its nearest side touching
   * the point.
   */
  labelTransform: string
  /**
   * The point of the label that sits on (`labelX`, `labelY`), as fractions of
   * its width and height — also the origin it is scaled about.
   */
  labelAnchor: CircularEdgePoint
}

/** A box in flow coordinates. */
export type CircularEdgeRect = { x: number, y: number, width: number, height: number }

/**
 * The most a label is enlarged to stay readable on a zoomed-out canvas: past
 * this it would crowd the graph it labels, so it shrinks with the canvas.
 */
export const CIRCULAR_LABEL_MAX_SCALE = 2.5

const LABEL_HEIGHT = 20
/** Padding, border, warning icon and gap around a label's text. */
const LABEL_CHROME_WIDTH = 31
/** A character of the label's 11px bold tabular text, generously. */
const LABEL_CHARACTER_WIDTH = 7

const OUTWARD: Readonly<Record<CircularEdgeSide, CircularEdgePoint>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 }
}

/**
 * How far out of its node a self-loop's control points sit; the loop itself
 * reaches three-quarters of that.
 */
const SELF_LOOP_REACH = 44
/** Half the gap between where a self-loop leaves its node and comes back. */
const SELF_LOOP_SPREAD = 8
/** How much wider than that gap the loop swells at its far end. */
const SELF_LOOP_SWELL = 14
/** Room between the far end of a self-loop and its label. */
const SELF_LOOP_LABEL_GAP = 4

/** How far an edge whose handles face each other bows: enough to split a pair. */
const FORWARD_BOW = 20
/** How far an edge that doubles back bows, by the distance it spans. */
const BACKWARD_BOW_RATIO = 0.2
const BACKWARD_BOW_MIN = 56
const BACKWARD_BOW_MAX = 160
/** How far a curve holds its handle's direction before it turns. */
const HANDLE_REACH_RATIO = 0.25
const HANDLE_REACH_MIN = 24
const HANDLE_REACH_MAX = 96

const LABEL_TRANSFORM_CENTERED = 'translate(-50%, -50%)'
/** A label beside a self-loop, its nearest side against the loop's far end. */
const LABEL_TRANSFORM_BESIDE: Readonly<Record<CircularEdgeSide, string>> = {
  top: 'translate(-50%, -100%)',
  right: 'translate(0, -50%)',
  bottom: 'translate(-50%, 0)',
  left: 'translate(-100%, -50%)'
}
const LABEL_ANCHOR_CENTERED: CircularEdgePoint = { x: 0.5, y: 0.5 }
const LABEL_ANCHOR_BESIDE: Readonly<Record<CircularEdgeSide, CircularEdgePoint>> = {
  top: { x: 0.5, y: 1 },
  right: { x: 0, y: 0.5 },
  bottom: { x: 0.5, y: 0 },
  left: { x: 1, y: 0.5 }
}

/** How many cycle ids a label lists before it counts the rest. */
const LABEL_MAX_LISTED_IDS = 2

/**
 * The curve a cycle edge is drawn along, and where its label goes.
 *
 * Between two nodes, the curve holds each handle's direction for a while and
 * bows to the left of travel — gently where the handles face each other, by a
 * fifth of the span where the edge doubles back. A self-loop ignores the
 * target handle, which is on the same node: it leaves and re-enters beside the
 * source handle, reaching out on that handle's side.
 */
export function getCircularEdgeGeometry(
  input: CircularEdgeGeometryInput
): CircularEdgeGeometry {
  const source = { x: input.sourceX, y: input.sourceY }
  const sourceSide = toSide(input.sourcePosition)

  if (input.isSelfLoop) {
    return getSelfLoopGeometry(source, sourceSide)
  }

  const target = { x: input.targetX, y: input.targetY }
  const sourceOut = OUTWARD[sourceSide]
  const targetOut = OUTWARD[toSide(input.targetPosition)]
  const travel = subtract(target, source)
  const length = Math.hypot(travel.x, travel.y)
  // Left of the direction of travel, so two opposite edges bow apart.
  const left = length > 0
    ? { x: travel.y / length, y: -travel.x / length }
    : across(sourceOut)
  // Leaving away from the target, or reaching it from behind its handle.
  const doublesBack = dot(travel, sourceOut) < 0 || dot(travel, targetOut) > 0
  const bow = doublesBack
    ? clamp(length * BACKWARD_BOW_RATIO, BACKWARD_BOW_MIN, BACKWARD_BOW_MAX)
    : FORWARD_BOW
  const reach = clamp(length * HANDLE_REACH_RATIO, HANDLE_REACH_MIN, HANDLE_REACH_MAX)
  const points: CircularEdgeGeometry['points'] = [
    source,
    add(add(source, scale(sourceOut, reach)), scale(left, bow)),
    add(add(target, scale(targetOut, reach)), scale(left, bow)),
    target
  ]
  const middle = getMidpoint(points)

  return {
    points,
    path: toPath(points),
    labelX: middle.x,
    labelY: middle.y,
    labelTransform: LABEL_TRANSFORM_CENTERED,
    labelAnchor: LABEL_ANCHOR_CENTERED
  }
}

/**
 * How much a label is enlarged at a zoom, so it reads at no less than its own
 * size however far the canvas is zoomed out — up to `CIRCULAR_LABEL_MAX_SCALE`.
 * Labels live inside the canvas transform, so they shrink with it otherwise.
 */
export function getCircularLabelScale(zoom: number): number {
  if (!(zoom > 0)) {
    return CIRCULAR_LABEL_MAX_SCALE
  }

  return clamp(1 / zoom, 1, CIRCULAR_LABEL_MAX_SCALE)
}

/** The CSS a label is placed with: its anchor on the point, scaled about it. */
export function getCircularLabelPlacement(
  geometry: Pick<CircularEdgeGeometry, 'labelX' | 'labelY' | 'labelTransform' | 'labelAnchor'>,
  scale: number
): { transform: string, transformOrigin: string } {
  return {
    transform: `translate(${geometry.labelX}px, ${geometry.labelY}px) ${geometry.labelTransform} scale(${scale})`,
    transformOrigin: `${geometry.labelAnchor.x * 100}% ${geometry.labelAnchor.y * 100}%`
  }
}

/**
 * The box a label covers, in flow coordinates, for its text at a scale — an
 * estimate on the generous side, for fitting the canvas around it.
 */
export function getCircularLabelBox(
  geometry: Pick<CircularEdgeGeometry, 'labelX' | 'labelY' | 'labelAnchor'>,
  text: string,
  scale = 1
): CircularEdgeRect {
  const width = (LABEL_CHROME_WIDTH + LABEL_CHARACTER_WIDTH * text.length) * scale
  const height = LABEL_HEIGHT * scale

  return {
    x: geometry.labelX - geometry.labelAnchor.x * width,
    y: geometry.labelY - geometry.labelAnchor.y * height,
    width,
    height
  }
}

/**
 * Everything a cycle edge draws: its curve — inside the box of its control
 * points — and, when it has one, its label.
 */
export function getCircularEdgeBounds(
  geometry: CircularEdgeGeometry,
  labelText: string,
  labelScale = 1
): CircularEdgeRect {
  const curve = getPointsBounds(geometry.points)

  const label = labelText
    ? getCircularLabelBox(geometry, labelText, labelScale)
    : null

  return label ? unionRects([curve, label]) ?? curve : curve
}

/** The smallest box holding every box, or `null` for none. */
export function unionRects(rects: readonly CircularEdgeRect[]): CircularEdgeRect | null {
  if (rects.length === 0) {
    return null
  }

  const left = Math.min(...rects.map(rect => rect.x))
  const top = Math.min(...rects.map(rect => rect.y))
  const right = Math.max(...rects.map(rect => rect.x + rect.width))
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height))

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The box around a curve's start, end and control points. A cubic Bézier
 * never leaves the hull of its four points, so this box holds the whole
 * curve — a little more where a control point overshoots the drawn line, which
 * only errs towards showing too much when the canvas is fitted around it.
 */
function getPointsBounds(points: readonly CircularEdgePoint[]): CircularEdgeRect {
  const left = Math.min(...points.map(point => point.x))
  const top = Math.min(...points.map(point => point.y))

  return {
    x: left,
    y: top,
    width: Math.max(...points.map(point => point.x)) - left,
    height: Math.max(...points.map(point => point.y)) - top
  }
}

/**
 * A cycle edge's label: the ids of the cycles it closes, numbered as the
 * issues page and the detail drawer number them — `#3`, `#3 #5`, `#3 #5 +2`.
 */
export function formatCircularEdgeLabel(cycleIds: readonly number[]): string {
  const ids = [...new Set(cycleIds)].sort((left, right) => left - right)
  const listed = ids.slice(0, LABEL_MAX_LISTED_IDS).map(id => `#${id}`)
  const unlisted = ids.length - listed.length

  return unlisted > 0 ? [...listed, `+${unlisted}`].join(' ') : listed.join(' ')
}

/**
 * A loop out of a node and back in on the side its handle faces. It leaves
 * `SELF_LOOP_SPREAD` to one side of the handle and returns as far to the
 * other, its control points `SELF_LOOP_REACH` out and wider apart, so the loop
 * swells as it goes and the arrowhead points back into the node. The label
 * sits `SELF_LOOP_LABEL_GAP` past the loop's farthest point, anchored by its
 * nearest side, so it reads beside the loop rather than over it.
 */
function getSelfLoopGeometry(
  anchor: CircularEdgePoint,
  side: CircularEdgeSide
): CircularEdgeGeometry {
  const out = OUTWARD[side]
  const sideways = across(out)
  const farEnd = add(anchor, scale(out, SELF_LOOP_REACH))
  // Out on one side of the handle and back on the other, so the arrowhead
  // points into the node beside where the loop left it.
  const points: CircularEdgeGeometry['points'] = [
    add(anchor, scale(sideways, -SELF_LOOP_SPREAD)),
    add(farEnd, scale(sideways, -(SELF_LOOP_SPREAD + SELF_LOOP_SWELL))),
    add(farEnd, scale(sideways, SELF_LOOP_SPREAD + SELF_LOOP_SWELL)),
    add(anchor, scale(sideways, SELF_LOOP_SPREAD))
  ]
  const label = add(getMidpoint(points), scale(out, SELF_LOOP_LABEL_GAP))

  return {
    points,
    path: toPath(points),
    labelX: label.x,
    labelY: label.y,
    labelTransform: LABEL_TRANSFORM_BESIDE[side],
    labelAnchor: LABEL_ANCHOR_BESIDE[side]
  }
}

/**
 * The side a Vue Flow `Position` names. Vue Flow only passes one of the four;
 * anything else falls back to `right` rather than leaving the curve with no
 * direction to leave its handle in.
 */
function toSide(position: string): CircularEdgeSide {
  return Object.hasOwn(OUTWARD, position) ? position as CircularEdgeSide : 'right'
}

/** The curve's point halfway along its parameter, where a label sits on it. */
function getMidpoint([start, first, second, end]: CircularEdgeGeometry['points']): CircularEdgePoint {
  return {
    x: (start.x + 3 * first.x + 3 * second.x + end.x) / 8,
    y: (start.y + 3 * first.y + 3 * second.y + end.y) / 8
  }
}

/**
 * SVG path data for one cubic Bézier from the start to the end. The two
 * control points shape it: the curve bends towards them without passing
 * through them.
 */
function toPath([start, first, second, end]: CircularEdgeGeometry['points']): string {
  return `M ${start.x},${start.y} C ${first.x},${first.y} ${second.x},${second.y} ${end.x},${end.y}`
}

/**
 * `left` moved by the offset `right` — how a control point is pushed out from
 * its handle and sideways into a bow.
 */
function add(left: CircularEdgePoint, right: CircularEdgePoint): CircularEdgePoint {
  return { x: left.x + right.x, y: left.y + right.y }
}

/**
 * The offset from `right` to `left` — between two handles, the way an edge
 * travels: `subtract(target, source)`.
 */
function subtract(left: CircularEdgePoint, right: CircularEdgePoint): CircularEdgePoint {
  return { x: left.x - right.x, y: left.y - right.y }
}

/**
 * A direction stretched to a distance — an outward or sideways unit vector
 * times a reach, bow or spread.
 */
function scale(vector: CircularEdgePoint, factor: number): CircularEdgePoint {
  return { x: vector.x * factor, y: vector.y * factor }
}

/**
 * Positive where two directions agree, negative where they oppose — how an
 * edge tells whether it leaves its handle towards its target or doubles back.
 */
function dot(left: CircularEdgePoint, right: CircularEdgePoint): number {
  return left.x * right.x + left.y * right.y
}

/** A quarter turn of a direction. */
function across(vector: CircularEdgePoint): CircularEdgePoint {
  return { x: -vector.y, y: vector.x }
}

/**
 * `value` held within `min`..`max` — the limits every bow, reach and label
 * scale here is kept to.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
