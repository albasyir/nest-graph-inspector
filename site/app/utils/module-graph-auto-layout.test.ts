import { strict as assert } from 'node:assert'
import { before, describe, test } from 'node:test'
import type { ElkNode } from 'elkjs/lib/elk-api'
import type { GraphOutput } from 'nest-graph-inspector'
import {
  CIRCULAR_LABEL_MAX_SCALE,
  getCircularLabelBox,
  placeRouteLabels
} from './circular-dependency-edge.ts'
import {
  createSharedElkEngineSource,
  failureSignal,
  lazyElkEngineSource,
  type RunningElk
} from './elk-engine-source.ts'
import { LAYOUT_GEOMETRY } from './graph-layout-placement.ts'
import {
  AUTO_LAYOUT_ENGINE_READY_MEASURE,
  AUTO_LAYOUT_MEASURE,
  ElkEngineFailure,
  ROUTE_GAP,
  ROUTE_MODULE_CLEARANCE,
  WARM_UP_LAYOUT_INPUT,
  autoLayoutModuleGraph,
  autoLayoutTimingDetail,
  bundledElkSource,
  importRouteKey,
  layoutModuleGraphWithElk,
  layoutModuleRows,
  moduleGraphLayoutInput,
  recordUserTiming,
  toElkGraph,
  type ElkEngine,
  type ElkEngineSource,
  type ElkRuntime,
  type LayoutPoint,
  type ModuleGraphAutoLayout,
  type ModuleGraphLayoutInput,
  type ModulePositions
} from './module-graph-auto-layout.ts'

/**
 * The demo's Shop App, as `site/public/nodepod-demo/graph.json` exports it:
 * the root importing every feature module, the global DatabaseModule in every
 * module's imports, Nest's own core module on its own, and two cycles —
 * Order ⇄ Payment, and Order → StoreProduct → Product → Recommendation → Order.
 */
const SHOP_APP_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  AppModule: [
    'DatabaseModule',
    'AuthModule',
    'CustomerModule',
    'CustomerLoyaltyModule',
    'OrderModule',
    'PaymentModule',
    'ProductModule',
    'RecommendationModule',
    'StoreModule',
    'StoreProductModule',
    'VoucherModule'
  ],
  DatabaseModule: [],
  AuthModule: ['CustomerModule', 'DatabaseModule'],
  CustomerModule: ['DatabaseModule'],
  CustomerLoyaltyModule: ['CustomerModule', 'DatabaseModule'],
  OrderModule: [
    'StoreProductModule',
    'VoucherModule',
    'CustomerLoyaltyModule',
    'PaymentModule',
    'DatabaseModule'
  ],
  StoreProductModule: ['ProductModule', 'StoreModule', 'DatabaseModule'],
  ProductModule: ['RecommendationModule', 'DatabaseModule'],
  RecommendationModule: ['OrderModule', 'DatabaseModule'],
  StoreModule: ['DatabaseModule'],
  VoucherModule: ['CustomerLoyaltyModule', 'DatabaseModule'],
  PaymentModule: ['OrderModule', 'DatabaseModule'],
  NestJSCoreModule: []
}

/** The modules on each cycle; an import between two of them may point up. */
const SHOP_APP_CYCLES: readonly (readonly string[])[] = [
  ['OrderModule', 'PaymentModule'],
  ['OrderModule', 'StoreProductModule', 'ProductModule', 'RecommendationModule']
]

/** Every module collapsed, as the navigator opens a graph. */
const COLLAPSED = { width: 240, height: 40 }

/**
 * Boxes of every size an open module comes in — wide rows of items, tall
 * hierarchies — so overlap is tested on more than one shape.
 */
function variedSize(index: number): { width: number, height: number } {
  return {
    width: 240 + (index % 3) * 252,
    height: 40 + (index % 4) * 104
  }
}

function shopApp(
  sizeOf: (index: number) => { width: number, height: number } = () => COLLAPSED
): ModuleGraphLayoutInput {
  return graphInput({ imports: SHOP_APP_IMPORTS, root: 'AppModule', sizeOf })
}

function graphInput(params: {
  imports: Readonly<Record<string, readonly string[]>>
  root: string
  sizeOf?: (index: number) => { width: number, height: number }
}): ModuleGraphLayoutInput {
  const { imports, root, sizeOf = () => COLLAPSED } = params

  return {
    root,
    modules: Object.keys(imports).map((name, index) => ({
      name,
      ...sizeOf(index)
    })),
    imports: Object.entries(imports).flatMap(([importer, imported]) =>
      imported.map(name => ({ importer, imported: name }))
    )
  }
}

type Box = { name: string, x: number, y: number, width: number, height: number }

function boxes(input: ModuleGraphLayoutInput, positions: ModulePositions): Box[] {
  return input.modules.map((module) => {
    const position = positions.get(module.name)
    assert.ok(position, `${module.name} has a position`)
    return { name: module.name, ...position, width: module.width, height: module.height }
  })
}

function boxOf(input: ModuleGraphLayoutInput, positions: ModulePositions, name: string): Box {
  const box = boxes(input, positions).find(candidate => candidate.name === name)
  assert.ok(box, `${name} is laid out`)
  return box
}

/** The modules in each layer, top first, by name: a layer is one `y`. */
function layers(positions: ModulePositions): string[][] {
  const tops = [...new Set([...positions.values()].map(position => position.y))]
    .sort((left, right) => left - right)

  return tops.map(top =>
    [...positions]
      .filter(([, position]) => position.y === top)
      .map(([name]) => name)
      .sort()
  )
}

function closesCycle(importer: string, imported: string): boolean {
  return SHOP_APP_CYCLES.some(cycle => cycle.includes(importer) && cycle.includes(imported))
}

function assertNoOverlap(laidOut: readonly Box[]): void {
  for (const [index, box] of laidOut.entries()) {
    for (const other of laidOut.slice(index + 1)) {
      const apart
        = box.x + box.width <= other.x
          || other.x + other.width <= box.x
          || box.y + box.height <= other.y
          || other.y + other.height <= box.y
      assert.ok(apart, `${box.name} and ${other.name} overlap`)
    }
  }
}

/** A fresh ELK for every layout, so runs share nothing. */
async function freshElk(): Promise<ElkEngine> {
  const { default: Elk } = await import('elkjs/lib/elk.bundled.js')
  const elk = new Elk()
  return { runtime: 'main-thread', layout: graph => elk.layout(graph) }
}

/**
 * A source handing out the engine `start` makes, saying it is warm or not —
 * one that is not comes up as soon as it is asked for — and counting how often
 * it is asked for one.
 */
function sourceOf(params: { start: () => Promise<ElkEngine>, isReady?: boolean }) {
  let acquired = 0
  const engines: ElkEngineSource = {
    isReady: () => params.isReady ?? false,
    acquire: () => {
      acquired += 1
      return params.start()
    },
    whenReady: () => Promise.resolve()
  }

  return { engines, acquired: () => acquired }
}

/** A source over a stand-in ELK that answers with `layout`. */
function standIn(layout: ElkEngine['layout'], runtime: ElkRuntime = 'worker') {
  return sourceOf({ start: () => Promise.resolve({ runtime, layout }) })
}

/** An answer placing every module side by side, as a stand-in ELK gives it. */
function sideBySide(graph: ElkNode): ElkNode {
  return {
    ...graph,
    children: (graph.children ?? []).map((child, index) => ({
      ...child,
      x: index * 300,
      y: 0
    }))
  }
}

describe('the Shop App, laid out by ELK', () => {
  test('is laid out by ELK, every module at a finite point, cycles and all', async () => {
    const input = shopApp()
    const layout = await autoLayoutModuleGraph({
      input,
      engines: sourceOf({ start: freshElk }).engines
    })

    assert.equal(layout.engine, 'elk')
    assert.equal(layout.positions.size, input.modules.length)
    for (const [name, position] of layout.positions) {
      assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), `${name} is at a finite point`)
    }
  })

  test('puts the root alone in the top layer', async () => {
    const input = shopApp()
    const { positions } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const root = boxOf(input, positions, 'AppModule')

    for (const box of boxes(input, positions)) {
      if (box.name !== 'AppModule') {
        assert.ok(root.y + root.height <= box.y, `${box.name} is below the root`)
      }
    }
  })

  test('puts every importer above what it imports, but for the import closing each cycle', async () => {
    const input = shopApp()
    const { positions } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })

    for (const { importer, imported } of input.imports) {
      const above = boxOf(input, positions, importer)
      const below = boxOf(input, positions, imported)
      if (!closesCycle(importer, imported)) {
        assert.ok(above.y + above.height <= below.y, `${importer} is above ${imported}`)
      }
    }
  })

  test('draws each cycle down from OrderModule, with one import pointing back up', async () => {
    const input = shopApp()
    const { positions } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const top = (name: string) => boxOf(input, positions, name).y

    assert.ok(top('OrderModule') < top('PaymentModule'))
    assert.ok(top('OrderModule') < top('StoreProductModule'))
    assert.ok(top('StoreProductModule') < top('ProductModule'))
    assert.ok(top('ProductModule') < top('RecommendationModule'))
  })

  test('layers it as a flowchart of the imports would', async () => {
    const { positions } = await layoutModuleGraphWithElk({ input: shopApp(), elk: await freshElk() })

    assert.deepEqual(layers(positions), [
      ['AppModule'],
      ['AuthModule', 'OrderModule'],
      ['PaymentModule', 'StoreProductModule', 'VoucherModule'],
      ['CustomerLoyaltyModule', 'ProductModule', 'StoreModule'],
      ['CustomerModule', 'RecommendationModule'],
      // Imported by every module, the database is at the bottom; Nest's core
      // module, which nothing imports, sits there too instead of by the root.
      ['DatabaseModule', 'NestJSCoreModule']
    ])
  })

  test('keeps those layers with modules open at any size, each hung from its layer\'s top', async () => {
    const collapsed = await layoutModuleGraphWithElk({ input: shopApp(), elk: await freshElk() })
    const open = await layoutModuleGraphWithElk({ input: shopApp(variedSize), elk: await freshElk() })

    assert.deepEqual(layers(open.positions), layers(collapsed.positions))
  })

  test('overlaps no two modules, collapsed or open at any size', async () => {
    const elk = await freshElk()
    for (const input of [shopApp(), shopApp(variedSize)]) {
      const { positions } = await layoutModuleGraphWithElk({ input, elk })
      assertNoOverlap(boxes(input, positions))
    }
  })

  test('starts the drawing at the origin, in whole pixels', async () => {
    const { positions } = await layoutModuleGraphWithElk({ input: shopApp(variedSize), elk: await freshElk() })
    const corners = [...positions.values()]

    assert.equal(Math.min(...corners.map(corner => corner.x)), 0)
    assert.equal(Math.min(...corners.map(corner => corner.y)), 0)
    for (const corner of corners) {
      assert.ok(Number.isInteger(corner.x) && Number.isInteger(corner.y))
    }
  })

  test('lays the same graph out the same way every time', async () => {
    const input = shopApp(variedSize)
    const first = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const second = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const shared = await autoLayoutModuleGraph({ input, engines: bundledElkSource })

    assert.deepEqual([...second.positions], [...first.positions])
    assert.deepEqual([...second.routes], [...first.routes])
    assert.deepEqual([...shared.positions], [...first.positions])
  })
})

describe('the routes ELK gives the Shop App\'s imports', () => {
  test('run from the edge of each importer to the edge of the module it imports, square-cornered', async () => {
    const input = shopApp(variedSize)
    const { positions, routes } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const onEdgeOf = (point: LayoutPoint, box: Box) =>
      point.x >= box.x - 1 && point.x <= box.x + box.width + 1
      && point.y >= box.y - 1 && point.y <= box.y + box.height + 1
      && (Math.abs(point.y - box.y) <= 1 || Math.abs(point.y - (box.y + box.height)) <= 1
        || Math.abs(point.x - box.x) <= 1 || Math.abs(point.x - (box.x + box.width)) <= 1)

    assert.equal(routes.size, input.imports.length)
    for (const moduleImport of input.imports) {
      const route = routes.get(importRouteKey(moduleImport))
      assert.ok(route && route.length >= 2, `${moduleImport.importer} → ${moduleImport.imported} has a route`)
      const start = route[0]
      const end = route.at(-1)
      assert.ok(start && onEdgeOf(start, boxOf(input, positions, moduleImport.importer)))
      assert.ok(end && onEdgeOf(end, boxOf(input, positions, moduleImport.imported)))
      for (const [index, point] of route.slice(1).entries()) {
        const previous = route[index]
        assert.ok(previous && (previous.x === point.x || previous.y === point.y), 'every leg runs straight across or down')
      }
    }
  })
})

/** One straight leg of a route. */
type Leg = { from: LayoutPoint, to: LayoutPoint }

function legsOf(route: readonly LayoutPoint[]): Leg[] {
  return route.slice(1).flatMap((to, index) => {
    const from = route[index]
    return from ? [{ from, to }] : []
  })
}

/** Whether a leg runs through a box's inside, more than a pixel past its border. */
function entersBox({ from, to }: Leg, box: Box): boolean {
  return Math.min(from.x, to.x) < box.x + box.width - 1 && Math.max(from.x, to.x) > box.x + 1
    && Math.min(from.y, to.y) < box.y + box.height - 1 && Math.max(from.y, to.y) > box.y + 1
}

/** How far a leg passes from a box: 0 where it touches or enters it. */
function distanceToBox({ from, to }: Leg, box: Box): number {
  const dx = Math.max(box.x - Math.max(from.x, to.x), Math.min(from.x, to.x) - (box.x + box.width), 0)
  const dy = Math.max(box.y - Math.max(from.y, to.y), Math.min(from.y, to.y) - (box.y + box.height), 0)
  return Math.hypot(dx, dy)
}

/** How far apart two legs running side by side are; `Infinity` where they do not. */
function sideBySideGap(left: Leg, right: Leg): number {
  const isVertical = (leg: Leg) => leg.from.x === leg.to.x
  if (isVertical(left) !== isVertical(right)) {
    return Infinity
  }

  const along = isVertical(left) ? 'y' : 'x'
  const across = isVertical(left) ? 'x' : 'y'
  const start = (leg: Leg) => Math.min(leg.from[along], leg.to[along])
  const end = (leg: Leg) => Math.max(leg.from[along], leg.to[along])
  const shared = Math.min(end(left), end(right)) - Math.max(start(left), start(right))

  return shared > 0 ? Math.abs(left.from[across] - right.from[across]) : Infinity
}

function isOnLeg(point: LayoutPoint, { from, to }: Leg): boolean {
  return point.x >= Math.min(from.x, to.x) - 0.5 && point.x <= Math.max(from.x, to.x) + 0.5
    && point.y >= Math.min(from.y, to.y) - 0.5 && point.y <= Math.max(from.y, to.y) + 0.5
}

function isApart(left: Box, right: Box): boolean {
  return left.x + left.width <= right.x || right.x + right.width <= left.x
    || left.y + left.height <= right.y || right.y + right.height <= left.y
}

/**
 * The label on each pair of modules a cycle runs between, as the viewer puts
 * them: on one import of the pair, numbered as the issues page numbers the
 * cycles — Order → StoreProduct → Product → Recommendation → Order is #1, and
 * Order ⇄ Payment #2.
 */
const SHOP_APP_CYCLE_LABELS = [
  { importer: 'OrderModule', imported: 'StoreProductModule', text: '#1' },
  { importer: 'StoreProductModule', imported: 'ProductModule', text: '#1' },
  { importer: 'ProductModule', imported: 'RecommendationModule', text: '#1' },
  { importer: 'RecommendationModule', imported: 'OrderModule', text: '#1' },
  { importer: 'PaymentModule', imported: 'OrderModule', text: '#2' }
]

const SHOP_APP_SIZES = [
  ['every module collapsed', () => COLLAPSED],
  ['modules of every size', variedSize]
] as const

for (const [sizes, sizeOf] of SHOP_APP_SIZES) {
  describe(`the Shop App's routes, ${sizes}`, () => {
    const input = shopApp(sizeOf)
    let routes: ReadonlyMap<string, readonly LayoutPoint[]> = new Map()
    let modules: Box[] = []
    const routeOf = (importer: string, imported: string) =>
      routes.get(importRouteKey({ importer, imported })) ?? []

    before(async () => {
      const laidOut = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
      routes = laidOut.routes
      modules = boxes(input, laidOut.positions)
    })

    test('never pass through a module they do not join, the cycles\' imports among them', (t) => {
      let legs = 0
      for (const { importer, imported } of input.imports) {
        for (const leg of legsOf(routeOf(importer, imported))) {
          legs += 1
          for (const module of modules) {
            if (module.name !== importer && module.name !== imported) {
              assert.ok(!entersBox(leg, module), `${importer} → ${imported} passes through ${module.name}`)
            }
          }
        }
      }

      const cycleImports = input.imports.filter(({ importer, imported }) => closesCycle(importer, imported))
      assert.equal(routes.size, input.imports.length)
      assert.equal(cycleImports.length, 6)
      t.diagnostic(`${routes.size} routes, ${cycleImports.length} of them cycle imports: ${legs} legs × ${modules.length} modules, 0 through a module`)
    })

    test(`keep ${ROUTE_MODULE_CLEARANCE} px from every module they pass, their own away from where they meet it`, (t) => {
      let nearest = Infinity
      for (const { importer, imported } of input.imports) {
        const legs = legsOf(routeOf(importer, imported))
        for (const [index, leg] of legs.entries()) {
          for (const module of modules) {
            const meets = (index === 0 && module.name === importer)
              || (index === legs.length - 1 && module.name === imported)
            if (!meets) {
              nearest = Math.min(nearest, distanceToBox(leg, module))
            }
          }
        }
      }

      // Less a pixel: the drawing is moved onto whole pixels after ELK.
      assert.ok(nearest >= ROUTE_MODULE_CLEARANCE - 1, `a route passes ${nearest} px from a module`)
      t.diagnostic(`nearest a route passes a module: ${nearest} px`)
    })

    test(`keep ${ROUTE_GAP} px from the routes beside them`, (t) => {
      const legsByRoute = input.imports.map(({ importer, imported }) => legsOf(routeOf(importer, imported)))
      let nearest = Infinity
      for (const [index, legs] of legsByRoute.entries()) {
        for (const others of legsByRoute.slice(index + 1)) {
          for (const leg of legs) {
            for (const other of others) {
              nearest = Math.min(nearest, sideBySideGap(leg, other))
            }
          }
        }
      }

      assert.ok(nearest >= ROUTE_GAP - 1, `two routes run ${nearest} px apart`)
      t.diagnostic(`nearest two routes run side by side: ${nearest} px`)
    })

    test('meet each module at a point of their own', (t) => {
      const ends = input.imports.flatMap(({ importer, imported }) => {
        const route = routeOf(importer, imported)
        const start = route[0]
        const end = route.at(-1)
        return start && end ? [`${importer}@${start.x},${start.y}`, `${imported}@${end.x},${end.y}`] : []
      })

      assert.equal(ends.length, input.imports.length * 2)
      assert.equal(new Set(ends).size, ends.length, 'two routes meet a module at one point')
      t.diagnostic(`${ends.length} route ends, each at a point of its own`)
    })

    test('draw Order ⇄ Payment as two paths, apart', (t) => {
      const there = legsOf(routeOf('OrderModule', 'PaymentModule'))
      const back = legsOf(routeOf('PaymentModule', 'OrderModule'))
      const gap = Math.min(...there.flatMap(leg => back.map(other => sideBySideGap(leg, other))))

      assert.ok(there.length > 0 && back.length > 0)
      assert.notDeepEqual(there, back)
      assert.ok(gap >= ROUTE_GAP - 1, `the two run ${gap} px apart`)
      t.diagnostic(`Order ⇄ Payment: nearest the two paths run side by side: ${gap} px`)
    })

    test('carry the cycle labels on them, clear of every module and of each other at every zoom', (t) => {
      // As the viewer draws each cycle edge: from the module imported to its importer.
      const cycleRoutes = new Map(
        input.imports
          .filter(({ importer, imported }) => closesCycle(importer, imported))
          .map(moduleImport => [
            importRouteKey(moduleImport),
            [...routeOf(moduleImport.importer, moduleImport.imported)].reverse()
          ])
      )
      const labels = SHOP_APP_CYCLE_LABELS.map(({ importer, imported, text }) => {
        const key = importRouteKey({ importer, imported })
        return { key, text, route: cycleRoutes.get(key) ?? [] }
      })
      const placements = placeRouteLabels({ labels, obstacles: modules, lines: [...cycleRoutes.values()] })
      const placed = labels.map(({ key, text, route }) => {
        const spot = placements.get(key)
        assert.ok(spot, `${key} has a label`)
        assert.equal(spot.clearScale, CIRCULAR_LABEL_MAX_SCALE, `${key}'s label is clear at every zoom`)
        assert.ok(
          legsOf(route).some(leg => isOnLeg({ x: spot.labelX, y: spot.labelY }, leg)),
          `${key}'s label sits on its route`
        )
        return { name: key, ...getCircularLabelBox(spot, text, CIRCULAR_LABEL_MAX_SCALE) }
      })

      for (const label of placed) {
        for (const module of modules) {
          assert.ok(isApart(label, module), `${label.name}'s label covers ${module.name}`)
        }
      }
      assertNoOverlap(placed)
      // Keeping off the other cycles' lines is a preference, not a promise, so
      // it is counted rather than asserted.
      const onAnotherCycle = placed.filter(label => [...cycleRoutes].some(([key, route]) =>
        key !== label.name && legsOf(route).some(leg => distanceToBox(leg, label) === 0)
      ))
      t.diagnostic(`${placed.length} labels at ${CIRCULAR_LABEL_MAX_SCALE}× size: 0 on a module, 0 on another label, ${onAnotherCycle.length} over another cycle's line (${onAnotherCycle.map(label => label.name).join(', ') || 'none'})`)
    })
  })
}

describe('a larger graph', () => {
  /**
   * Forty modules in eight tiers, each importing two from the tier below, a
   * shared module every one imports, and a root importing the whole top tier
   * and a module further down each tier below — the shape of a real
   * application's graph.
   */
  function tieredApp(): ModuleGraphLayoutInput {
    const tiers = 8
    const perTier = 5
    const name = (tier: number, index: number) => `Tier${tier}Feature${index}Module`
    const rootImports: string[] = []
    const imports: Record<string, string[]> = {}
    for (let tier = 0; tier < tiers; tier += 1) {
      for (let index = 0; index < perTier; index += 1) {
        const below = tier + 1 < tiers
          ? [name(tier + 1, index), name(tier + 1, (index + 2) % perTier)]
          : []
        imports[name(tier, index)] = [...below, 'SharedModule']
        if (tier === 0 || index === tier % perTier) {
          rootImports.push(name(tier, index))
        }
      }
    }

    return graphInput({
      imports: { AppModule: rootImports, ...imports, SharedModule: [] },
      root: 'AppModule',
      sizeOf: variedSize
    })
  }

  test('keeps the root alone on top, importers above imports, and modules apart', async () => {
    const input = tieredApp()
    const { positions } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const root = boxOf(input, positions, 'AppModule')

    assert.equal(positions.size, input.modules.length)
    assertNoOverlap(boxes(input, positions))
    for (const box of boxes(input, positions)) {
      assert.ok(box.name === 'AppModule' || root.y + root.height <= box.y, `${box.name} is below the root`)
    }
    for (const { importer, imported } of input.imports) {
      const above = boxOf(input, positions, importer)
      assert.ok(above.y + above.height <= boxOf(input, positions, imported).y, `${importer} is above ${imported}`)
    }
  })

  test('shares the top layer with a part of the graph the root does not reach', async () => {
    // As when a viewer leaves out the module that imported them.
    const input = graphInput({
      imports: {
        AppModule: ['UsersModule'],
        UsersModule: [],
        ReportsModule: ['ExportModule'],
        ExportModule: []
      },
      root: 'AppModule'
    })
    const { positions } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const tops = boxes(input, positions).map(box => box.y)

    assert.equal(boxOf(input, positions, 'AppModule').y, Math.min(...tops))
    assert.ok(boxOf(input, positions, 'ReportsModule').y < boxOf(input, positions, 'ExportModule').y)
  })
})

describe('graphs with almost nothing in them', () => {
  test('an empty graph places nothing, and never starts ELK', async () => {
    const source = sourceOf({ start: freshElk })
    const told: string[] = []
    const layout = await autoLayoutModuleGraph({
      input: { root: 'AppModule', modules: [], imports: [] },
      engines: source.engines,
      onEngineReady: () => told.push('up')
    })

    assert.equal(layout.engine, 'none')
    assert.equal(layout.positions.size, 0)
    assert.equal(source.acquired(), 0)
    assert.deepEqual(told, [])
    assert.deepEqual(autoLayoutTimingDetail(layout), { engine: 'none', modules: 0 })
  })

  test('a graph of the root alone puts it at the origin', async () => {
    const layout = await autoLayoutModuleGraph({
      input: graphInput({ imports: { AppModule: [] }, root: 'AppModule' }),
      engines: sourceOf({ start: freshElk }).engines
    })

    assert.equal(layout.engine, 'elk')
    assert.deepEqual([...layout.positions], [['AppModule', { x: 0, y: 0 }]])
  })

  test('a module importing itself is laid out, the self-import ignored', async () => {
    const input = graphInput({
      imports: { AppModule: ['LoopModule'], LoopModule: ['LoopModule'] },
      root: 'AppModule'
    })
    const { positions } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })

    assert.ok(boxOf(input, positions, 'AppModule').y < boxOf(input, positions, 'LoopModule').y)
  })
})

describe('what ELK is given', () => {
  const graph = toElkGraph({
    root: 'AppModule',
    modules: [
      { name: 'FeatureModule', ...COLLAPSED },
      { name: 'AppModule', ...COLLAPSED },
      { name: 'LoneModule', ...COLLAPSED }
    ],
    imports: [
      { importer: 'AppModule', imported: 'FeatureModule' },
      { importer: 'AppModule', imported: 'FeatureModule' },
      { importer: 'FeatureModule', imported: 'FeatureModule' },
      { importer: 'FeatureModule', imported: 'MissingModule' }
    ]
  })

  test('is a top-down layered layout', () => {
    assert.equal(graph.layoutOptions?.['elk.algorithm'], 'layered')
    assert.equal(graph.layoutOptions?.['elk.direction'], 'DOWN')
  })

  test('has the root first, pinned to the top layer', () => {
    const [first] = graph.children ?? []
    assert.equal(first?.id, 'AppModule')
    assert.equal(first?.layoutOptions?.['elk.layered.layering.layerConstraint'], 'FIRST')
  })

  test('pins a module with no imports either way to the bottom layer', () => {
    const lone = graph.children?.find(child => child.id === 'LoneModule')
    const feature = graph.children?.find(child => child.id === 'FeatureModule')

    assert.equal(lone?.layoutOptions?.['elk.layered.layering.layerConstraint'], 'LAST')
    assert.equal(feature?.layoutOptions?.['elk.layered.layering.layerConstraint'], undefined)
  })

  test('hangs every module from the top of its layer', () => {
    for (const child of graph.children ?? []) {
      assert.equal(child.layoutOptions?.['elk.alignment'], 'TOP', child.id)
    }
  })

  test('has each import between two modules once, and no self-import', () => {
    assert.deepEqual(
      graph.edges?.map(edge => [edge.sources, edge.targets]),
      [[['AppModule'], ['FeatureModule']]]
    )
  })
})

/** Lets every callback already queued run. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Whether a promise has settled, waiting only for what is already queued. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  promise.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  await settle()
  return settled
}

/**
 * A stand-in worker for the page's shared source: each layout answers with the
 * modules side by side, only when told to, and the worker can die, as one
 * whose script did not load does.
 */
function standInWorker() {
  const { failure, fail, guard } = failureSignal()
  const unanswered: (() => void)[] = []
  const running: RunningElk = {
    engine: {
      runtime: 'worker',
      layout: graph => guard(() => new Promise<ElkNode>((resolve) => {
        unanswered.push(() => resolve(sideBySide(graph)))
      }))
    },
    failure
  }

  return {
    running,
    answerNext: async () => {
      unanswered.shift()?.()
      await settle()
    },
    die: () => fail(new Error('ELK\'s worker failed: its script did not load'))
  }
}

/** The page's shared source over stand-in workers, started one after another. */
function sharedSourceOver(workers: readonly ReturnType<typeof standInWorker>[]) {
  let starts = 0
  return createSharedElkEngineSource({
    startWorker: () => workers[starts++]?.running,
    startOnThisThread: () => Promise.reject(new Error('there is always a worker here')),
    warmUpGraph: toElkGraph(WARM_UP_LAYOUT_INPUT)
  })
}

type DrawnRow = { names: string[], left: number, right: number }

/** The drawing's rows, top first: the modules sharing a top, left to right, and where the row runs. */
function rowsOf(input: ModuleGraphLayoutInput, positions: ModulePositions): DrawnRow[] {
  const byTop = new Map<number, Box[]>()
  for (const box of boxes(input, positions)) {
    byTop.set(box.y, [...(byTop.get(box.y) ?? []), box])
  }

  return [...byTop.entries()]
    .sort(([top], [otherTop]) => top - otherTop)
    .map(([, row]) => ({
      names: [...row].sort((left, right) => left.x - right.x).map(box => box.name),
      left: Math.min(...row.map(box => box.x)),
      right: Math.max(...row.map(box => box.x + box.width))
    }))
}

function widthOf(row: DrawnRow): number {
  return row.right - row.left
}

/**
 * How wide a row of the Shop App's simple arrangement may run, every module
 * collapsed: four modules a row at most, as far apart as ELK sets modules —
 * where one row of all eleven the root imports ran 5,840 px.
 */
const SHOP_APP_ROW_WIDTH_LIMIT = 4 * COLLAPSED.width + 3 * LAYOUT_GEOMETRY.moduleGapY

/** The fallback for the Shop App: the simple arrangement, each layer wrapped. */
function assertShopAppWrapped(input: ModuleGraphLayoutInput, layout: ModuleGraphAutoLayout): void {
  assert.equal(layout.engine, 'rows')
  assert.deepEqual([...layout.positions], [...layoutModuleRows(input)])
  const rows = rowsOf(input, layout.positions)
  const widest = Math.max(...rows.map(widthOf))
  assert.ok(widest <= SHOP_APP_ROW_WIDTH_LIMIT, `the widest row runs ${widest} px`)
  for (const row of rows) {
    assert.ok(
      row.names.length < (SHOP_APP_IMPORTS.AppModule?.length ?? 0),
      `no row holds all the root imports: ${row.names.join(', ')}`
    )
  }
}

describe('falling back to the simple arrangement', () => {
  const input = shopApp()

  test('when ELK\'s module cannot be imported, as an engine failure', async () => {
    const engines = lazyElkEngineSource(() => Promise.reject(
      new TypeError('Failed to fetch dynamically imported module: https://example.test/_nuxt/engine.js')
    ))
    const layout = await autoLayoutModuleGraph({ input, engines })

    assertShopAppWrapped(input, layout)
    assert.deepEqual(autoLayoutTimingDetail(layout), {
      engine: 'rows',
      modules: input.modules.length,
      warm: false,
      reason: 'engine',
      error: 'Failed to fetch dynamically imported module: https://example.test/_nuxt/engine.js'
    })
  })

  test('when ELK\'s worker fails while it lays the graph out, as an engine failure', async () => {
    const worker = standInWorker()
    const pending = autoLayoutModuleGraph({ input, engines: sharedSourceOver([worker]) })
    await settle()
    worker.die()
    const layout = await pending

    assertShopAppWrapped(input, layout)
    assert.equal(layout.engine === 'rows' && layout.reason, 'engine')
    assert.ok(layout.engine === 'rows' && layout.error instanceof ElkEngineFailure)
  })

  test('when ELK cannot be started at all, as an engine failure', async () => {
    const layout = await autoLayoutModuleGraph({
      input,
      engines: sourceOf({ start: () => Promise.reject(new Error('no worker, and no bundled build')) }).engines
    })

    assertShopAppWrapped(input, layout)
    assert.equal(layout.engine === 'rows' && layout.reason, 'engine')
  })

  test('when the engine fails while it answers, as an engine failure', async () => {
    const layout = await autoLayoutModuleGraph({
      input,
      engines: standIn(() => Promise.reject(new ElkEngineFailure('ELK\'s worker failed'))).engines
    })

    assertShopAppWrapped(input, layout)
    assert.equal(layout.engine === 'rows' && layout.reason, 'engine')
  })

  test('when ELK throws, as a layout failure', async () => {
    const layout = await autoLayoutModuleGraph({
      input,
      engines: standIn(() => Promise.reject(new Error('ELK refused the graph'))).engines
    })

    assertShopAppWrapped(input, layout)
    assert.equal(layout.engine === 'rows' && layout.reason, 'layout')
  })

  test('when ELK answers without placing every module, as a layout failure', async () => {
    const layout = await autoLayoutModuleGraph({
      input,
      engines: standIn(graph => Promise.resolve({ ...sideBySide(graph), children: [] })).engines
    })

    assertShopAppWrapped(input, layout)
    assert.equal(layout.engine === 'rows' && layout.reason, 'layout')
  })
})

describe('no deadline', () => {
  const TEN_MINUTES = 10 * 60_000

  test('a slow ELK answering ten minutes on still places the modules', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const source = standIn(graph => new Promise((resolve) => {
      setTimeout(() => resolve(sideBySide(graph)), TEN_MINUTES)
    }))
    const pending = autoLayoutModuleGraph({ input: shopApp(), engines: source.engines })
    await settle()

    t.mock.timers.tick(TEN_MINUTES - 1)
    assert.equal(await hasSettled(pending), false)
    t.mock.timers.tick(1)

    assert.equal((await pending).engine, 'elk')
  })

  test('nor does an ELK whose module takes ten minutes to arrive', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const engines = lazyElkEngineSource(() => new Promise((resolve) => {
      setTimeout(() => resolve(standIn(graph => Promise.resolve(sideBySide(graph))).engines), TEN_MINUTES)
    }))
    const pending = autoLayoutModuleGraph({ input: shopApp(), engines })
    await settle()

    t.mock.timers.tick(TEN_MINUTES - 1)
    assert.equal(await hasSettled(pending), false)
    t.mock.timers.tick(1)

    assert.equal((await pending).engine, 'elk')
  })
})

describe('trying again after ELK failed', () => {
  const input = shopApp()

  test('starts a fresh worker in place of the one that died, and gets ELK\'s layout', async () => {
    const [dying, fresh] = [standInWorker(), standInWorker()]
    const engines = sharedSourceOver([dying, fresh])

    const first = autoLayoutModuleGraph({ input, engines })
    await settle()
    dying.die()
    assert.equal((await first).engine, 'rows')

    const retried = autoLayoutModuleGraph({ input, engines })
    await settle()
    await fresh.answerNext()

    assert.equal((await retried).engine, 'elk')
  })

  test('imports ELK\'s module again after its import failed, and gets ELK\'s layout', async () => {
    let imports = 0
    const engines = lazyElkEngineSource(() => {
      imports += 1
      return imports === 1
        ? Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
        : Promise.resolve(sourceOf({ start: freshElk }).engines)
    })

    assert.equal((await autoLayoutModuleGraph({ input, engines })).engine, 'rows')
    assert.equal((await autoLayoutModuleGraph({ input, engines })).engine, 'elk')
    assert.equal(imports, 2)
  })

  test('lays out on the same engine after ELK refused a graph once', async () => {
    let attempts = 0
    const source = standIn((graph) => {
      attempts += 1
      return attempts === 1
        ? Promise.reject(new Error('ELK refused the graph'))
        : Promise.resolve(sideBySide(graph))
    })

    assert.equal((await autoLayoutModuleGraph({ input, engines: source.engines })).engine, 'rows')
    assert.equal((await autoLayoutModuleGraph({ input, engines: source.engines })).engine, 'elk')
    assert.equal(source.acquired(), 2)
  })
})

describe('saying when ELK is up', () => {
  const input = shopApp()

  test('at once, when it already was', async () => {
    const told: string[] = []
    const layout = autoLayoutModuleGraph({
      input,
      engines: sourceOf({ start: freshElk, isReady: true }).engines,
      onEngineReady: () => told.push('up')
    }).then((laidOut) => {
      told.push('laid out')
      return laidOut
    })

    assert.equal((await layout).engine, 'elk')
    assert.deepEqual(told, ['up', 'laid out'])
  })

  test('once its warm-up answers, before this graph is laid out', async () => {
    const worker = standInWorker()
    const engines = sharedSourceOver([worker])
    const told: string[] = []
    engines.warmUp()

    const pending = autoLayoutModuleGraph({ input, engines, onEngineReady: () => told.push('up') })
    await settle()
    assert.deepEqual(told, [])

    await worker.answerNext()
    assert.deepEqual(told, ['up'])
    assert.equal(await hasSettled(pending), false)

    await worker.answerNext()
    const layout = await pending
    assert.equal(layout.engine === 'elk' && layout.warm, false)
    // Told once, however many layouts ELK then answers.
    assert.deepEqual(told, ['up'])
  })

  test('never, when ELK fails before it is up', async () => {
    const worker = standInWorker()
    const told: string[] = []

    const pending = autoLayoutModuleGraph({
      input,
      engines: sharedSourceOver([worker]),
      onEngineReady: () => told.push('up')
    })
    await settle()
    worker.die()

    assert.equal((await pending).engine, 'rows')
    await settle()
    assert.deepEqual(told, [])
  })
})

describe('what a layout says of the engine', () => {
  const input = shopApp()

  test('whether ELK was warm when the layout was asked for', async () => {
    for (const isReady of [true, false]) {
      const layout = await autoLayoutModuleGraph({
        input,
        engines: sourceOf({ start: freshElk, isReady }).engines
      })

      assert.equal(layout.engine === 'elk' && layout.warm, isReady)
    }
  })

  test('where ELK ran', async () => {
    const layout = await autoLayoutModuleGraph({
      input,
      engines: standIn(graph => Promise.resolve(sideBySide(graph)), 'worker').engines
    })

    assert.equal(layout.engine === 'elk' && layout.runtime, 'worker')
    assert.deepEqual(autoLayoutTimingDetail(layout), {
      engine: 'elk',
      modules: input.modules.length,
      warm: false,
      runtime: 'worker'
    })
  })
})

describe('the warm-up graph', () => {
  test('is laid out by ELK, its cycle and its module on its own included', async () => {
    const { positions } = await layoutModuleGraphWithElk({
      input: WARM_UP_LAYOUT_INPUT,
      elk: await freshElk()
    })
    const root = boxOf(WARM_UP_LAYOUT_INPUT, positions, 'AppModule')

    assert.equal(positions.size, WARM_UP_LAYOUT_INPUT.modules.length)
    assertNoOverlap(boxes(WARM_UP_LAYOUT_INPUT, positions))
    for (const box of boxes(WARM_UP_LAYOUT_INPUT, positions)) {
      assert.ok(box.name === 'AppModule' || root.y + root.height <= box.y)
    }
  })
})

describe('the simple arrangement', () => {
  test('puts the root alone on top, then what it imports, and what it does not reach at the bottom', () => {
    const input = shopApp()
    const rows = rowsOf(input, layoutModuleRows(input))

    assert.deepEqual(rows[0]?.names, ['AppModule'])
    assert.deepEqual(rows.at(-1)?.names, ['NestJSCoreModule'])
    assert.deepEqual(rows.slice(1, -1).flatMap(row => row.names), SHOP_APP_IMPORTS.AppModule)
  })

  test('wraps a layer of many modules into rows, in the graph\'s order, none the whole layer', () => {
    const input = shopApp()
    const rows = rowsOf(input, layoutModuleRows(input))
    const imported = rows.slice(1, -1)

    assert.ok(imported.length > 1, 'the root\'s imports take more than one row')
    assert.ok(Math.max(...rows.map(widthOf)) <= SHOP_APP_ROW_WIDTH_LIMIT)
    for (const row of imported) {
      assert.ok(row.names.length < (SHOP_APP_IMPORTS.AppModule?.length ?? 0))
    }
  })

  test('comes out a little wider than tall, open modules or collapsed, large graph or small', () => {
    const wide = Object.fromEntries([
      ['AppModule', Array.from({ length: 60 }, (_, index) => `Feature${index}Module`)],
      ...Array.from({ length: 60 }, (_, index) => [`Feature${index}Module`, []])
    ])
    const inputs = [
      shopApp(),
      shopApp(variedSize),
      graphInput({ imports: wide, root: 'AppModule' }),
      graphInput({ imports: wide, root: 'AppModule', sizeOf: variedSize })
    ]

    for (const input of inputs) {
      const drawn = boxes(input, layoutModuleRows(input))
      const width = Math.max(...drawn.map(box => box.x + box.width)) - Math.min(...drawn.map(box => box.x))
      const height = Math.max(...drawn.map(box => box.y + box.height)) - Math.min(...drawn.map(box => box.y))
      assert.ok(width / height > 1 && width / height < 2.6, `${width} × ${height}`)
    }
  })

  test('overlaps no two modules, and centres every row under the root', () => {
    for (const input of [shopApp(), shopApp(variedSize)]) {
      const positions = layoutModuleRows(input)

      assertNoOverlap(boxes(input, positions))
      for (const row of rowsOf(input, positions)) {
        assert.equal(row.left + row.right, 0, row.names.join(', '))
      }
    }
  })

  test('is the same every time', () => {
    assert.deepEqual(
      [...layoutModuleRows(shopApp(variedSize))],
      [...layoutModuleRows(shopApp(variedSize))]
    )
  })

  test('places every module it has when the root is not among them', () => {
    const input = graphInput({
      imports: { FeatureModule: ['SharedModule'], SharedModule: [] },
      root: 'AppModule'
    })
    const positions = layoutModuleRows(input)

    assert.deepEqual([...positions.keys()].sort(), ['FeatureModule', 'SharedModule'])
    assertNoOverlap(boxes(input, positions))
  })
})

describe('the layout input from a graph', () => {
  test('keeps the graph order, and drops imports of modules it does not have', () => {
    const moduleMap: GraphOutput = {
      version: '3',
      root: 'AppModule',
      modules: {
        AppModule: { imports: ['FeatureModule', 'ExcludedModule'], exports: [], providers: [], controllers: [] },
        FeatureModule: { imports: [], exports: [], providers: [], controllers: [] }
      },
      cycles: { modules: [], providers: [], controllers: [] }
    }
    const input = moduleGraphLayoutInput({
      moduleMap,
      sizes: new Map([['AppModule', COLLAPSED], ['FeatureModule', { width: 744, height: 300 }]])
    })

    assert.deepEqual(input, {
      root: 'AppModule',
      modules: [
        { name: 'AppModule', ...COLLAPSED },
        { name: 'FeatureModule', width: 744, height: 300 }
      ],
      imports: [{ importer: 'AppModule', imported: 'FeatureModule' }]
    })
  })
})

describe('the timing measure', () => {
  test('is named for reading back with getEntriesByName', () => {
    assert.equal(AUTO_LAYOUT_MEASURE, 'ngi:auto-layout')
    assert.equal(AUTO_LAYOUT_ENGINE_READY_MEASURE, 'ngi:auto-layout:engine-ready')
  })

  test('is recorded with its span and detail, and a bad one is dropped quietly', () => {
    const name = 'ngi:auto-layout:test'
    recordUserTiming({ name, start: 10, end: 35, detail: { engine: 'elk' } })
    // A detail the measure cannot copy, which `performance.measure` refuses.
    recordUserTiming({ name, start: 10, end: 35, detail: () => undefined })

    const entries = performance.getEntriesByName(name)
    performance.clearMeasures(name)
    const [entry] = entries

    assert.equal(entries.length, 1)
    assert.ok(entry instanceof PerformanceMeasure)
    assert.equal(entry.duration, 25)
    assert.deepEqual(entry.detail, { engine: 'elk' })
  })

  test('says ELK placed the modules, how many, whether it was warm, and where it ran', () => {
    const positions = new Map<string, LayoutPoint>([['AppModule', { x: 0, y: 0 }]])

    assert.deepEqual(autoLayoutTimingDetail({
      engine: 'elk',
      runtime: 'worker',
      warm: true,
      positions,
      routes: new Map()
    }), {
      engine: 'elk',
      modules: 1,
      warm: true,
      runtime: 'worker'
    })
  })
})
