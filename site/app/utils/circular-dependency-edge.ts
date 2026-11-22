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
 * Where the module graph's automatic layout has routed a cycle edge between
 * two modules, the edge is drawn along that route instead, like any other
 * import, and its label goes on the route: `placeRouteLabels` finds it a spot
 * that covers no module and no other label.
 *
 * Pure geometry over what Vue Flow measured, so every viewer draws a cycle's
 * curve alike.
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

/** Where a label sits, and how it is set against that point — as a curve's is. */
export type CircularLabelSpot = Pick<
  CircularEdgeGeometry,
  'labelX' | 'labelY' | 'labelTransform' | 'labelAnchor'
>

/** A label to place on the route its edge is drawn along. */
export type RouteLabelRequest = {
  /** What its placement is returned under: its edge's id. */
  key: string
  /** The route, start to end, in flow coordinates. */
  route: readonly CircularEdgePoint[]
  /** Its text, which sets how wide it is. */
  text: string
}

/** Where a label goes on its route, and how far that spot stays clear. */
export type RouteLabelPlacement = CircularLabelSpot & {
  /**
   * The largest scale the label is drawn at that still clears every obstacle
   * and every label placed before it: `CIRCULAR_LABEL_MAX_SCALE` when it is
   * clear however far the canvas zooms out, a smaller one when it is clear
   * only once the canvas is zoomed in that far, and 0 when no spot on its
   * route is clear at all.
   */
  clearScale: number
}

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
 * The sizes a route label is tried at, largest first: at the largest a label
 * is ever drawn it is clear at every zoom, and a smaller one is the fallback
 * where the route has no room for that.
 */
const ROUTE_LABEL_SCALES = [CIRCULAR_LABEL_MAX_SCALE, 2, 1.5, 1] as const
/** Room kept between a route label and anything it must not cover. */
const ROUTE_LABEL_CLEARANCE = 6
/** How far apart the spots tried along a stretch of route are. */
const ROUTE_LABEL_STEP = 8
/** Half the width a line a label keeps off is taken to have. */
const ROUTE_LINE_HALF_WIDTH = 1.5

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

/**
 * The smallest box holding every box, or `null` for none. One box at a time:
 * a large graph's bracket holds more boxes than a call can take arguments,
 * so they are never spread into one.
 */
export function unionRects(rects: readonly CircularEdgeRect[]): CircularEdgeRect | null {
  if (rects.length === 0) {
    return null
  }

  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }

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
 * Where each label goes on the route its edge is drawn along: centred on the
 * route, on its longest stretch where the label covers no obstacle — a module
 * — and no label placed before it, as near that stretch's middle as it can
 * be. A label is tried at the largest size it is ever drawn first, so it
 * stays clear however far the canvas zooms out, and only where its route has
 * no room for that at a smaller size. At each size it would rather not cover
 * any of `lines` either — the other cycle edges, whose turns a label would
 * hide — and covers one only where no clear spot on its route avoids them all.
 * Labels are placed in the order given, the ones that matter most first; one
 * with no clear spot at all sits in the middle of its route's longest stretch.
 */
export function placeRouteLabels(params: {
  labels: readonly RouteLabelRequest[]
  obstacles: readonly CircularEdgeRect[]
  /** Routes a label had rather not cover; its own, and any just like it, aside. */
  lines?: readonly (readonly CircularEdgePoint[])[]
}): Map<string, RouteLabelPlacement> {
  const taken: CircularEdgeRect[] = [...params.obstacles]
  const placements = new Map<string, RouteLabelPlacement>()
  const lines = (params.lines ?? []).map(line => ({ line, boxes: lineBoxes(line) }))

  for (const { key, route, text } of params.labels) {
    const candidates = routeLabelCandidates(route)
    const [fallback] = candidates
    if (!fallback) {
      continue
    }

    // Only what a label anywhere on this route could cover is worth trying it
    // against — on a large graph, a small part of everything there is.
    const reach = routeLabelReach(route, text)
    const isNear = (box: CircularEdgeRect) => overlaps(box, reach)
    const avoid = lines
      .filter(({ line }) => !isSameRoute(line, route))
      .flatMap(({ boxes }) => boxes.filter(isNear))
    const clear = findClearRouteLabelSpot({ candidates, text, taken: taken.filter(isNear), avoid })
    const point = clear?.point ?? fallback
    // Kept clear of from now on — at the size it was found clear at, or, with
    // no clear spot, at its own size, so labels after it still keep away.
    taken.push(getCircularLabelBox(centredLabelAt(point), text, clear?.scale ?? 1))
    placements.set(key, { ...centredLabelAt(point), clearScale: clear?.scale ?? 0 })
  }

  return placements
}

/**
 * The spots along a route a label may be centred on, best first: the longest
 * stretch before the shorter ones, and along each, its middle first and then
 * every `ROUTE_LABEL_STEP` towards its ends, alternately one way and the
 * other. A route with no length offers only its one point.
 */
function routeLabelCandidates(route: readonly CircularEdgePoint[]): CircularEdgePoint[] {
  const stretches = route
    .slice(1)
    .map((end, index) => {
      const start = route[index] ?? end
      return { start, end, length: Math.hypot(end.x - start.x, end.y - start.y) }
    })
    .filter(stretch => stretch.length > 0)
    .sort((left, right) => right.length - left.length)

  const candidates = stretches.flatMap(({ start, end, length }) => {
    const along = [0]
    for (let offset = ROUTE_LABEL_STEP; offset <= length / 2; offset += ROUTE_LABEL_STEP) {
      along.push(offset, -offset)
    }

    return along.map((offset) => {
      const t = 0.5 + offset / length
      return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
    })
  })
  const [first] = route

  return candidates.length > 0 || !first ? candidates : [first]
}

/**
 * The first candidate a label is clear of everything `taken` at, at the
 * largest scale any is — every candidate is tried at one scale before any is
 * tried at the next — and, at that scale, one that also covers nothing it was
 * asked to `avoid` where there is such a candidate.
 */
function findClearRouteLabelSpot(params: {
  candidates: readonly CircularEdgePoint[]
  text: string
  taken: readonly CircularEdgeRect[]
  avoid: readonly CircularEdgeRect[]
}): { point: CircularEdgePoint, scale: number } | undefined {
  const { candidates, text, taken, avoid } = params
  const preferences = avoid.length > 0 ? [[...taken, ...avoid], taken] : [taken]
  for (const scale of ROUTE_LABEL_SCALES) {
    for (const blocked of preferences) {
      for (const point of candidates) {
        const box = grow(getCircularLabelBox(centredLabelAt(point), text, scale), ROUTE_LABEL_CLEARANCE)
        if (!blocked.some(other => overlaps(box, other))) {
          return { point, scale }
        }
      }
    }
  }

  return undefined
}

/**
 * The box every spot a label could take on `route` stays inside: the route's
 * own box, grown by half the label at its largest and the clearance it keeps.
 */
function routeLabelReach(
  route: readonly CircularEdgePoint[],
  text: string
): CircularEdgeRect {
  const largest = getCircularLabelBox(centredLabelAt({ x: 0, y: 0 }), text, CIRCULAR_LABEL_MAX_SCALE)
  const left = Math.min(...route.map(point => point.x))
  const top = Math.min(...route.map(point => point.y))

  return grow({
    x: left - largest.width / 2,
    y: top - largest.height / 2,
    width: Math.max(...route.map(point => point.x)) - left + largest.width,
    height: Math.max(...route.map(point => point.y)) - top + largest.height
  }, ROUTE_LABEL_CLEARANCE)
}

/** Each straight stretch of a line, as the thin box its stroke covers. */
function lineBoxes(line: readonly CircularEdgePoint[]): CircularEdgeRect[] {
  return line.slice(1).flatMap((end, index) => {
    const start = line[index]
    return start
      ? [grow({
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y)
        }, ROUTE_LINE_HALF_WIDTH)]
      : []
  })
}

/** Whether two routes run through the same points, in the same order. */
function isSameRoute(
  left: readonly CircularEdgePoint[],
  right: readonly CircularEdgePoint[]
): boolean {
  return left.length === right.length
    && left.every((point, index) => {
      const other = right[index]
      return other !== undefined && point.x === other.x && point.y === other.y
    })
}

/** A label centred on a point, as a curve's label is on its midpoint. */
function centredLabelAt(point: CircularEdgePoint): CircularLabelSpot {
  return {
    labelX: point.x,
    labelY: point.y,
    labelTransform: LABEL_TRANSFORM_CENTERED,
    labelAnchor: LABEL_ANCHOR_CENTERED
  }
}

/** A box with `by` more room on every side. */
function grow(rect: CircularEdgeRect, by: number): CircularEdgeRect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2
  }
}

/** Whether two boxes share any area — touching edges do not count. */
function overlaps(left: CircularEdgeRect, right: CircularEdgeRect): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height
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
