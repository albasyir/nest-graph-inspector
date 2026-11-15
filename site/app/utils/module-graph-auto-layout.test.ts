import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { ElkNode } from 'elkjs/lib/elk-api'
import type { GraphOutput } from 'nest-graph-inspector'
import {
  AUTO_LAYOUT_ENGINE_READY_MEASURE,
  AUTO_LAYOUT_MEASURE,
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
 * A source handing out the engine `start` makes, saying it is warm or not, and
 * counting how often it is asked for one and told to abort.
 */
function sourceOf(params: { start: () => Promise<ElkEngine>, isReady?: boolean }) {
  let acquired = 0
  let aborted = 0
  const engines: ElkEngineSource = {
    isReady: () => params.isReady ?? false,
    acquire: () => {
      acquired += 1
      return params.start()
    },
    abort: () => {
      aborted += 1
    }
  }

  return { engines, acquired: () => acquired, aborted: () => aborted }
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

  test('never pass through a module they do not join', async () => {
    const input = shopApp(variedSize)
    const { positions, routes } = await layoutModuleGraphWithElk({ input, elk: await freshElk() })
    const laidOut = boxes(input, positions)

    for (const moduleImport of input.imports) {
      const route = routes.get(importRouteKey(moduleImport)) ?? []
      for (const [index, point] of route.slice(1).entries()) {
        const previous = route[index]
        assert.ok(previous)
        const leg = {
          left: Math.min(previous.x, point.x),
          right: Math.max(previous.x, point.x),
          top: Math.min(previous.y, point.y),
          bottom: Math.max(previous.y, point.y)
        }
        for (const box of laidOut) {
          if (box.name === moduleImport.importer || box.name === moduleImport.imported) {
            continue
          }
          const crosses = leg.left < box.x + box.width - 1 && leg.right > box.x + 1
            && leg.top < box.y + box.height - 1 && leg.bottom > box.y + 1
          assert.ok(!crosses, `${moduleImport.importer} → ${moduleImport.imported} passes through ${box.name}`)
        }
      }
    }
  })
})

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
    const layout = await autoLayoutModuleGraph({
      input: { root: 'AppModule', modules: [], imports: [] },
      engines: source.engines
    })

    assert.equal(layout.engine, 'none')
    assert.equal(layout.positions.size, 0)
    assert.equal(source.acquired(), 0)
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

describe('falling back to rows', () => {
  const input = shopApp()
  const rows = layoutModuleRows(input)

  test('when ELK cannot start', async () => {
    const source = sourceOf({ start: () => Promise.reject(new Error('the chunk failed to load')) })
    const layout = await autoLayoutModuleGraph({ input, engines: source.engines })

    assert.equal(layout.engine, 'rows')
    assert.deepEqual([...layout.positions], [...rows])
    assert.deepEqual(autoLayoutTimingDetail(layout), {
      engine: 'rows',
      modules: input.modules.length,
      warm: false,
      reason: 'error',
      error: 'the chunk failed to load'
    })
  })

  test('when ELK throws, leaving the engine running for the next layout', async () => {
    const source = standIn(() => Promise.reject(new Error('layout failed')))
    const layout = await autoLayoutModuleGraph({ input, engines: source.engines })

    assert.equal(layout.engine === 'rows' && layout.reason, 'error')
    assert.equal(source.aborted(), 0)
  })

  test('when ELK answers without placing every module', async () => {
    const layout = await autoLayoutModuleGraph({
      input,
      engines: standIn(graph => Promise.resolve({ ...sideBySide(graph), children: [] })).engines
    })

    assert.equal(layout.engine === 'rows' && layout.reason, 'error')
  })

  test('when ELK never answers, stopping the engine that holds the layout', async () => {
    const source = standIn(() => new Promise<ElkNode>(() => {}))
    const layout = await autoLayoutModuleGraph({ input, engines: source.engines, timeoutMs: 20 })

    assert.equal(layout.engine === 'rows' && layout.reason, 'timeout')
    assert.deepEqual([...layout.positions], [...rows])
    assert.equal(source.aborted(), 1)
  })

  test('when ELK does not start in time, stopping it too', async () => {
    const source = sourceOf({ start: () => new Promise<ElkEngine>(() => {}) })
    const layout = await autoLayoutModuleGraph({ input, engines: source.engines, timeoutMs: 20 })

    assert.equal(layout.engine === 'rows' && layout.reason, 'timeout')
    assert.equal(source.aborted(), 1)
  })

  test('when ELK answers after the deadline, having waited on something else', async () => {
    const source = standIn(graph => new Promise((resolve) => {
      setTimeout(() => resolve(sideBySide(graph)), 120)
    }))
    const layout = await autoLayoutModuleGraph({ input, engines: source.engines, timeoutMs: 20 })

    assert.equal(layout.engine === 'rows' && layout.reason, 'timeout')
    assert.equal(source.aborted(), 1)
  })

  test('but not when ELK was laying out on this thread past the deadline', async () => {
    // As the bundled build does where no worker can be made: the layout runs
    // in a task of its own, and its answer is queued as another once done.
    const source = standIn(graph => new Promise((resolve) => {
      setTimeout(() => {
        const busyUntil = Date.now() + 80
        while (Date.now() < busyUntil) {
          // laying out
        }
        setTimeout(() => resolve(sideBySide(graph)), 0)
      }, 0)
    }), 'main-thread')
    const layout = await autoLayoutModuleGraph({ input, engines: source.engines, timeoutMs: 20 })

    assert.equal(layout.engine, 'elk')
    assert.equal(source.aborted(), 0)
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

describe('the rows', () => {
  test('are the one long row the viewer drew before: the root, then all it imports', () => {
    const positions = layoutModuleRows(shopApp())
    const [top, imported, unreached] = layers(positions)

    assert.deepEqual(top, ['AppModule'])
    assert.equal(imported?.length, SHOP_APP_IMPORTS.AppModule?.length)
    assert.deepEqual(unreached, ['NestJSCoreModule'])
  })

  test('centre each row under the root', () => {
    const input = shopApp()
    const positions = layoutModuleRows(input)

    for (const row of layers(positions)) {
      const placed = row.map(name => boxOf(input, positions, name))
      const left = Math.min(...placed.map(box => box.x))
      const right = Math.max(...placed.map(box => box.x + box.width))
      assert.equal(left + right, 0)
    }
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
