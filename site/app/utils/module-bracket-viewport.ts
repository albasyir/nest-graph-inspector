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

/** A box on the canvas, in screen pixels from its top-left corner. */
export type CanvasBox = { x: number, y: number, width: number, height: number }

/** The canvas a bracket is drawn on, in screen pixels. */
export type BracketCanvas = {
  width: number
  height: number
  /** How much of its top the pinned level headings cover. */
  top: number
  /**
   * How far down it the chips toward what a frame leaves out reach, for a
   * host that asks every card the bracket opens on to stand clear of them: a
   * frame on a compact bracket's first levels then hangs them just below.
   */
  chipsBottom?: number
  /**
   * Controls drawn over the canvas — its zoom buttons — for a host that asks
   * every card a frame draws to stand clear of them: the frame then moves as
   * little as it can to leave them clear.
   */
  controls?: readonly CanvasBox[]
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
/** Room kept between a card and a chip or a control drawn over the canvas. */
export const OVERLAY_GAP = 4
/**
 * How far above its card a compact module's marks — Root, its twin on a
 * cycle — ride, as the stylesheet sets them: half their 18px, over the edge.
 */
export const COMPACT_MARKS_OVERHANG = 9
/** A card this far past an edge of the view still counts as in it: rounding, not hiding. */
const EDGE_TOLERANCE = 1

/**
 * How a bracket opens on its canvas.
 *
 * - `focus` — a module's page: all of it when it fits at a zoom its names
 *   read at, otherwise on its module, the rest a chip away.
 * - `whole` — a demo showing what a change reaches: all of it, every card
 *   and stub, wherever it fits at a zoom its names read at, at either size
 *   (`pickWholeFrameBracket`); where it fits at neither, as `focus`, compact.
 */
export type BracketFraming = 'focus' | 'whole'

/** Room left between the canvas edges and a bracket framed whole. */
export const WHOLE_FRAME_PADDING = 16

/**
 * The largest zoom a whole frame draws at. A regular bracket keeps to its own
 * size; a compact one may grow to 1.2 — its 11.5px names to 13.8px, short of
 * a regular bracket's own 14px.
 */
export const WHOLE_FRAME_MAX_ZOOM: Readonly<Record<BracketSize, number>> = {
  regular: FRAME_MAX_ZOOM,
  compact: 1.2
}

/**
 * The zoom a bracket fits whole at: what it draws filling the canvas below
 * its pinned headings, `WHOLE_FRAME_PADDING` clear of every edge.
 */
function getWholeFitZoom(bracket: ModuleDependencyBracket, canvas: BracketCanvas): number {
  const { drawnBounds } = bracket
  const width = Math.max(1, canvas.width - WHOLE_FRAME_PADDING * 2)
  const height = Math.max(1, canvas.height - canvas.top - WHOLE_FRAME_PADDING * 2)
  return Math.min(width / drawnBounds.width, height / drawnBounds.height)
}

/**
 * Whether a bracket framed whole on `canvas` draws its module names at a
 * size to read: at its `READABLE_ZOOM` or more — 11px or more for a compact
 * bracket's names, 12.6px or more for a regular one's.
 */
export function fitsWhole(bracket: ModuleDependencyBracket, canvas: BracketCanvas): boolean {
  return getWholeFitZoom(bracket, canvas) >= READABLE_ZOOM[bracket.size]
}

/**
 * Of one bracket laid out at each size, the one a host that frames it whole
 * draws on `canvas`: the first, in the order given — the regular one before
 * the compact one — that fits whole at a zoom its names read at, and where
 * none does — a canvas not yet measured included — the last, the compact
 * one, to open in focus on its first levels. A canvas framed whole is a
 * column or a panel of a page, never as wide as a regular bracket's first
 * levels; a compact one's fit across it at a size their names read at.
 * `null` only when there is no bracket to draw.
 */
export function pickWholeFrameBracket(
  brackets: readonly ModuleDependencyBracket[],
  canvas: BracketCanvas
): ModuleDependencyBracket | null {
  return brackets.find(bracket => fitsWhole(bracket, canvas)) ?? brackets.at(-1) ?? null
}

/**
 * The frame a bracket opens at.
 *
 * Framed `whole` where it fits whole at a zoom its names read at: everything
 * drawn, centred below the pinned headings, as large as fits up to
 * `WHOLE_FRAME_MAX_ZOOM` — nothing past an edge, so no chip and no card drawn
 * back. Otherwise, and always in `focus`: all of it, centred, when it fits at
 * a zoom its names read at — never enlarged past its own size. Otherwise a
 * compact bracket opens on its module and the first level of each side across
 * the canvas (`frameFirstLevels`), and a regular one on its module, centred,
 * at its `READABLE_ZOOM`; the canvas then holds as much of the bracket as it
 * can, so a side with less to show never leaves part of the canvas empty while
 * the other side runs off it.
 *
 * On a canvas that names what is drawn over it, the frame keeps the cards it
 * opens on clear of that too: a compact bracket's first levels hang just below
 * the chips along the top, and whatever the frame, it moves as little as it
 * must for no card it draws to stand under a control (`clearOfControls`).
 */
export function getBracketFrame(
  bracket: ModuleDependencyBracket,
  canvas: BracketCanvas,
  framing: BracketFraming = 'focus'
): BracketViewport {
  if (framing === 'whole' && fitsWhole(bracket, canvas)) {
    const { drawnBounds } = bracket
    const zoom = Math.min(getWholeFitZoom(bracket, canvas), WHOLE_FRAME_MAX_ZOOM[bracket.size])
    const frame = centreOn(drawnBounds.x + drawnBounds.width / 2, drawnBounds.y + drawnBounds.height / 2, zoom, canvas)
    return clearOfControls(bracket, frame, canvas, getCards(bracket), canvas.top)
  }

  const { bounds } = bracket
  const room = getRoom(canvas)
  const readableZoom = READABLE_ZOOM[bracket.size]
  const fitZoom = Math.min(room.width / bounds.width, room.height / bounds.height)

  if (fitZoom >= readableZoom) {
    const zoom = Math.min(fitZoom, FRAME_MAX_ZOOM)
    const frame = centreOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, zoom, canvas)
    return clearOfControls(bracket, frame, canvas, getCards(bracket), canvas.top)
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

  return clearOfControls(bracket, {
    x: center ? showNearlyWholeSide(x, bounds, center, zoom, canvas) : x,
    y: keepContentAcross(frame.y, bounds.y, bounds.y + bounds.height, zoom, canvas.top + FRAME_PADDING, canvas.height - FRAME_PADDING),
    zoom
  }, canvas, center ? [center] : [], canvas.top)
}

/**
 * A compact bracket's opening frame: the module and the first level of each
 * side — or the empty card standing in for one — across the canvas, as large
 * as that fits, never larger than itself and never smaller than its names
 * read at (a canvas too narrow for that cuts the first levels at its edges,
 * the module still in the middle). Down the canvas, all of the first levels
 * when they fit, else the module in the middle.
 *
 * On a canvas that names how far down its chips reach, the first levels hang
 * just below them instead, the marks riding a card's top edge with them: as
 * large as fits across the canvas and down to its foot, within the same
 * bounds, and as high as the cards drawn in the columns in view let them
 * stand — those cards' tops just below the chips too — so long as the first
 * levels' foot stays in view.
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

  if (canvas.chipsBottom !== undefined) {
    const ceiling = canvas.chipsBottom + OVERLAY_GAP
    const floor = canvas.height - FIRST_LEVELS_INSET
    const firstTop = Math.min(...first.map(node => getDrawnTop(bracket, node)))
    const downZoom = (floor - ceiling) / (bottom - firstTop)
    const zoom = Math.max(READABLE_ZOOM.compact, Math.min(FRAME_MAX_ZOOM, acrossZoom, downZoom))
    const x = canvas.width / 2 - (left + right) / 2 * zoom
    const highest = Math.min(...getCards(bracket)
      .filter(node => node.position.x * zoom + x < canvas.width && (node.position.x + node.width) * zoom + x > 0)
      .map(node => getDrawnTop(bracket, node)))
    const y = Math.max(ceiling - firstTop * zoom, Math.min(ceiling - highest * zoom, floor - bottom * zoom))
    return clearOfControls(bracket, { x, y, zoom }, canvas, first, ceiling)
  }

  const zoom = Math.max(READABLE_ZOOM.compact, Math.min(FRAME_MAX_ZOOM, acrossZoom))
  const center = bracket.nodes.find(node => node.kind === 'center')
  const middle = (bottom - top) * zoom <= getRoom(canvas).height || !center
    ? (top + bottom) / 2
    : center.position.y + center.height / 2
  const frame = centreOn((left + right) / 2, middle, zoom, canvas)
  return clearOfControls(bracket, {
    x: frame.x,
    y: keepContentAcross(frame.y, bounds.y, bounds.y + bounds.height, zoom, canvas.top + FRAME_PADDING, canvas.height - FRAME_PADDING),
    zoom
  }, canvas, first, canvas.top)
}

/**
 * A frame moved, if need be, so no card it draws stands under one of the
 * controls drawn over the canvas, nor within `OVERLAY_GAP` of one: by the
 * least distance — across, up or down, or both — that clears them all and
 * keeps every card it frames that it had wholly in view so, below `ceiling`
 * and `FIRST_LEVELS_INSET` inside the other edges. A frame no such move
 * clears stays as it is; a canvas naming no controls keeps it as it is too.
 */
function clearOfControls(
  bracket: ModuleDependencyBracket,
  frame: BracketViewport,
  canvas: BracketCanvas,
  framed: readonly BracketNode[],
  ceiling: number
): BracketViewport {
  const controls = (canvas.controls ?? []).map(control => getBoxAround(control, OVERLAY_GAP))
  if (controls.length === 0) {
    return frame
  }

  const room: ScreenBox = {
    left: FIRST_LEVELS_INSET,
    top: ceiling,
    right: canvas.width - FIRST_LEVELS_INSET,
    bottom: canvas.height - FIRST_LEVELS_INSET
  }
  const whole: ScreenBox = { left: 0, top: 0, right: canvas.width, bottom: canvas.height }
  const cards = getCards(bracket)
  const kept = framed.filter(node => isWithin(toScreen(bracket, node, frame), room))
  const isClear = (viewport: BracketViewport): boolean =>
    kept.every(node => isWithin(toScreen(bracket, node, viewport), room))
    && cards.every((node) => {
      const box = toScreen(bracket, node, viewport)
      return !overlaps(box, whole) || controls.every(control => !overlaps(box, control))
    })

  if (isClear(frame)) {
    return frame
  }

  const drawn = cards.map(node => toScreen(bracket, node, frame)).filter(box => overlaps(box, whole))
  return getClearingMoves(drawn, controls)
    .map(move => ({ x: frame.x + move.x, y: frame.y + move.y, zoom: frame.zoom }))
    .find(isClear) ?? frame
}

/**
 * The moves that each put a card drawn just past a control — above or below
 * it, left or right of it — and each pair of those at once, shortest first.
 */
function getClearingMoves(
  cards: readonly ScreenBox[],
  controls: readonly ScreenBox[]
): Array<{ x: number, y: number }> {
  const across = new Set<number>()
  const down = new Set<number>()
  for (const card of cards) {
    for (const control of controls) {
      if (card.left < control.right && card.right > control.left) {
        down.add(control.top - card.bottom)
        down.add(control.bottom - card.top)
      }
      if (card.top < control.bottom && card.bottom > control.top) {
        across.add(control.left - card.right)
        across.add(control.right - card.left)
      }
    }
  }

  return [
    ...[...down].map(y => ({ x: 0, y })),
    ...[...across].map(x => ({ x, y: 0 })),
    ...[...across].flatMap(x => [...down].map(y => ({ x, y })))
  ].sort((first, second) => Math.hypot(first.x, first.y) - Math.hypot(second.x, second.y))
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
   * lies back towards the middle, past `middle`. Only levels drawn: never the
   * one past the depth a "+N more" stub stands for, which says its own count.
   */
  levels: Record<BracketSide, number[]>
  /** How many modules drawn on those levels are cut off: what a chip toward them counts. */
  modules: Record<BracketSide, number>
  /**
   * The modules waiting past stubs that edge cuts off, each once however many
   * stubs name them: what a chip says when stubs are all the edge cuts off.
   */
  stubModules: Record<BracketSide, number>
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
  return scanOffscreen(bracket, viewport, canvas).offscreen
}

/**
 * What a view leaves out, and the levels of the stubs it cuts off — which no
 * chip names, but a reveal brings into view all the same.
 */
function scanOffscreen(
  bracket: ModuleDependencyBracket,
  viewport: BracketViewport,
  canvas: BracketCanvas
): { offscreen: BracketOffscreen, stubLevels: Record<BracketSide, number[]> } {
  const view = getView(viewport, canvas)
  const levels: Record<BracketSide, Set<number>> = { left: new Set(), right: new Set() }
  const stubLevels: Record<BracketSide, Set<number>> = { left: new Set(), right: new Set() }
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
      // One more level that way, past the depth drawn: the stub says its own
      // count, so its level is no chip's to name, and its modules are counted
      // apart from the ones drawn, once however many stubs name them.
      if (node.side === 'left' ? pastLeft(node) : pastRight(node)) {
        stubLevels[node.side].add(node.level)
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

  const ascending = (found: Record<BracketSide, Set<number>>) => ({
    left: [...found.left].sort((first, second) => first - second),
    right: [...found.right].sort((first, second) => first - second)
  })
  return {
    offscreen: {
      levels: ascending(levels),
      modules: drawn,
      stubModules: { left: pastStubs.left.size, right: pastStubs.right.size },
      middle,
      above,
      below
    },
    stubLevels: ascending(stubLevels)
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
  const { offscreen, stubLevels } = scanOffscreen(bracket, viewport, canvas)
  const hidden = [...new Set([...offscreen.levels[side], ...stubLevels[side]])]
    .sort((first, second) => first - second)
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

/** Everything the canvas draws as a card: modules, stubs, the module in the middle and the empty places. */
function getCards(bracket: ModuleDependencyBracket): BracketNode[] {
  return bracket.nodes.filter(node => node.kind !== 'level')
}

/** Where a card is drawn from, down: a compact module's marks ride above its top edge. */
function getDrawnTop(bracket: ModuleDependencyBracket, node: BracketNode): number {
  const hasMarks = node.kind === 'module' && (node.isRoot || node.isOnCycleWithCenter)
  return bracket.size === 'compact' && hasMarks ? node.position.y - COMPACT_MARKS_OVERHANG : node.position.y
}

/** A box on screen by its edges. */
type ScreenBox = { left: number, top: number, right: number, bottom: number }

/** A card's box on screen under a viewport, the marks riding its top edge included. */
function toScreen(bracket: ModuleDependencyBracket, node: BracketNode, viewport: BracketViewport): ScreenBox {
  return {
    left: node.position.x * viewport.zoom + viewport.x,
    top: getDrawnTop(bracket, node) * viewport.zoom + viewport.y,
    right: (node.position.x + node.width) * viewport.zoom + viewport.x,
    bottom: (node.position.y + node.height) * viewport.zoom + viewport.y
  }
}

/** A box on the canvas grown by `margin` all round. */
function getBoxAround(box: CanvasBox, margin: number): ScreenBox {
  return {
    left: box.x - margin,
    top: box.y - margin,
    right: box.x + box.width + margin,
    bottom: box.y + box.height + margin
  }
}

function overlaps(first: ScreenBox, second: ScreenBox): boolean {
  return first.left < second.right && first.right > second.left
    && first.top < second.bottom && first.bottom > second.top
}

function isWithin(box: ScreenBox, area: ScreenBox): boolean {
  return box.left >= area.left - EDGE_TOLERANCE && box.right <= area.right + EDGE_TOLERANCE
    && box.top >= area.top - EDGE_TOLERANCE && box.bottom <= area.bottom + EDGE_TOLERANCE
}
