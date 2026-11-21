import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { GraphOutputCycle, GraphOutputModule } from 'nest-graph-inspector'
import { formatCircularEdgeLabel, getCircularLabelBox } from './circular-dependency-edge.ts'
import {
  BRACKET_CENTER_ID,
  DEFAULT_BRACKET_DEPTH,
  buildModuleDependencyBracket,
  getBracketModuleNodeId,
  type BracketCenterNode,
  type BracketEdge,
  type BracketModuleNode,
  type BracketNode,
  type BracketSide,
  type BracketStubNode,
  type ModuleDependencyBracket,
  type ModuleDependencyBracketInput
} from './module-dependency-bracket.ts'

type BracketGraph = ModuleDependencyBracketInput['graph']

/** A module importing `imports`, declaring nothing else unless the test says. */
function module(imports: string[] = [], overrides: Partial<GraphOutputModule> = {}): GraphOutputModule {
  return { imports, exports: [], providers: [], controllers: [], ...overrides }
}

function cycle(id: number, path: string[]): GraphOutputCycle {
  const [from = '', to = ''] = path
  return { id, from, to, type: path.length === 3 || from === to ? 'direct' : 'indirect', path }
}

/** A graph from `name → imports`, in that order, with the cycles given. */
function graph(
  imports: Record<string, string[]>,
  options: { root?: string, cycles?: GraphOutputCycle[] } = {}
): BracketGraph {
  return {
    root: options.root ?? Object.keys(imports)[0] ?? '',
    modules: Object.fromEntries(
      Object.entries(imports).map(([name, moduleImports]) => [name, module(moduleImports)])
    ),
    cycles: { modules: options.cycles ?? [], providers: [], controllers: [] }
  }
}

/**
 * Shaped like the demo's Shop App: a global DatabaseModule every module
 * imports, the direct cycle OrderModule ⇄ PaymentModule (#1), and the
 * indirect one ProductModule → RecommendationModule → OrderModule →
 * StoreProductModule → ProductModule (#2).
 */
const SHOP = graph(
  {
    AppModule: [
      'DatabaseModule', 'AuthModule', 'CustomerModule', 'CustomerLoyaltyModule',
      'OrderModule', 'PaymentModule', 'ProductModule', 'RecommendationModule',
      'StoreModule', 'StoreProductModule', 'VoucherModule'
    ],
    AuthModule: ['CustomerModule', 'DatabaseModule'],
    CustomerModule: ['DatabaseModule'],
    CustomerLoyaltyModule: ['CustomerModule', 'DatabaseModule'],
    VoucherModule: ['CustomerLoyaltyModule', 'DatabaseModule'],
    StoreModule: ['DatabaseModule'],
    ProductModule: ['RecommendationModule', 'DatabaseModule'],
    StoreProductModule: ['ProductModule', 'StoreModule', 'DatabaseModule'],
    RecommendationModule: ['OrderModule', 'DatabaseModule'],
    OrderModule: [
      'StoreProductModule', 'VoucherModule', 'CustomerLoyaltyModule',
      'PaymentModule', 'DatabaseModule'
    ],
    PaymentModule: ['OrderModule', 'DatabaseModule'],
    DatabaseModule: []
  },
  {
    root: 'AppModule',
    cycles: [
      cycle(1, ['OrderModule', 'PaymentModule', 'OrderModule']),
      cycle(2, [
        'ProductModule', 'RecommendationModule', 'OrderModule',
        'StoreProductModule', 'ProductModule'
      ])
    ]
  }
)

/** M1 imports M2, which imports M3 … up to M9. */
const CHAIN = graph(Object.fromEntries(
  Array.from({ length: 9 }, (_, index) => [
    `M${index + 1}`,
    index < 8 ? [`M${index + 2}`] : []
  ])
))

function build(
  bracketGraph: BracketGraph,
  center: string,
  depth: { left?: number, right?: number } = {}
): ModuleDependencyBracket {
  const bracket = buildModuleDependencyBracket({
    graph: bracketGraph,
    center,
    depth: {
      left: depth.left ?? DEFAULT_BRACKET_DEPTH,
      right: depth.right ?? DEFAULT_BRACKET_DEPTH
    }
  })
  assert.ok(bracket, `the graph has ${center}`)
  return bracket
}

function modulesOn(bracket: ModuleDependencyBracket, side: BracketSide): BracketModuleNode[] {
  return bracket.nodes.filter(
    (node): node is BracketModuleNode => node.kind === 'module' && node.side === side
  )
}

/** The modules on a side, by level, each level top to bottom. */
function levelsOf(bracket: ModuleDependencyBracket, side: BracketSide): string[][] {
  const levels: string[][] = []
  for (const node of [...modulesOn(bracket, side)].sort((left, right) => left.position.y - right.position.y)) {
    const level = levels[node.level - 1] ?? []
    level.push(node.moduleName)
    levels[node.level - 1] = level
  }
  return levels
}

function stubsOf(bracket: ModuleDependencyBracket, side: BracketSide): Array<{ branch: string, count: number, level: number }> {
  const byId = new Map(bracket.nodes.map(node => [node.id, node]))
  return bracket.nodes
    .filter((node): node is BracketStubNode => node.kind === 'stub' && node.side === side)
    .map((stub) => {
      const branch = byId.get(stub.parentId)
      return {
        branch: branch?.kind === 'module' ? branch.moduleName : '?',
        count: stub.moduleCount,
        level: stub.level
      }
    })
}

function nodeOf(bracket: ModuleDependencyBracket, side: BracketSide, moduleName: string): BracketModuleNode {
  const node = bracket.nodes.find(candidate => candidate.id === getBracketModuleNodeId(side, moduleName))
  assert.ok(node?.kind === 'module', `${moduleName} is drawn on the ${side}`)
  return node
}

/** An edge between two nodes, by their ids. */
function edgeBetween(bracket: ModuleDependencyBracket, source: string, target: string): BracketEdge | undefined {
  return bracket.edges.find(edge => edge.source === source && edge.target === target)
}

function centerY(node: BracketNode): number {
  return node.position.y + node.height / 2
}

function boxesOverlap(
  left: { x: number, y: number, width: number, height: number },
  right: { x: number, y: number, width: number, height: number }
): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height
}

type Point = { x: number, y: number }

/**
 * The points a routed edge's path runs through: where it starts, every
 * corner, and where each rounded corner is entered — consecutive points are
 * on one straight stretch, so each pair is a stretch of the route.
 */
function routeOf(path: string): Point[] {
  const tokens = path.match(/[MLQC]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []
  const points: Point[] = []
  let command = ''
  let pending: number[] = []

  for (const token of tokens) {
    if (/^[MLQC]$/i.test(token)) {
      command = token.toUpperCase()
      pending = []
      continue
    }

    pending.push(Number(token))
    if (pending.length === 2) {
      const [x = 0, y = 0] = pending
      // A rounded corner is a quadratic curve: its control point is the
      // corner itself, its end lies on the next stretch.
      if (command !== 'Q' || points.length === 0 || points.at(-1)?.x !== x || points.at(-1)?.y !== y) {
        points.push({ x, y })
      }
      pending = []
    }
  }

  return points
}

/** The cards an edge's route passes behind, other than its own two ends. */
function cardsCrossed(bracket: ModuleDependencyBracket, edge: BracketEdge): string[] {
  const route = routeOf(edge.path)
  const cards = bracket.nodes.filter(node =>
    node.kind !== 'level' && node.id !== edge.source && node.id !== edge.target)

  return cards
    .filter(card => route.slice(1).some((end, index) => {
      const start = route[index] ?? end
      const left = Math.min(start.x, end.x)
      const right = Math.max(start.x, end.x)
      const top = Math.min(start.y, end.y)
      const bottom = Math.max(start.y, end.y)
      return left < card.position.x + card.width - 1
        && right > card.position.x + 1
        && top < card.position.y + card.height - 1
        && bottom > card.position.y + 1
    }))
    .map(card => card.id)
}

/**
 * Pairs of edges joining no card in common that run along one straight
 * stretch, where one cannot be told from the other. Edges meeting at a card
 * share the stretch beside it by design.
 */
function sharedStretches(bracket: ModuleDependencyBracket): string[] {
  const edges = bracket.edges.filter(edge => edge.kind !== 'self')
  const shared: string[] = []

  for (const [index, first] of edges.entries()) {
    const ends = new Set([first.source, first.target])
    for (const second of edges.slice(index + 1)) {
      if (!ends.has(second.source) && !ends.has(second.target) && runAlongEachOther(first, second)) {
        shared.push(`${first.id} and ${second.id}`)
      }
    }
  }

  return shared
}

/** Each straight stretch of an edge's route, as its two ends. */
function stretchesOf(edge: BracketEdge): Array<readonly [Point, Point]> {
  const route = routeOf(edge.path)
  return route.slice(1).map((end, index) => [route[index] ?? end, end] as const)
}

/** Whether two edges run along one straight stretch for more than a pixel. */
function runAlongEachOther(first: BracketEdge, second: BracketEdge): boolean {
  const theirs = stretchesOf(second)
  return stretchesOf(first).some(([a, b]) => theirs.some(([c, d]) => {
    const along = a.y === b.y && c.y === d.y && a.y === c.y
      ? 'x'
      : a.x === b.x && c.x === d.x && a.x === c.x ? 'y' : null
    if (!along) {
      return false
    }

    const overlap = Math.min(Math.max(a[along], b[along]), Math.max(c[along], d[along]))
      - Math.max(Math.min(a[along], b[along]), Math.min(c[along], d[along]))
    return overlap > 1
  }))
}

/** Whether a straight stretch of one edge cuts across one of the other's, away from their ends. */
function crossEachOther(first: BracketEdge, second: BracketEdge): boolean {
  const cuts = (across: readonly [Point, Point], down: readonly [Point, Point]) => {
    const [a, b] = across
    const [c, d] = down
    return a.y === b.y && c.x === d.x
      && c.x > Math.min(a.x, b.x) && c.x < Math.max(a.x, b.x)
      && a.y > Math.min(c.y, d.y) && a.y < Math.max(c.y, d.y)
  }
  const ours = stretchesOf(first)
  const theirs = stretchesOf(second)
  return ours.some(stretch => theirs.some(other => cuts(stretch, other) || cuts(other, stretch)))
}

function middleOf(bracket: ModuleDependencyBracket): BracketCenterNode {
  const node = bracket.nodes.find(candidate => candidate.kind === 'center')
  assert.ok(node?.kind === 'center', 'the module in the middle is drawn')
  return node
}

describe('depth', () => {
  test('each side shows three levels unless asked otherwise, and a stub where it goes on', () => {
    assert.equal(DEFAULT_BRACKET_DEPTH, 3)

    const bracket = build(CHAIN, 'M5')

    assert.deepEqual(levelsOf(bracket, 'left'), [['M6'], ['M7'], ['M8']])
    assert.deepEqual(levelsOf(bracket, 'right'), [['M4'], ['M3'], ['M2']])
    assert.deepEqual(bracket.sides.left, {
      requested: 3, depth: 3, available: 4, hasMore: true, shown: 3, total: 4
    })
    assert.deepEqual(bracket.sides.right, {
      requested: 3, depth: 3, available: 4, hasMore: true, shown: 3, total: 4
    })
    assert.deepEqual(stubsOf(bracket, 'left'), [{ branch: 'M8', count: 1, level: 4 }])
    assert.deepEqual(stubsOf(bracket, 'right'), [{ branch: 'M2', count: 1, level: 4 }])
  })

  test('the two sides are asked for separately', () => {
    const bracket = build(CHAIN, 'M5', { left: 4, right: 1 })

    assert.deepEqual(levelsOf(bracket, 'left'), [['M6'], ['M7'], ['M8'], ['M9']])
    assert.equal(bracket.sides.left.hasMore, false)
    assert.deepEqual(stubsOf(bracket, 'left'), [])

    assert.deepEqual(levelsOf(bracket, 'right'), [['M4']])
    assert.equal(bracket.sides.right.hasMore, true)
    assert.deepEqual(stubsOf(bracket, 'right'), [{ branch: 'M4', count: 1, level: 2 }])
  })

  test('a side shows every level it has when asked for more, and at least one', () => {
    const deep = build(CHAIN, 'M5', { left: 99, right: 0 })
    assert.deepEqual(
      { requested: deep.sides.left.requested, depth: deep.sides.left.depth, hasMore: deep.sides.left.hasMore },
      { requested: 99, depth: 4, hasMore: false }
    )
    assert.deepEqual(
      { requested: deep.sides.right.requested, depth: deep.sides.right.depth },
      { requested: 1, depth: 1 }
    )

    const odd = build(CHAIN, 'M5', { left: Number.NaN, right: 2.7 })
    assert.equal(odd.sides.left.requested, DEFAULT_BRACKET_DEPTH)
    assert.equal(odd.sides.right.requested, 2)
  })

  test('a stub counts the distinct modules one level further along its own branch', () => {
    const fan = graph({
      C: ['A', 'B'],
      A: ['X', 'Y', 'Z', 'X'],
      B: ['Z'],
      X: [],
      Y: [],
      Z: []
    })
    const bracket = build(fan, 'C', { left: 1 })

    // Z waits beyond both branches, and each stub counts it: a stub says what
    // lies past its own branch, not what no other branch reaches.
    assert.deepEqual(stubsOf(bracket, 'left'), [
      { branch: 'A', count: 3, level: 2 },
      { branch: 'B', count: 1, level: 2 }
    ])
    assert.equal(bracket.sides.left.total, 5)

    const stub = bracket.nodes.find(node => node.kind === 'stub' && node.parentId === getBracketModuleNodeId('left', 'A'))
    assert.ok(stub)
    const branch = nodeOf(bracket, 'left', 'A')
    assert.equal(centerY(stub), centerY(branch), 'a stub stands beside the branch it ends')
    assert.ok(stub.position.x + stub.width < branch.position.x, 'one column further out')
    assert.ok(edgeBetween(bracket, stub.id, branch.id)?.kind === 'stub')
  })
})

describe('cycles', () => {
  test('a direct cycle: the other module stands on both sides, flagged, its imports numbered', () => {
    const pair = graph(
      { OrderModule: ['PaymentModule'], PaymentModule: ['OrderModule'] },
      { cycles: [cycle(1, ['OrderModule', 'PaymentModule', 'OrderModule'])] }
    )
    const bracket = build(pair, 'OrderModule')
    const left = nodeOf(bracket, 'left', 'PaymentModule')
    const right = nodeOf(bracket, 'right', 'PaymentModule')

    assert.equal(left.isOnCycleWithCenter, true)
    assert.equal(right.isOnCycleWithCenter, true)
    assert.equal(middleOf(bracket).isOnCycle, true)

    // OrderModule imports PaymentModule, drawn on the left; PaymentModule
    // imports OrderModule, drawn on the right. Each once, each a step of #1.
    assert.deepEqual(edgeBetween(bracket, left.id, BRACKET_CENTER_ID)?.cycleIds, [1])
    assert.deepEqual(edgeBetween(bracket, BRACKET_CENTER_ID, right.id)?.cycleIds, [1])
    assert.ok(edgeBetween(bracket, left.id, BRACKET_CENTER_ID)?.label)
    assert.equal(bracket.edges.length, 2, 'no import back into the middle is drawn twice')
  })

  test('the shop: both cycles through OrderModule, at every depth, without going round', () => {
    const bracket = build(SHOP, 'OrderModule', { left: 99, right: 99 })

    assert.deepEqual(levelsOf(bracket, 'left'), [
      ['CustomerLoyaltyModule', 'DatabaseModule', 'PaymentModule', 'StoreProductModule', 'VoucherModule'],
      ['CustomerModule', 'ProductModule', 'StoreModule'],
      ['RecommendationModule']
    ])
    assert.deepEqual(levelsOf(bracket, 'right'), [
      ['AppModule', 'PaymentModule', 'RecommendationModule'],
      ['ProductModule'],
      ['StoreProductModule']
    ])
    assert.equal(bracket.sides.left.available, 3)
    assert.equal(bracket.sides.right.available, 3)

    const onCycle = (side: BracketSide) =>
      modulesOn(bracket, side).filter(node => node.isOnCycleWithCenter).map(node => node.moduleName).sort()
    const cycleModules = ['PaymentModule', 'ProductModule', 'RecommendationModule', 'StoreProductModule']
    assert.deepEqual(onCycle('left'), cycleModules)
    assert.deepEqual(onCycle('right'), cycleModules)

    // Every step of both cycles is drawn on each side it shows on, numbered.
    const id = (side: BracketSide, moduleName: string) => getBracketModuleNodeId(side, moduleName)
    assert.deepEqual(edgeBetween(bracket, id('left', 'PaymentModule'), BRACKET_CENTER_ID)?.cycleIds, [1])
    assert.deepEqual(edgeBetween(bracket, id('left', 'StoreProductModule'), BRACKET_CENTER_ID)?.cycleIds, [2])
    assert.deepEqual(edgeBetween(bracket, id('left', 'ProductModule'), id('left', 'StoreProductModule'))?.cycleIds, [2])
    assert.deepEqual(edgeBetween(bracket, id('left', 'RecommendationModule'), id('left', 'ProductModule'))?.cycleIds, [2])
    assert.deepEqual(edgeBetween(bracket, BRACKET_CENTER_ID, id('right', 'PaymentModule'))?.cycleIds, [1])
    assert.deepEqual(edgeBetween(bracket, BRACKET_CENTER_ID, id('right', 'RecommendationModule'))?.cycleIds, [2])
    assert.deepEqual(edgeBetween(bracket, id('right', 'RecommendationModule'), id('right', 'ProductModule'))?.cycleIds, [2])
    assert.deepEqual(edgeBetween(bracket, id('right', 'ProductModule'), id('right', 'StoreProductModule'))?.cycleIds, [2])
    assert.deepEqual(edgeBetween(bracket, id('left', 'VoucherModule'), BRACKET_CENTER_ID)?.cycleIds, [])

    // An import back into the middle is never drawn on its own side.
    assert.ok(bracket.edges.every(edge => edge.kind === 'tree'
      || (edge.source !== BRACKET_CENTER_ID && edge.target !== BRACKET_CENTER_ID)))
    for (const edge of bracket.edges) {
      assert.equal(Boolean(edge.label), edge.cycleIds.length > 0, `${edge.id} is labelled only on a cycle`)
    }
  })

  test('imports between modules already drawn are dashed links, never a module drawn twice', () => {
    const bracket = build(SHOP, 'OrderModule')
    const links = bracket.edges.filter(edge => edge.kind === 'link')
    const id = (side: BracketSide, moduleName: string) => getBracketModuleNodeId(side, moduleName)

    // On the left, everything drawn imports DatabaseModule, and VoucherModule
    // imports CustomerLoyaltyModule; on the right, AppModule imports every
    // module drawn there.
    assert.deepEqual(
      links.filter(edge => edge.side === 'left').map(edge => [edge.source, edge.target]).sort(),
      [
        [id('left', 'CustomerLoyaltyModule'), id('left', 'VoucherModule')],
        [id('left', 'DatabaseModule'), id('left', 'CustomerLoyaltyModule')],
        [id('left', 'DatabaseModule'), id('left', 'CustomerModule')],
        [id('left', 'DatabaseModule'), id('left', 'PaymentModule')],
        [id('left', 'DatabaseModule'), id('left', 'ProductModule')],
        [id('left', 'DatabaseModule'), id('left', 'RecommendationModule')],
        [id('left', 'DatabaseModule'), id('left', 'StoreModule')],
        [id('left', 'DatabaseModule'), id('left', 'StoreProductModule')],
        [id('left', 'DatabaseModule'), id('left', 'VoucherModule')]
      ].sort()
    )
    assert.deepEqual(
      links.filter(edge => edge.side === 'right').map(edge => [edge.source, edge.target]).sort(),
      [
        [id('right', 'PaymentModule'), id('right', 'AppModule')],
        [id('right', 'ProductModule'), id('right', 'AppModule')],
        [id('right', 'RecommendationModule'), id('right', 'AppModule')],
        [id('right', 'StoreProductModule'), id('right', 'AppModule')]
      ].sort()
    )

    const names = (side: BracketSide) => modulesOn(bracket, side).map(node => node.moduleName)
    for (const side of ['left', 'right'] as const) {
      assert.equal(new Set(names(side)).size, names(side).length, `no module twice on the ${side}`)
    }

    // A link within a column runs round its outer side; one back towards the
    // middle comes into its module from the far side.
    const sameColumn = edgeBetween(bracket, id('left', 'DatabaseModule'), id('left', 'VoucherModule'))
    assert.deepEqual([sameColumn?.sourceHandle, sameColumn?.targetHandle], ['left-source', 'left-target'])
    const backwards = edgeBetween(bracket, id('left', 'DatabaseModule'), id('left', 'RecommendationModule'))
    assert.deepEqual([backwards?.sourceHandle, backwards?.targetHandle], ['left-source', 'right-target'])
    const rightSameColumn = edgeBetween(bracket, id('right', 'PaymentModule'), id('right', 'AppModule'))
    assert.deepEqual([rightSameColumn?.sourceHandle, rightSameColumn?.targetHandle], ['right-source', 'right-target'])
  })

  test('a module importing itself is a loop, in the middle and on a side', () => {
    const selfish = graph(
      { A: ['A', 'B'], B: [], C: ['A'] },
      { cycles: [cycle(3, ['A', 'A'])] }
    )

    const centred = build(selfish, 'A')
    const loop = centred.edges.find(edge => edge.kind === 'self')
    assert.equal(loop?.source, BRACKET_CENTER_ID)
    assert.equal(loop?.side, null)
    assert.deepEqual(loop?.cycleIds, [3])
    assert.ok(loop?.label)
    assert.deepEqual(levelsOf(centred, 'left'), [['B']])
    assert.deepEqual(levelsOf(centred, 'right'), [['C']])
    const center = middleOf(centred)
    assert.equal(center.isOnCycle, true)
    assert.ok(loop && loop.path.length > 0)
    assert.ok(centred.bounds.y < center.position.y, 'the loop above the middle is framed')

    const beside = build(selfish, 'C')
    const sideLoop = beside.edges.find(edge => edge.kind === 'self')
    assert.equal(sideLoop?.source, getBracketModuleNodeId('left', 'A'))
    assert.equal(sideLoop?.side, 'left')
    assert.deepEqual(levelsOf(beside, 'left'), [['A'], ['B']])
  })
})

describe('the bracket', () => {
  test('a module the graph does not have has no bracket', () => {
    assert.equal(buildModuleDependencyBracket({
      graph: SHOP,
      center: 'MissingModule',
      depth: { left: 3, right: 3 }
    }), null)
    // Not a property every object has, either.
    assert.equal(buildModuleDependencyBracket({
      graph: SHOP,
      center: 'toString',
      depth: { left: 3, right: 3 }
    }), null)
  })

  test('a side with no module on it stands one empty card in, and draws nothing else', () => {
    const bracket = build(SHOP, 'DatabaseModule')
    assert.deepEqual(bracket.sides.left, {
      requested: 3, depth: 0, available: 0, hasMore: false, shown: 0, total: 0
    })
    const empty = bracket.nodes.filter(node => node.kind === 'empty')
    assert.deepEqual(empty.map(node => node.side), ['left'])
    assert.equal(bracket.nodes.filter(node => node.kind === 'level' && node.side === 'left').length, 0)
    assert.equal(levelsOf(bracket, 'right')[0]?.length, 11, 'everything imports DatabaseModule')

    const lonely = build(graph({ Lonely: [] }), 'Lonely')
    assert.deepEqual(lonely.nodes.map(node => node.kind).sort(), ['center', 'empty', 'empty'])
    assert.deepEqual(lonely.edges, [])
  })

  test('the card in the middle says what the module holds and what Direct Run can call', () => {
    const run = { methods: [{ name: 'run', parameterTypes: '[]' }] }
    const withItems: BracketGraph = {
      ...SHOP,
      modules: {
        ...SHOP.modules,
        OrderModule: module(SHOP.modules.OrderModule?.imports ?? [], {
          exports: ['OrderService'],
          providers: [
            { name: 'OrderService', dependencies: [], directRun: run },
            { name: 'OrderRepository', dependencies: [] }
          ],
          controllers: [{ name: 'OrderController', dependencies: [], directRun: run }]
        })
      }
    }
    const center = middleOf(build(withItems, 'OrderModule'))

    assert.deepEqual(center.stats, {
      providers: 2,
      controllers: 1,
      imports: 5,
      exports: 1,
      runnableNodeIds: [
        'provider-OrderModule-OrderService',
        'controller-OrderModule-OrderController'
      ]
    })
    assert.equal(center.isRoot, false)
    assert.equal(middleOf(build(SHOP, 'AppModule')).isRoot, true)
    assert.equal(nodeOf(build(SHOP, 'OrderModule'), 'right', 'AppModule').isRoot, true)
  })

  test('columns run out from the middle, a branch never crosses another, and nothing overlaps', () => {
    for (const center of Object.keys(SHOP.modules)) {
      for (const depth of [1, 2, 3, 99]) {
        const bracket = build(SHOP, center, { left: depth, right: depth })
        const middle = bracket.nodes.find(node => node.kind === 'center')
        assert.ok(middle)

        for (const node of bracket.nodes) {
          if (node.kind !== 'module' && node.kind !== 'stub') {
            continue
          }
          if (node.side === 'left') {
            assert.ok(node.position.x + node.width < middle.position.x, `${node.id} is left of the middle`)
          } else {
            assert.ok(node.position.x > middle.position.x + middle.width, `${node.id} is right of the middle`)
          }
        }

        // Boxes on the canvas never overlap.
        const boxes = bracket.nodes.filter(node => node.kind !== 'level')
        for (const [index, box] of boxes.entries()) {
          for (const other of boxes.slice(index + 1)) {
            const overlaps = box.position.x < other.position.x + other.width
              && other.position.x < box.position.x + box.width
              && box.position.y < other.position.y + other.height
              && other.position.y < box.position.y + box.height
            assert.equal(overlaps, false, `${box.id} overlaps ${other.id} (centre ${center}, depth ${depth})`)
          }
        }

        // A bracket: each module stands level with its own branch, which
        // keeps to its own rows.
        for (const side of ['left', 'right'] as const) {
          const nodes = modulesOn(bracket, side)
          const byId = new Map(nodes.map(node => [node.id, node]))
          for (const node of nodes) {
            const children = bracket.edges
              .filter(edge => edge.kind === 'tree' && (side === 'left' ? edge.target : edge.source) === node.id)
              .map(edge => byId.get(side === 'left' ? edge.source : edge.target))
              .filter((child): child is BracketModuleNode => Boolean(child))
            if (children.length === 0) {
              continue
            }
            const ys = children.map(centerY)
            assert.ok(
              centerY(node) >= Math.min(...ys) - 0.001 && centerY(node) <= Math.max(...ys) + 0.001,
              `${node.id} stands level with its branch`
            )
          }
        }

        // No edge passes behind a card it does not join.
        for (const edge of bracket.edges.filter(candidate => candidate.kind !== 'self')) {
          assert.deepEqual(cardsCrossed(bracket, edge), [], `${edge.id} passes behind cards (centre ${center}, depth ${depth})`)
        }

        const ids = new Set(bracket.nodes.map(node => node.id))
        assert.equal(ids.size, bracket.nodes.length, 'node ids are unique')
        assert.equal(new Set(bracket.edges.map(edge => edge.id)).size, bracket.edges.length, 'edge ids are unique')
        for (const edge of bracket.edges) {
          assert.ok(ids.has(edge.source) && ids.has(edge.target), `${edge.id} joins drawn nodes`)
          assert.ok(edge.path.startsWith('M '), `${edge.id} has a path`)
        }

        // Cycle labels cover no card, and no other label.
        const labels = bracket.edges.flatMap(edge => edge.label
          ? [{ id: edge.id, box: getCircularLabelBox(edge.label, formatCircularEdgeLabel(edge.cycleIds)) }]
          : [])
        for (const [index, label] of labels.entries()) {
          for (const other of labels.slice(index + 1)) {
            assert.equal(
              boxesOverlap(label.box, other.box), false,
              `${label.id}'s label overlaps ${other.id}'s (centre ${center}, depth ${depth})`
            )
          }
          for (const node of boxes) {
            assert.equal(
              boxesOverlap(label.box, { ...node.position, width: node.width, height: node.height }), false,
              `${label.id}'s label covers ${node.id} (centre ${center}, depth ${depth})`
            )
          }
        }

        const { bounds } = bracket
        for (const node of bracket.nodes) {
          assert.ok(
            node.position.x >= bounds.x && node.position.y >= bounds.y
            && node.position.x + node.width <= bounds.x + bounds.width
            && node.position.y + node.height <= bounds.y + bounds.height,
            `${node.id} is inside the bounds`
          )
        }
      }
    }
  })

  test('a link back over a column goes round its cards, never behind one', () => {
    // E, two columns out, imports A, which stands in the first column level
    // with its only child B: a straight run from A would pass behind B.
    const detour = graph({
      Center: ['A', 'C'],
      A: ['B'],
      B: [],
      C: ['D'],
      D: ['E'],
      E: ['A']
    })
    const bracket = build(detour, 'Center')
    const link = edgeBetween(bracket, getBracketModuleNodeId('left', 'A'), getBracketModuleNodeId('left', 'E'))

    assert.ok(link, 'the link from A to E is drawn')
    assert.equal(link.kind, 'link')
    assert.deepEqual(cardsCrossed(bracket, link), [])
    assert.equal(
      centerY(nodeOf(bracket, 'left', 'A')), centerY(nodeOf(bracket, 'left', 'B')),
      'B stands level with A, in the way of a straight run'
    )

    // The same on the right, and on a graph far larger.
    const mirrored = build(graph({ A: ['Center'], B: ['A'], C: ['Center'], D: ['C'], E: ['D'], Center: [] }, {}), 'Center')
    for (const edge of mirrored.edges.filter(candidate => candidate.kind !== 'self')) {
      assert.deepEqual(cardsCrossed(mirrored, edge), [], edge.id)
    }
    const large = syntheticGraph(300)
    for (const center of ['L4M7', 'L9M29']) {
      const wide = build(large, center, { left: 99, right: 99 })
      for (const edge of wide.edges.filter(candidate => candidate.kind !== 'self')) {
        assert.deepEqual(cardsCrossed(wide, edge), [], `${edge.id} (centre ${center})`)
      }
    }
  })

  test('a cycle keeps its own line from module to module: its own port, off the shared upright', () => {
    let cycleStepsSeen = 0

    for (const center of Object.keys(SHOP.modules)) {
      for (const depth of [1, 3, 99]) {
        const bracket = build(SHOP, center, { left: depth, right: depth })
        const byId = new Map(bracket.nodes.map(node => [node.id, node]))
        const branches = bracket.edges.filter(edge => edge.kind === 'tree' && edge.cycleIds.length === 0)
        const cycleSteps = bracket.edges.filter(edge => edge.kind === 'tree' && edge.cycleIds.length > 0)
        cycleStepsSeen += cycleSteps.length

        for (const step of cycleSteps) {
          // It comes into the module nearer the middle by a port of its own,
          // up or down that module's side, never the middle the bracket's
          // connectors share.
          const route = routeOf(step.path)
          const parent = byId.get(step.side === 'left' ? step.target : step.source)
          const port = step.side === 'left' ? route.at(-1) : route[0]
          assert.ok(parent && port, step.id)
          assert.notEqual(port.y, centerY(parent), `${step.id} comes in by the shared port (centre ${center})`)
          assert.ok(Math.abs(port.y - centerY(parent)) < parent.height / 2, `${step.id} comes in on its module's side`)

          // Nowhere does it run along a blue connector, even one meeting it at a card.
          for (const branch of branches) {
            assert.ok(!runAlongEachOther(step, branch), `${step.id} runs along ${branch.id} (centre ${center}, depth ${depth})`)
          }

          // And the steps coming into one module nest: none cuts across another.
          for (const other of cycleSteps.filter(candidate => candidate !== step)) {
            const sameModule = (step.side === 'left' ? step.target : step.source)
              === (other.side === 'left' ? other.target : other.source)
            if (sameModule && step.side === other.side) {
              assert.ok(!crossEachOther(step, other), `${step.id} cuts across ${other.id} (centre ${center})`)
            }
          }
        }
      }
    }

    assert.ok(cycleStepsSeen > 0, 'the shop graph puts connectors on its cycles')
  })

  test('no two edges joining no card in common run along one stretch', () => {
    // DatabaseModule in the middle stands every other module in one column,
    // joined by a score of links that all turn beside it.
    for (const center of Object.keys(SHOP.modules)) {
      for (const depth of [1, 2, 3, 99]) {
        const bracket = build(SHOP, center, { left: depth, right: depth })
        assert.deepEqual(sharedStretches(bracket), [], `centre ${center}, depth ${depth}`)
      }
    }
  })

  test('siblings follow where all their parents stand, the first column follows names', () => {
    const crossing = graph({
      C: ['P2', 'P1'],
      P1: ['A', 'B'],
      P2: ['A'],
      A: [],
      B: []
    })
    const bracket = build(crossing, 'C')

    // B's only parent is P1, at the top; A's are P1 and P2, so A goes below B
    // though it comes first by name.
    assert.deepEqual(levelsOf(bracket, 'left'), [['P1', 'P2'], ['B', 'A']])
    assert.equal(
      bracket.edges.find(edge => edge.kind === 'link')?.source,
      getBracketModuleNodeId('left', 'A')
    )
  })

  test('every column drawn has a heading counting its modules', () => {
    const bracket = build(SHOP, 'OrderModule')
    const headings = bracket.nodes
      .filter(node => node.kind === 'level')
      .map(node => node.kind === 'level' ? [node.side, node.level, node.moduleCount] : [])

    assert.deepEqual(headings, [
      ['left', 1, 5], ['left', 2, 3], ['left', 3, 1],
      ['right', 1, 3], ['right', 2, 1], ['right', 3, 1]
    ])
  })

  test('the same graph lays out the same way every time', () => {
    assert.deepEqual(build(SHOP, 'ProductModule', { left: 4, right: 2 }), build(SHOP, 'ProductModule', { left: 4, right: 2 }))
  })

  test('a graph of 300 modules lays out well within a frame', (context) => {
    const large = syntheticGraph(300)
    const centers = ['L0M0', 'L4M7', 'L9M29']
    const timings: number[] = []

    for (const center of centers) {
      for (const depth of [3, 99]) {
        const started = performance.now()
        const bracket = build(large, center, { left: depth, right: depth })
        timings.push(performance.now() - started)

        assert.equal(modulesOn(bracket, 'left').length, bracket.sides.left.shown)
        assert.equal(modulesOn(bracket, 'right').length, bracket.sides.right.shown)
      }
    }

    // Well under 50 ms on a developer machine; bounded generously so a busy CI
    // runner does not fail it.
    const slowest = Math.max(...timings)
    context.diagnostic(`300 modules: slowest of ${timings.length} layouts ${slowest.toFixed(1)} ms`)
    assert.ok(slowest < 250, `the slowest layout took ${slowest.toFixed(1)} ms`)
  })
})

/**
 * `count` modules in ten layers, each importing three in the layer below and,
 * every seventh one, one two layers above it — enough cycles to walk round.
 * Deterministic: a fixed linear congruential sequence picks the imports.
 */
function syntheticGraph(count: number): BracketGraph {
  const perLayer = count / 10
  const name = (layer: number, index: number) => `L${layer}M${index}`
  let seed = 42
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed
  }

  const imports: Record<string, string[]> = {}
  for (let layer = 0; layer < 10; layer += 1) {
    for (let index = 0; index < perLayer; index += 1) {
      const own: string[] = []
      if (layer < 9) {
        for (let pick = 0; pick < 3; pick += 1) {
          own.push(name(layer + 1, next() % perLayer))
        }
      }
      if (layer >= 2 && index % 7 === 0) {
        own.push(name(layer - 2, next() % perLayer))
      }
      imports[name(layer, index)] = own
    }
  }

  return graph(imports, { root: name(0, 0) })
}
