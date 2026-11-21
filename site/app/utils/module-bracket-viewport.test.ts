import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  FRAME_MAX_ZOOM,
  FRAME_PADDING,
  READABLE_ZOOM,
  formatLevelRange,
  getBracketFrame,
  getBracketLevelHeaders,
  getBracketOffscreen,
  getCutCardIds,
  getLevelRevealViewport,
  getVerticalRevealViewport,
  type BracketCanvas,
  type BracketViewport
} from './module-bracket-viewport.ts'
import {
  DEFAULT_BRACKET_DEPTH,
  buildModuleDependencyBracket,
  type BracketModuleNode,
  type BracketNode,
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
const PHONE: BracketCanvas = { width: 390, height: 520, top: 32 }

function build(bracketGraph: BracketGraph, center: string, depth = DEFAULT_BRACKET_DEPTH): ModuleDependencyBracket {
  const bracket = buildModuleDependencyBracket({ graph: bracketGraph, center, depth: { left: depth, right: depth } })
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

describe('module bracket viewport', () => {
  test('a bracket that fits at a readable zoom opens whole, centred, and never larger than itself', () => {
    const bracket = build(graph({ A: ['B'], B: [] }), 'A')
    const frame = getBracketFrame(bracket, DESKTOP)

    assert.ok(frame.zoom >= READABLE_ZOOM && frame.zoom <= FRAME_MAX_ZOOM, `zoom ${frame.zoom}`)
    for (const node of bracket.nodes.filter(candidate => candidate.kind !== 'level')) {
      assert.ok(isWhollyInView(node, frame, DESKTOP), `${node.id} is in view`)
    }
    assert.deepEqual(getBracketOffscreen(bracket, frame, DESKTOP), { levels: { left: [], right: [] }, middle: null, above: 0, below: 0 })
  })

  test('a bracket too wide to read whole opens on its module, at the zoom its names read at', () => {
    const bracket = build(CHAIN, 'M5')
    const frame = getBracketFrame(bracket, DESKTOP)
    const center = onScreen(centerOf(bracket), frame)

    assert.equal(frame.zoom, READABLE_ZOOM)
    assert.ok(Math.abs((center.left + center.right) / 2 - DESKTOP.width / 2) < 1, 'the module is centred across')
    assert.ok(isWhollyInView(centerOf(bracket), frame, DESKTOP))

    // What does not fit is named, side by side, nearest first.
    const offscreen = getBracketOffscreen(bracket, frame, DESKTOP)
    assert.ok(offscreen.levels.left.length > 0 && offscreen.levels.right.length > 0)
    assert.deepEqual(offscreen.levels.left, [...offscreen.levels.left].sort((a, b) => a - b))
    assert.equal(offscreen.levels.left.at(-1), DEFAULT_BRACKET_DEPTH)
  })

  test('on a phone the module alone is framed, readable, and each side is a reveal away', () => {
    const bracket = build(CHAIN, 'M5')
    const frame = getBracketFrame(bracket, PHONE)

    assert.equal(frame.zoom, READABLE_ZOOM)
    assert.ok(isWhollyInView(centerOf(bracket), frame, PHONE), 'the module fits a phone at a readable zoom')
    const opening = getBracketOffscreen(bracket, frame, PHONE)
    assert.deepEqual(opening.levels, { left: [1, 2, 3], right: [1, 2, 3] })
    assert.equal(opening.middle, null)

    // Each reveal brings the next level out wholly into view; the module in
    // the middle is then back past the other edge.
    let viewport = frame
    for (const level of [1, 2, 3]) {
      viewport = getLevelRevealViewport(bracket, viewport, PHONE, 'left')
      for (const node of modulesAt(bracket, 'left', level)) {
        assert.ok(isWhollyInView(node, viewport, PHONE), `level ${level} is in view after a reveal`)
      }
      const offscreen = getBracketOffscreen(bracket, viewport, PHONE)
      assert.deepEqual(offscreen.levels.left, [1, 2, 3].filter(further => further > level))
      assert.equal(offscreen.middle, 'right')
      assert.equal(viewport.zoom, READABLE_ZOOM, 'a reveal keeps the zoom')
    }
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
    assert.equal(frame.zoom, READABLE_ZOOM)
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

    assert.equal(frame.zoom, READABLE_ZOOM)
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

    // On a phone framed on the module, no column is in view yet.
    assert.deepEqual(getBracketLevelHeaders(bracket, getBracketFrame(bracket, PHONE), PHONE), [])

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
