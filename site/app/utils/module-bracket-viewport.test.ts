import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  COMPACT_MARKS_OVERHANG,
  FIRST_LEVELS_INSET,
  FRAME_MAX_ZOOM,
  FRAME_PADDING,
  OVERLAY_GAP,
  READABLE_ZOOM,
  WHOLE_FRAME_MAX_ZOOM,
  WHOLE_FRAME_PADDING,
  fitsWhole,
  formatLevelRange,
  getBracketFrame,
  getBracketLevelHeaders,
  getBracketOffscreen,
  getCutCardIds,
  getLevelRevealViewport,
  getVerticalRevealViewport,
  pickWholeFrameBracket,
  type BracketCanvas,
  type BracketViewport
} from './module-bracket-viewport.ts'
import {
  DEFAULT_BRACKET_DEPTH,
  buildModuleDependencyBracket,
  type BracketModuleNode,
  type BracketNode,
  type BracketSize,
  type ModuleDependencyBracket,
  type ModuleDependencyBracketInput
} from './module-dependency-bracket.ts'

type BracketGraph = ModuleDependencyBracketInput['graph']

function graph(imports: Record<string, string[]>): BracketGraph {
  return {
    root: Object.keys(imports)[0] ?? '',
    modules: Object.fromEntries(Object.entries(imports).map(([name, moduleImports]) => [
      name,
      { imports: moduleImports, exports: [], providers: [], controllers: [] }
    ])),
    cycles: { modules: [], providers: [], controllers: [] }
  }
}

/** M1 imports M2, which imports M3 … up to M9: four levels each side of M5. */
const CHAIN = graph(Object.fromEntries(
  Array.from({ length: 9 }, (_, index) => [`M${index + 1}`, index < 8 ? [`M${index + 2}`] : []])
))

/** M1 imports a fan of four, each importing two of its own: one side only, and tall. */
const ONE_SIDED = graph({
  Root: ['A', 'B', 'C', 'D'],
  A: ['A1', 'A2'],
  B: ['B1', 'B2'],
  C: ['C1', 'C2'],
  D: ['D1', 'D2'],
  A1: [],
  A2: [],
  B1: [],
  B2: [],
  C1: [],
  C2: [],
  D1: [],
  D2: []
})

const DESKTOP: BracketCanvas = { width: 1440, height: 640, top: 32 }
/** A 390px phone's canvas, inside the page's 16px margins. */
const PHONE: BracketCanvas = { width: 358, height: 520, top: 32 }

function build(bracketGraph: BracketGraph, center: string, depth = DEFAULT_BRACKET_DEPTH, size: BracketSize = 'regular'): ModuleDependencyBracket {
  const bracket = buildModuleDependencyBracket({ graph: bracketGraph, center, depth: { left: depth, right: depth }, size })
  assert.ok(bracket, `the graph has ${center}`)
  return bracket
}

/** A node's box on screen under a viewport. */
function onScreen(node: BracketNode, viewport: BracketViewport) {
  return {
    left: node.position.x * viewport.zoom + viewport.x,
    right: (node.position.x + node.width) * viewport.zoom + viewport.x,
    top: node.position.y * viewport.zoom + viewport.y,
    bottom: (node.position.y + node.height) * viewport.zoom + viewport.y
  }
}

function isWhollyInView(node: BracketNode, viewport: BracketViewport, canvas: BracketCanvas): boolean {
  const box = onScreen(node, viewport)
  return box.left >= -1 && box.right <= canvas.width + 1 && box.top >= canvas.top - 1 && box.bottom <= canvas.height + 1
}

function centerOf(bracket: ModuleDependencyBracket): BracketNode {
  const center = bracket.nodes.find(node => node.kind === 'center')
  assert.ok(center)
  return center
}

function modulesAt(bracket: ModuleDependencyBracket, side: 'left' | 'right', level: number): BracketModuleNode[] {
  return bracket.nodes.filter((node): node is BracketModuleNode =>
    node.kind === 'module' && node.side === side && node.level === level)
}

/** A view that leaves nothing out: no chip, nothing above or below. */
const NOTHING_OFFSCREEN = {
  levels: { left: [], right: [] },
  modules: { left: 0, right: 0 },
  stubModules: { left: 0, right: 0 },
  middle: null,
  above: 0,
  below: 0
}

describe('module bracket viewport', () => {
  test('a bracket that fits at a readable zoom opens whole, centred, and never larger than itself', () => {
    const bracket = build(graph({ A: ['B'], B: [] }), 'A')
    const frame = getBracketFrame(bracket, DESKTOP)

    assert.ok(frame.zoom >= READABLE_ZOOM.regular && frame.zoom <= FRAME_MAX_ZOOM, `zoom ${frame.zoom}`)
    for (const node of bracket.nodes.filter(candidate => candidate.kind !== 'level')) {
      assert.ok(isWhollyInView(node, frame, DESKTOP), `${node.id} is in view`)
    }
    assert.deepEqual(getBracketOffscreen(bracket, frame, DESKTOP), NOTHING_OFFSCREEN)
  })

  test('a bracket too wide to read whole opens on its module, at the zoom its names read at', () => {
    const bracket = build(CHAIN, 'M5')
    const frame = getBracketFrame(bracket, DESKTOP)
    const center = onScreen(centerOf(bracket), frame)

    assert.equal(frame.zoom, READABLE_ZOOM.regular)
    assert.ok(Math.abs((center.left + center.right) / 2 - DESKTOP.width / 2) < 1, 'the module is centred across')
    assert.ok(isWhollyInView(centerOf(bracket), frame, DESKTOP))

    // What does not fit is named, side by side, nearest first.
    const offscreen = getBracketOffscreen(bracket, frame, DESKTOP)
    assert.ok(offscreen.levels.left.length > 0 && offscreen.levels.right.length > 0)
    assert.deepEqual(offscreen.levels.left, [...offscreen.levels.left].sort((a, b) => a - b))
    // The furthest named is the last level drawn, never the one past the
    // depth a stub stands for: the stub says its own count.
    assert.equal(offscreen.levels.left.at(-1), DEFAULT_BRACKET_DEPTH)
    assert.equal(offscreen.stubModules.left, 1)
  })

  test('on a phone a compact bracket opens on its module and the first level of each side, readable', () => {
    const bracket = build(CHAIN, 'M5', DEFAULT_BRACKET_DEPTH, 'compact')
    const frame = getBracketFrame(bracket, PHONE)

    assert.ok(frame.zoom >= READABLE_ZOOM.compact && frame.zoom <= FRAME_MAX_ZOOM, `zoom ${frame.zoom}`)
    // 11.5px names drawn at 11px or more.
    assert.ok(11.5 * frame.zoom >= 11, `names drawn at ${11.5 * frame.zoom}px`)
    for (const node of [centerOf(bracket), ...modulesAt(bracket, 'left', 1), ...modulesAt(bracket, 'right', 1)]) {
      const box = onScreen(node, frame)
      assert.ok(isWhollyInView(node, frame, PHONE), `${node.id} is in view`)
      assert.ok(box.left >= FIRST_LEVELS_INSET - 1 && box.right <= PHONE.width - FIRST_LEVELS_INSET + 1, `${node.id} keeps off the edge`)
    }

    // The chips name only the levels drawn that the frame leaves out — 2 and
    // 3, never the one past the depth the stubs stand for — and count their
    // modules; the stubs keep their own count, and the first levels are not
    // drawn back as cut.
    const opening = getBracketOffscreen(bracket, frame, PHONE)
    assert.deepEqual(opening.levels, { left: [2, 3], right: [2, 3] })
    assert.deepEqual(opening.modules, { left: 2, right: 2 })
    assert.deepEqual(opening.stubModules, { left: 1, right: 1 })
    assert.equal(opening.middle, null)
    const cut = getCutCardIds(bracket, frame, PHONE)
    for (const node of [...modulesAt(bracket, 'left', 1), ...modulesAt(bracket, 'right', 1)]) {
      assert.equal(cut.has(node.id), false, `${node.id} is not drawn back`)
    }

    // A reveal brings the next levels out wholly into view at the same zoom;
    // the module in the middle is then back past the other edge.
    const revealed = getLevelRevealViewport(bracket, frame, PHONE, 'left')
    assert.equal(revealed.zoom, frame.zoom, 'a reveal keeps the zoom')
    for (const node of modulesAt(bracket, 'left', 2)) {
      assert.ok(isWhollyInView(node, revealed, PHONE), 'level 2 is in view after a reveal')
    }
    const after = getBracketOffscreen(bracket, revealed, PHONE)
    assert.ok(!after.levels.left.includes(2))
    assert.equal(after.middle, 'right')
  })

  test('a compact bracket short enough opens whole, and one too wide for a phone keeps its names readable', () => {
    // Only a first level each side: it all fits, just inside the edges.
    const small = build(graph({ A: ['B'], B: [], C: ['A'] }), 'A', DEFAULT_BRACKET_DEPTH, 'compact')
    const frame = getBracketFrame(small, PHONE)
    for (const node of small.nodes.filter(candidate => candidate.kind !== 'level')) {
      assert.ok(isWhollyInView(node, frame, PHONE), `${node.id} is in view`)
    }
    assert.ok(frame.zoom >= READABLE_ZOOM.compact)

    // A side with no module on it still opens across both first places.
    const lonely = build(graph({ A: ['B'], B: [] }), 'B', DEFAULT_BRACKET_DEPTH, 'compact')
    const lonelyFrame = getBracketFrame(lonely, PHONE)
    for (const node of lonely.nodes.filter(candidate => candidate.kind === 'empty' || candidate.kind === 'center')) {
      assert.ok(isWhollyInView(node, lonelyFrame, PHONE), `${node.id} is in view`)
    }

    // A canvas narrower than the first levels at a readable zoom keeps the
    // zoom and the module in the middle; the edges cut the first levels.
    const narrow: BracketCanvas = { width: 288, height: 520, top: 32 }
    const chain = build(CHAIN, 'M5', DEFAULT_BRACKET_DEPTH, 'compact')
    const narrowFrame = getBracketFrame(chain, narrow)
    assert.equal(narrowFrame.zoom, READABLE_ZOOM.compact)
    const center = onScreen(centerOf(chain), narrowFrame)
    assert.ok(Math.abs((center.left + center.right) / 2 - narrow.width / 2) < 1)
  })

  test('a chip counts the modules drawn in the levels it leads to; the stubs past them keep their own count, each module once', () => {
    const bracket = build(CHAIN, 'M5')
    const frame = getBracketFrame(bracket, DESKTOP)
    const offscreen = getBracketOffscreen(bracket, frame, DESKTOP)
    for (const side of ['left', 'right'] as const) {
      const drawn = offscreen.levels[side].reduce((total, level) => total + modulesAt(bracket, side, level).length, 0)
      const pastStubs = new Set(bracket.nodes.flatMap(node =>
        node.kind === 'stub' && node.side === side ? node.moduleNames : []))
      assert.ok(drawn > 0 && pastStubs.size > 0, side)
      assert.equal(offscreen.modules[side], drawn, side)
      assert.equal(offscreen.stubModules[side], pastStubs.size, side)
      assert.ok(offscreen.levels[side].every(level => level <= DEFAULT_BRACKET_DEPTH), `${side}: no level past the depth drawn`)
    }

    // Z waits past both A and B: two stubs, one module; nothing drawn is cut
    // off, so no level is named.
    const fan = build(graph({ C: ['A', 'B'], A: ['Z'], B: ['Z'], Z: [] }), 'C', 1, 'compact')
    const fanOpening = getBracketOffscreen(fan, getBracketFrame(fan, PHONE), PHONE)
    assert.deepEqual(fanOpening.levels.left, [])
    assert.equal(fanOpening.modules.left, 0)
    assert.equal(fanOpening.stubModules.left, 1)
  })

  test('a side whose only cards past the edge are stubs has a chip toward them all the same', () => {
    // One level drawn on the left of a phone, and a stub past it.
    const bracket = build(CHAIN, 'M5', 1, 'compact')
    const frame = getBracketFrame(bracket, PHONE)
    const opening = getBracketOffscreen(bracket, frame, PHONE)
    assert.deepEqual(opening.levels.left, [])
    assert.equal(opening.modules.left, 0)
    assert.equal(opening.stubModules.left, 1)

    // Its chip brings the stub wholly into view, ready to press.
    const revealed = getLevelRevealViewport(bracket, frame, PHONE, 'left')
    const stub = bracket.nodes.find(node => node.kind === 'stub' && node.side === 'left')
    assert.ok(stub)
    assert.ok(isWhollyInView(stub, revealed, PHONE))
    assert.equal(getBracketOffscreen(bracket, revealed, PHONE).stubModules.left, 0)
  })

  test('framed whole, a bracket that reads whole opens with every card and stub inside the canvas, below its headings', () => {
    const bracket = build(CHAIN, 'M5', DEFAULT_BRACKET_DEPTH, 'compact')
    assert.ok(fitsWhole(bracket, DESKTOP))
    const frame = getBracketFrame(bracket, DESKTOP, 'whole')

    assert.ok(frame.zoom >= READABLE_ZOOM.compact && frame.zoom <= WHOLE_FRAME_MAX_ZOOM.compact, `zoom ${frame.zoom}`)
    const drawn = bracket.nodes.filter(node => node.kind !== 'level')
    assert.ok(drawn.some(node => node.kind === 'stub'))
    for (const node of drawn) {
      const box = onScreen(node, frame)
      assert.ok(
        box.left >= WHOLE_FRAME_PADDING - 1
        && box.right <= DESKTOP.width - WHOLE_FRAME_PADDING + 1
        && box.top >= DESKTOP.top + WHOLE_FRAME_PADDING - 1
        && box.bottom <= DESKTOP.height - WHOLE_FRAME_PADDING + 1,
        `${node.id} is inside the canvas, below its headings`
      )
    }
    assert.deepEqual(getBracketOffscreen(bracket, frame, DESKTOP), NOTHING_OFFSCREEN)
    assert.equal(getCutCardIds(bracket, frame, DESKTOP).size, 0)
  })

  test('framed whole, the regular bracket is drawn where it reads whole, else the compact one, else neither', () => {
    const pair = graph({ A: ['B'], B: [] })
    const regular = build(pair, 'A')
    const compact = build(pair, 'A', DEFAULT_BRACKET_DEPTH, 'compact')
    assert.equal(pickWholeFrameBracket([regular, compact], DESKTOP), regular)

    // Four levels each side: too wide whole at a regular size, not at a compact one.
    const chainRegular = build(CHAIN, 'M5')
    const chainCompact = build(CHAIN, 'M5', DEFAULT_BRACKET_DEPTH, 'compact')
    assert.equal(pickWholeFrameBracket([chainRegular, chainCompact], DESKTOP), chainCompact)
    assert.equal(pickWholeFrameBracket([chainRegular, chainCompact], PHONE), null)
  })

  test('framed whole, a bracket that reads whole at neither size opens in focus, as a module page opens it', () => {
    const chain = build(CHAIN, 'M5')
    assert.equal(fitsWhole(chain, DESKTOP), false)
    assert.deepEqual(getBracketFrame(chain, DESKTOP, 'whole'), getBracketFrame(chain, DESKTOP))

    const compactChain = build(CHAIN, 'M5', DEFAULT_BRACKET_DEPTH, 'compact')
    assert.deepEqual(getBracketFrame(compactChain, PHONE, 'whole'), getBracketFrame(compactChain, PHONE))
  })

  test('on a canvas naming its chips, a compact bracket that reads whole at neither size hangs its first levels just below them, readable', () => {
    const chain = build(CHAIN, 'M5', DEFAULT_BRACKET_DEPTH, 'compact')
    const first = [centerOf(chain), ...modulesAt(chain, 'left', 1), ...modulesAt(chain, 'right', 1)]
    const firstHeight = Math.max(...first.map(node => node.position.y + node.height)) - Math.min(...first.map(node => node.position.y))
    const chipsBottom = 84
    // A column's canvas: the first levels fit across it, and down it below the
    // chips only a little smaller than their own size.
    const column: BracketCanvas = {
      width: 426,
      height: Math.round(chipsBottom + OVERLAY_GAP + firstHeight * 0.98 + FIRST_LEVELS_INSET),
      top: 32,
      chipsBottom
    }
    assert.equal(fitsWhole(chain, column), false)

    const frame = getBracketFrame(chain, column, 'whole')
    assert.ok(frame.zoom >= READABLE_ZOOM.compact && frame.zoom < FRAME_MAX_ZOOM, `zoom ${frame.zoom}`)
    for (const node of first) {
      const box = onScreen(node, frame)
      assert.ok(box.top >= chipsBottom + OVERLAY_GAP - 1, `${node.id} stands below the chips`)
      assert.ok(box.bottom <= column.height - FIRST_LEVELS_INSET + 1, `${node.id} stands above the canvas foot`)
      assert.ok(box.left >= FIRST_LEVELS_INSET - 1 && box.right <= column.width - FIRST_LEVELS_INSET + 1, `${node.id} is in view across`)
    }

    // Named no chips, the same canvas frames the bracket as it always has.
    const { chipsBottom: _chips, ...plain } = column
    assert.deepEqual(getBracketFrame(chain, plain, 'whole'), getBracketFrame(chain, plain))

    // A module's marks ride its card's top edge: the root's, on the card atop
    // the first level — its column spread by a branch of its own — hangs
    // below the chips with it.
    const rooted = build(graph({
      App: ['Center'],
      Auth: ['Center'],
      Loyalty: ['Center'],
      Order: ['Loyalty'],
      Voucher: ['Loyalty'],
      Payment: ['Order'],
      Center: ['Db'],
      Db: ['Config'],
      Config: ['Env'],
      Env: []
    }), 'Center', DEFAULT_BRACKET_DEPTH, 'compact')
    const roomy = { ...column, height: 420 }
    assert.equal(fitsWhole(rooted, roomy), false)
    const rootedFirst = [centerOf(rooted), ...modulesAt(rooted, 'left', 1), ...modulesAt(rooted, 'right', 1)]
    const root = modulesAt(rooted, 'right', 1).find(node => node.isRoot)
    assert.ok(root && root.position.y === Math.min(...rootedFirst.map(node => node.position.y)), 'the root tops the first levels')
    const rootedFrame = getBracketFrame(rooted, roomy, 'whole')
    const markTop = onScreen(root, rootedFrame).top - COMPACT_MARKS_OVERHANG * rootedFrame.zoom
    assert.ok(Math.abs(markTop - (chipsBottom + OVERLAY_GAP)) < 0.01, `the Root mark hangs just below the chips, at ${markTop}`)
  })

  test('below the chips, the cards drawn beside the first levels hang clear of them too, where the canvas has the room', () => {
    // A fan of four on the left, each with two of its own: the second level
    // is taller than the first, and the canvas too narrow for it whole draws
    // it cut at its edge.
    const fan = build(ONE_SIDED, 'Root', DEFAULT_BRACKET_DEPTH, 'compact')
    const canvas: BracketCanvas = { width: 480, height: 900, top: 32, chipsBottom: 84 }
    assert.equal(fitsWhole(fan, canvas), false)
    const frame = getBracketFrame(fan, canvas, 'whole')
    const drawn = fan.nodes
      .filter(node => node.kind !== 'level')
      .filter((node) => {
        const box = onScreen(node, frame)
        return box.right > 0 && box.left < canvas.width && box.bottom > 0 && box.top < canvas.height
      })
    assert.ok(drawn.some(node => node.kind === 'module' && node.level === 2), 'the second level is drawn beside the first')
    for (const node of drawn) {
      assert.ok(onScreen(node, frame).top >= 84 + OVERLAY_GAP - 1, `${node.id} stands below the chips`)
    }
  })

  test('a frame moves by the least it must for no card it draws to stand under a control, and stays put where no move clears one', () => {
    const small = build(graph({ A: ['B'], B: [], C: ['A'] }), 'A', DEFAULT_BRACKET_DEPTH, 'compact')
    const canvas: BracketCanvas = { width: 640, height: 400, top: 32 }
    const open = getBracketFrame(small, canvas, 'whole')
    const [needed] = modulesAt(small, 'left', 1)
    assert.ok(needed)
    const card = onScreen(needed, open)

    // A control 3px over the card's left end: the least move is across, by
    // those 3px and the gap kept from a control.
    const control = { x: 0, y: card.top, width: card.left + 3, height: 20 }
    const moved = getBracketFrame(small, { ...canvas, controls: [control] }, 'whole')
    assert.equal(moved.zoom, open.zoom)
    assert.equal(moved.y, open.y)
    assert.ok(Math.abs(moved.x - open.x - (3 + OVERLAY_GAP)) < 0.01, `moved across by ${moved.x - open.x}`)
    for (const node of small.nodes.filter(candidate => candidate.kind !== 'level')) {
      const box = onScreen(node, moved)
      const isClear = box.right <= control.x + control.width + OVERLAY_GAP || box.left >= control.x + control.width + OVERLAY_GAP
        || box.bottom <= control.y - OVERLAY_GAP || box.top >= control.y + control.height + OVERLAY_GAP
      assert.ok(isClear, `${node.id} stands clear of the control`)
      assert.ok(isWhollyInView(node, moved, canvas), `${node.id} is still in view`)
    }

    // A control over the whole canvas leaves no move to make.
    const everywhere = { x: 0, y: 0, width: canvas.width, height: canvas.height }
    assert.deepEqual(getBracketFrame(small, { ...canvas, controls: [everywhere] }, 'whole'), open)
  })

  test('a whole frame enlarges a small bracket only to its cap: a compact one past its own size, a regular one never', () => {
    const pair = graph({ A: ['B'], B: [] })
    const roomy: BracketCanvas = { width: 2400, height: 1400, top: 32 }
    assert.equal(getBracketFrame(build(pair, 'A', DEFAULT_BRACKET_DEPTH, 'compact'), roomy, 'whole').zoom, WHOLE_FRAME_MAX_ZOOM.compact)
    assert.equal(getBracketFrame(build(pair, 'A'), roomy, 'whole').zoom, WHOLE_FRAME_MAX_ZOOM.regular)
  })

  test('on a desktop a reveal brings in every level cut off that fits, the furthest against the edge', () => {
    const bracket = build(CHAIN, 'M5')
    const frame = getBracketFrame(bracket, DESKTOP)
    const revealed = getLevelRevealViewport(bracket, frame, DESKTOP, 'right')

    for (const level of getBracketOffscreen(bracket, frame, DESKTOP).levels.right) {
      for (const node of modulesAt(bracket, 'right', level)) {
        assert.ok(isWhollyInView(node, revealed, DESKTOP), `level ${level} is in view`)
      }
    }
    assert.deepEqual(getBracketOffscreen(bracket, revealed, DESKTOP).levels.right, [])

    // The furthest card, or the stub after it, stands at the canvas edge.
    const furthest = bracket.nodes
      .filter(node => (node.kind === 'module' || node.kind === 'stub') && node.side === 'right')
      .map(node => onScreen(node, revealed).right)
    assert.ok(Math.abs(Math.max(...furthest) - (DESKTOP.width - FRAME_PADDING)) < 1)
  })

  test('a side with less to show leaves no canvas empty while the other side runs off it', () => {
    // M1 imports four levels' worth; nothing imports M1, so its right side is
    // one empty card.
    const bracket = build(CHAIN, 'M1', 4)
    const frame = getBracketFrame(bracket, DESKTOP)
    const { bounds } = bracket

    // The bracket does not fit across, so its right edge stands at the canvas
    // edge rather than in the middle of empty canvas.
    assert.equal(frame.zoom, READABLE_ZOOM.regular)
    assert.ok(Math.abs((bounds.x + bounds.width) * frame.zoom + frame.x - (DESKTOP.width - FRAME_PADDING)) < 1)
    assert.ok(isWhollyInView(centerOf(bracket), frame, DESKTOP))
    assert.ok(getBracketOffscreen(bracket, frame, DESKTOP).levels.left.length > 0)
  })

  test('a side running only a little past the canvas is shown whole, the other still a pan away', () => {
    // One level on the left with its stubs; four on the right: the left side
    // ends a little past the edge when the module is centred.
    const deeper = buildModuleDependencyBracket({ graph: CHAIN, center: 'M5', depth: { left: 1, right: 4 } })
    assert.ok(deeper)
    const canvas: BracketCanvas = { width: 1300, height: 640, top: 32 }
    const frame = getBracketFrame(deeper, canvas)
    const leftmost = Math.min(...deeper.nodes.map(node => onScreen(node, frame).left))

    assert.equal(frame.zoom, READABLE_ZOOM.regular)
    assert.ok(Math.abs(leftmost - FRAME_PADDING) < 1, `the left side starts at the canvas edge (${leftmost})`)
    assert.ok(isWhollyInView(centerOf(deeper), frame, canvas))
    assert.deepEqual(getBracketOffscreen(deeper, frame, canvas).levels.left, [])

    // Both sides far past the edges: the module stays in the middle.
    const wide = build(CHAIN, 'M5', 4)
    const center = onScreen(centerOf(wide), getBracketFrame(wide, canvas))
    assert.ok(Math.abs((center.left + center.right) / 2 - canvas.width / 2) < 1)
  })

  test('a reveal up or down moves most of a canvas, never past the bracket', () => {
    const bracket = build(ONE_SIDED, 'Root')
    const canvas: BracketCanvas = { width: 1440, height: 300, top: 32 }
    const frame = getBracketFrame(bracket, canvas)
    const offscreen = getBracketOffscreen(bracket, frame, canvas)
    assert.ok(offscreen.above + offscreen.below > 0, 'a short canvas cuts the tall column off')

    let viewport = frame
    for (let step = 0; step < 10; step += 1) {
      viewport = getVerticalRevealViewport(bracket, viewport, canvas, 'down')
    }
    const lowest = Math.max(...bracket.nodes.map(node => onScreen(node, viewport).bottom))
    assert.ok(Math.abs(lowest - (canvas.height - FRAME_PADDING)) < 2, 'the bracket ends at the canvas foot')
    assert.equal(getBracketOffscreen(bracket, viewport, canvas).below, 0)

    for (let step = 0; step < 10; step += 1) {
      viewport = getVerticalRevealViewport(bracket, viewport, canvas, 'up')
    }
    assert.equal(getBracketOffscreen(bracket, viewport, canvas).above, 0)
  })

  test('column headings stand over the part of their columns in view, inside the canvas edges', () => {
    const bracket = build(CHAIN, 'M5')

    // On a phone the first level of each side opens in view, and is headed.
    const compact = build(CHAIN, 'M5', DEFAULT_BRACKET_DEPTH, 'compact')
    const phoneHeaders = getBracketLevelHeaders(compact, getBracketFrame(compact, PHONE), PHONE)
    assert.deepEqual(phoneHeaders.map(header => `${header.side} ${header.level}`).sort(), ['left 1', 'right 1'])

    const frame = getBracketFrame(bracket, DESKTOP)
    const headers = getBracketLevelHeaders(bracket, frame, DESKTOP)
    assert.ok(headers.some(header => header.side === 'left' && header.level === 1))
    assert.ok(headers.some(header => header.side === 'right' && header.level === 1))

    for (const header of headers) {
      const column = modulesAt(bracket, header.side, header.level)[0]
      assert.ok(column)
      const box = onScreen(column, frame)
      // Over its own column, as much of it as the canvas shows…
      assert.ok(header.left >= box.left - 1 && header.left + header.width <= box.right + 1, header.id)
      // …and never against, or past, the canvas edge.
      assert.ok(header.left >= 8 && header.left + header.width <= DESKTOP.width - 8, header.id)
      assert.ok(header.width >= 72, header.id)
    }

    // A column wholly in view is headed across all of it.
    const wholly = headers.find(header => header.side === 'right' && header.level === 1)
    const firstRight = modulesAt(bracket, 'right', 1)[0]
    assert.ok(wholly && firstRight)
    assert.ok(Math.abs(onScreen(firstRight, frame).left - wholly.left) < 1)
  })

  test('the cards an edge cuts through are named, and only those', () => {
    const bracket = build(CHAIN, 'M5')
    const frame = getBracketFrame(bracket, DESKTOP)
    const cut = getCutCardIds(bracket, frame, DESKTOP)

    for (const node of bracket.nodes.filter(candidate => candidate.kind === 'module' || candidate.kind === 'stub')) {
      const box = onScreen(node, frame)
      const isPartlyInView = box.right > 0 && box.left < DESKTOP.width
      const isWhollyAcross = box.left >= -1 && box.right <= DESKTOP.width + 1
      assert.equal(cut.has(node.id), isPartlyInView && !isWhollyAcross, node.id)
    }

    // A bracket framed whole has no card cut.
    const small = build(graph({ A: ['B'], B: [] }), 'A')
    assert.equal(getCutCardIds(small, getBracketFrame(small, DESKTOP), DESKTOP).size, 0)
  })

  test('a chip names one level, or a range of them', () => {
    assert.equal(formatLevelRange([3]), 'Level 3')
    assert.equal(formatLevelRange([2, 3, 4]), 'Levels 2–4')
    assert.equal(formatLevelRange([]), '')
  })
})
