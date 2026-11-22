import type {
  BracketLevelNode,
  BracketModuleNode,
  BracketNode,
  BracketSide,
  BracketSize,
  BracketStubNode,
  ModuleDependencyBracket
} from './module-dependency-bracket.ts'

/**
 * Where the canvas looks into a bracket: Vue Flow's viewport transform. A
 * point at `p` in flow coordinates is drawn at `p * zoom + (x, y)` on screen.
 */
export type BracketViewport = { x: number, y: number, zoom: number }

/** The canvas a bracket is drawn on, in screen pixels. */
export type BracketCanvas = {
  width: number
  height: number
  /** How much of its top the pinned level headings cover. */
  top: number
}

/**
 * The smallest zoom a bracket opens at, for each size of bracket: at it the
 * module names are drawn readable — a regular bracket's 14px names at 12.6px,
 * a compact one's 11.5px names at 11px. A bracket that only fits smaller
 * opens on its module at this zoom instead, the rest a pan away.
 */
export const READABLE_ZOOM: Readonly<Record<BracketSize, number>> = {
  regular: 0.9,
  compact: 0.96
}
/** A bracket small enough to fit is not enlarged past its own size. */
export const FRAME_MAX_ZOOM = 1
/** Room left between the canvas edge and a bracket framed whole, or a column panned to. */
export const FRAME_PADDING = 24
/**
 * Room left either side of a compact bracket's first levels, framed across a
 * phone: enough that no card touches the canvas edge, and no more — the
 * width is what keeps their names readable.
 */
export const FIRST_LEVELS_INSET = 4
/** A card this far past an edge of the view still counts as in it: rounding, not hiding. */
const EDGE_TOLERANCE = 1

/**
 * The frame a bracket opens at. All of it, centred, when it fits at a zoom
 * its names read at — never enlarged past its own size. Otherwise a compact
 * bracket opens on its module and the first level of each side across the
 * canvas (`frameFirstLevels`), and a regular one on its module, centred, at
 * its `READABLE_ZOOM`; the canvas then holds as much of the bracket as it can,
 * so a side with less to show never leaves part of the canvas empty while the
 * other side runs off it.
 */
export function getBracketFrame(bracket: ModuleDependencyBracket, canvas: BracketCanvas): BracketViewport {
  const { bounds } = bracket
  const room = getRoom(canvas)
  const readableZoom = READABLE_ZOOM[bracket.size]
  const fitZoom = Math.min(room.width / bounds.width, room.height / bounds.height)

  if (fitZoom >= readableZoom) {
    const zoom = Math.min(fitZoom, FRAME_MAX_ZOOM)
    return centreOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, zoom, canvas)
  }

  if (bracket.size === 'compact') {
    return frameFirstLevels(bracket, canvas)
  }

  const zoom = readableZoom
  const center = bracket.nodes.find(node => node.kind === 'center')
  const middle = center
    ? { x: center.position.x + center.width / 2, y: center.position.y + center.height / 2 }
    : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const frame = centreOn(middle.x, middle.y, zoom, canvas)
  const x = keepContentAcross(frame.x, bounds.x, bounds.x + bounds.width, zoom, FRAME_PADDING, canvas.width - FRAME_PADDING)

  return {
    x: center ? showNearlyWholeSide(x, bounds, center, zoom, canvas) : x,
    y: keepContentAcross(frame.y, bounds.y, bounds.y + bounds.height, zoom, canvas.top + FRAME_PADDING, canvas.height - FRAME_PADDING),
    zoom
  }
}

/**
 * A compact bracket's opening frame: the module and the first level of each
 * side — or the empty card standing in for one — across the canvas, as large
 * as that fits, never larger than itself and never smaller than its names
 * read at (a canvas too narrow for that cuts the first levels at its edges,
 * the module still in the middle). Down the canvas, all of the first levels
 * when they fit, else the module in the middle.
 */
function frameFirstLevels(bracket: ModuleDependencyBracket, canvas: BracketCanvas): BracketViewport {
  const { bounds } = bracket
  const first = bracket.nodes.filter(node => node.kind === 'center'
    || node.kind === 'empty'
    || (node.kind === 'module' && node.level === 1))
  const left = minLeft(first)
  const right = maxRight(first)
  const top = Math.min(...first.map(node => node.position.y))
  const bottom = Math.max(...first.map(node => node.position.y + node.height))
  const acrossZoom = (canvas.width - FIRST_LEVELS_INSET * 2) / (right - left)
  const zoom = Math.max(READABLE_ZOOM.compact, Math.min(FRAME_MAX_ZOOM, acrossZoom))

  const center = bracket.nodes.find(node => node.kind === 'center')
  const middle = (bottom - top) * zoom <= getRoom(canvas).height || !center
    ? (top + bottom) / 2
    : center.position.y + center.height / 2
  const frame = centreOn((left + right) / 2, middle, zoom, canvas)
  return {
    x: frame.x,
    y: keepContentAcross(frame.y, bounds.y, bounds.y + bounds.height, zoom, canvas.top + FRAME_PADDING, canvas.height - FRAME_PADDING),
    zoom
  }
}

/** How much of the canvas width a frame moves off its module to show a side whole. */
const NEARLY_WHOLE_SHARE = 0.15

/**
 * With both sides cut off by the canvas, one that runs only a little past
 * its edge is shown whole instead — the module kept wholly in view — so the
 * frame does not open on a sliver of cut cards. A side running far past its
 * edge stays a pan away, and the module stays in the middle.
 */
function showNearlyWholeSide(
  x: number,
  bounds: ModuleDependencyBracket['bounds'],
  center: BracketNode,
  zoom: number,
  canvas: BracketCanvas
): number {
  const cutLeft = FRAME_PADDING - (bounds.x * zoom + x)
  const cutRight = (bounds.x + bounds.width) * zoom + x - (canvas.width - FRAME_PADDING)
  if (cutLeft <= 0 || cutRight <= 0) {
    return x
  }

  const limit = canvas.width * NEARLY_WHOLE_SHARE
  const shift = cutLeft <= cutRight ? cutLeft : -cutRight
  if (Math.abs(shift) > limit) {
    return x
  }

  const centerLeft = center.position.x * zoom + x + shift
  const centerRight = (center.position.x + center.width) * zoom + x + shift
  return centerLeft >= FRAME_PADDING && centerRight <= canvas.width - FRAME_PADDING ? x + shift : x
}

/**
 * What a view leaves out: past each side's own outer edge, the levels of that
 * side it cuts off; the module in the middle, when an edge cuts it off; and
 * the modules above or below the view.
 */
export type BracketOffscreen = {
  /**
   * Levels of each side with a module cut off by that side's own edge of the
   * canvas — the left edge for what the module needs, the right for what
   * needs it — nearest the middle first. A level cut off by the other edge
   * lies back towards the middle, past `middle`.
   */
  levels: Record<BracketSide, number[]>
  /**
   * How many modules those levels of each side hold — the modules drawn there,
   * and those past a stub there, each once — what a chip toward them counts.
   */
  modules: Record<BracketSide, number>
  /** The edge of the canvas the module in the middle is cut off by, if one is. */
  middle: BracketSide | null
  /** Modules in the columns in view whose middle is above the view, or below it. */
  above: number
  below: number
}

export function getBracketOffscreen(
  bracket: ModuleDependencyBracket,
  viewport: BracketViewport,
  canvas: BracketCanvas
): BracketOffscreen {
  const view = getView(viewport, canvas)
  const levels: Record<BracketSide, Set<number>> = { left: new Set(), right: new Set() }
  const drawn: Record<BracketSide, number> = { left: 0, right: 0 }
  const pastStubs: Record<BracketSide, Set<string>> = { left: new Set(), right: new Set() }
  const pastLeft = (node: BracketNode) => node.position.x < view.left - EDGE_TOLERANCE
  const pastRight = (node: BracketNode) => node.position.x + node.width > view.right + EDGE_TOLERANCE
  let middle: BracketSide | null = null
  let above = 0
  let below = 0

  for (const node of bracket.nodes) {
    if (node.kind === 'center') {
      // Cut off by both edges, the module fills the view: nothing to go back to.
      middle = pastLeft(node) === pastRight(node) ? null : pastLeft(node) ? 'left' : 'right'
      continue
    }
    if (node.kind === 'stub') {
      // One more level that way, its modules counted once however many stubs
      // name them.
      if (node.side === 'left' ? pastLeft(node) : pastRight(node)) {
        levels[node.side].add(node.level)
        for (const moduleName of node.moduleNames) {
          pastStubs[node.side].add(moduleName)
        }
      }
      continue
    }
    if (node.kind !== 'module') {
      continue
    }

    const isOutward = node.side === 'left' ? pastLeft(node) : pastRight(node)
    if (isOutward) {
      levels[node.side].add(node.level)
      drawn[node.side] += 1
      continue
    }
    if (pastLeft(node) || pastRight(node)) {
      continue
    }

    const height = node.position.y + node.height / 2
    if (height < view.top) {
      above += 1
    } else if (height > view.bottom) {
      below += 1
    }
  }

  const ascending = (side: BracketSide) => [...levels[side]].sort((first, second) => first - second)
  return {
    levels: { left: ascending('left'), right: ascending('right') },
    modules: { left: drawn.left + pastStubs.left.size, right: drawn.right + pastStubs.right.size },
    middle,
    above,
    below
  }
}

/**
 * The cards — modules and stubs — an edge of the canvas cuts through: partly
 * in view, partly past the left or right edge. The page draws them back, as
 * the levels a chip at that edge names.
 */
export function getCutCardIds(
  bracket: ModuleDependencyBracket,
  viewport: BracketViewport,
  canvas: BracketCanvas
): Set<string> {
  const view = getView(viewport, canvas)
  return new Set(bracket.nodes
    .filter(node => node.kind === 'module' || node.kind === 'stub')
    .filter((node) => {
      const left = node.position.x
      const right = node.position.x + node.width
      const isPartlyInView = right > view.left && left < view.right
      const isCut = left < view.left - EDGE_TOLERANCE || right > view.right + EDGE_TOLERANCE
      return isPartlyInView && isCut
    })
    .map(node => node.id))
}

/**
 * Where to look to see the levels of `side` the view cuts off: the nearest
 * one wholly in view, and as many further out with it as the canvas holds,
 * the furthest of them against the canvas edge. Stubs ending the last of
 * them come with it, and a column of stubs cut off is a level like any
 * other. The zoom stays; the view moves up or down only if none of those
 * levels' cards would be in it.
 */
export function getLevelRevealViewport(
  bracket: ModuleDependencyBracket,
  viewport: BracketViewport,
  canvas: BracketCanvas,
  side: BracketSide
): BracketViewport {
  const hidden = getBracketOffscreen(bracket, viewport, canvas).levels[side]
  const { zoom } = viewport
  const room = getRoom(canvas)
  const columns = hidden
    .map((level): { level: number, cards: BracketNode[] } => ({
      level,
      cards: [...getColumnCards(bracket, side, level), ...getStubCards(bracket, side, level)]
    }))
    .filter(column => column.cards.length > 0)
  const nearest = columns[0]
  if (!nearest) {
    return viewport
  }

  // Outward from the nearest hidden level, as far as fits beside it.
  const innerEdge = side === 'left' ? maxRight(nearest.cards) : minLeft(nearest.cards)
  let shown = [nearest]
  for (const column of columns.slice(1)) {
    const outerEdge = side === 'left' ? minLeft(column.cards) : maxRight(column.cards)
    if (Math.abs(innerEdge - outerEdge) * zoom > room.width) {
      break
    }
    shown = [...shown, column]
  }

  const furthest = shown[shown.length - 1] ?? nearest
  const isLastLevel = furthest.level === Math.max(...hidden)
  const stubs = isLastLevel ? getStubCards(bracket, side, furthest.level + 1) : []
  const furthestCards = [...furthest.cards, ...stubs]
  const fitsWithStubs = Math.abs(innerEdge - (side === 'left' ? minLeft(furthestCards) : maxRight(furthestCards))) * zoom <= room.width
  const outerCards = fitsWithStubs ? furthestCards : furthest.cards
  const x = side === 'left'
    ? FRAME_PADDING - minLeft(outerCards) * zoom
    : canvas.width - FRAME_PADDING - maxRight(outerCards) * zoom

  const cards = shown.flatMap(column => column.cards)
  const top = Math.min(...cards.map(card => card.position.y))
  const bottom = Math.max(...cards.map(card => card.position.y + card.height))
  const view = getView({ ...viewport, x }, canvas)
  const isAnyInView = cards.some(card =>
    card.position.y + card.height > view.top && card.position.y < view.bottom)
  if (isAnyInView) {
    return { x, y: viewport.y, zoom }
  }

  const y = (bottom - top) * zoom <= room.height
    ? centreOn(0, (top + bottom) / 2, zoom, canvas).y
    : canvas.top + FRAME_PADDING - top * zoom
  return { x, y, zoom }
}

/**
 * Where to look to see the modules above the view (`up`) or below it: most
 * of a canvas further that way, never past the bracket's own edge.
 */
export function getVerticalRevealViewport(
  bracket: ModuleDependencyBracket,
  viewport: BracketViewport,
  canvas: BracketCanvas,
  direction: 'up' | 'down'
): BracketViewport {
  const { bounds } = bracket
  const { zoom } = viewport
  const step = getRoom(canvas).height * 0.75
  const highest = canvas.top + FRAME_PADDING - bounds.y * zoom
  const lowest = canvas.height - FRAME_PADDING - (bounds.y + bounds.height) * zoom
  const y = direction === 'up'
    ? Math.min(viewport.y + step, Math.max(highest, viewport.y))
    : Math.max(viewport.y - step, Math.min(lowest, viewport.y))
  return { x: viewport.x, y, zoom }
}

/** A column's heading where the canvas draws it: across the top, over its column. */
export type BracketLevelHeader = {
  id: string
  side: BracketSide
  level: number
  moduleCount: number
  /** Screen x of the column's left edge, and its width on screen. */
  left: number
  width: number
}

/** How far inside the canvas edges a heading keeps, and the least of a column worth heading. */
const HEADING_INSET = 8
const HEADING_MIN_WIDTH = 72

/**
 * The headings of the columns in view, where they stand on screen: over the
 * part of each column the canvas shows, kept inside its edges, so a heading
 * is never cut mid-word by the edge. A column showing too little of itself
 * for a heading goes without one.
 */
export function getBracketLevelHeaders(
  bracket: ModuleDependencyBracket,
  viewport: BracketViewport,
  canvas: BracketCanvas
): BracketLevelHeader[] {
  return bracket.nodes
    .filter((node): node is BracketLevelNode => node.kind === 'level')
    .map((node) => {
      const start = node.position.x * viewport.zoom + viewport.x
      const left = Math.max(start, HEADING_INSET)
      const right = Math.min(start + node.width * viewport.zoom, canvas.width - HEADING_INSET)
      return {
        id: node.id,
        side: node.side,
        level: node.level,
        moduleCount: node.moduleCount,
        left,
        width: right - left
      }
    })
    .filter(header => header.width >= HEADING_MIN_WIDTH)
}

/** The level range a chip names: "Level 3", or "Levels 2–4". */
export function formatLevelRange(levels: readonly number[]): string {
  const first = levels[0]
  const last = levels[levels.length - 1]
  if (first === undefined || last === undefined) {
    return ''
  }

  return first === last ? `Level ${first}` : `Levels ${first}–${last}`
}

function getRoom(canvas: BracketCanvas): { width: number, height: number } {
  return {
    width: Math.max(1, canvas.width - FRAME_PADDING * 2),
    height: Math.max(1, canvas.height - canvas.top - FRAME_PADDING * 2)
  }
}

/** The part of the bracket in view, in flow coordinates, below the pinned headings. */
function getView(viewport: BracketViewport, canvas: BracketCanvas) {
  return {
    left: -viewport.x / viewport.zoom,
    right: (canvas.width - viewport.x) / viewport.zoom,
    top: (canvas.top - viewport.y) / viewport.zoom,
    bottom: (canvas.height - viewport.y) / viewport.zoom
  }
}

/** The viewport putting a flow point in the middle of the canvas below its headings. */
function centreOn(x: number, y: number, zoom: number, canvas: BracketCanvas): BracketViewport {
  return {
    x: canvas.width / 2 - x * zoom,
    y: canvas.top + (canvas.height - canvas.top) / 2 - y * zoom,
    zoom
  }
}

/**
 * An offset along one axis moved, if need be, so content wider than the room
 * between `start` and `end` covers all of it: no empty canvas on one side
 * while the content runs off the other. Content that fits keeps its offset.
 */
function keepContentAcross(
  offset: number,
  contentStart: number,
  contentEnd: number,
  zoom: number,
  start: number,
  end: number
): number {
  if ((contentEnd - contentStart) * zoom <= end - start) {
    return offset
  }

  const mostForward = start - contentStart * zoom
  const mostBack = end - contentEnd * zoom
  return Math.min(mostForward, Math.max(mostBack, offset))
}

function getColumnCards(bracket: ModuleDependencyBracket, side: BracketSide, level: number): BracketModuleNode[] {
  return bracket.nodes.filter((node): node is BracketModuleNode =>
    node.kind === 'module' && node.side === side && node.level === level)
}

function getStubCards(bracket: ModuleDependencyBracket, side: BracketSide, level: number): BracketStubNode[] {
  return bracket.nodes.filter((node): node is BracketStubNode =>
    node.kind === 'stub' && node.side === side && node.level === level)
}

function minLeft(cards: readonly BracketNode[]): number {
  return Math.min(...cards.map(card => card.position.x))
}

function maxRight(cards: readonly BracketNode[]): number {
  return Math.max(...cards.map(card => card.position.x + card.width))
}
