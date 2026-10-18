import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type {
  GraphOutput,
  GraphOutputCycle,
  GraphOutputCycles,
  GraphOutputModule,
  GraphOutputProviderCycle
} from 'nest-graph-inspector'
import {
  formatCircularEdgeLabel,
  getCircularEdgeGeometry,
  getCircularLabelBox
} from './circular-dependency-edge.ts'
import {
  DEEP_DIVE_ITEM_WIDTH,
  buildModuleDeepDive,
  createDeepDiveFitTracker,
  fitModuleDeepDive,
  getDependencyCycleSteps,
  getModuleDeepDiveBounds,
  getNodeHeight,
  withLiveNodePositions,
  type ModuleDeepDive,
  type ModuleDeepDiveNode,
  type ModuleDeepDiveOptions
} from './module-deep-dive.ts'

/** A module that declares and imports nothing, apart from what the test overrides. */
function module(overrides: Partial<GraphOutputModule> = {}): GraphOutputModule {
  return { imports: [], exports: [], providers: [], controllers: [], ...overrides }
}

/** A dependency on `token`, as the library reports one: provided by the module named. */
function dep(moduleName: string, token: string) {
  return { providedBy: { type: 'module', name: moduleName }, token }
}

// Shaped like the demo's OrderModule: a controller over a service chain, one
// dependency from a sibling module, one from NestJS core.
const GRAPH: Pick<GraphOutput, 'modules'> = {
  modules: {
    OrderModule: module({
      imports: ['UserModule'],
      exports: ['OrderService'],
      providers: [
        {
          name: 'OrderService',
          jsdoc: 'Places orders.',
          dependencies: [
            dep('OrderModule', 'OrderRepository'),
            dep('UserModule', 'UserService')
          ],
          directRun: { methods: [{ name: 'place', parameterTypes: '[id: number]' }] }
        },
        {
          name: 'OrderRepository',
          dependencies: [dep('NestJSCoreModule', 'ModuleRef')]
        }
      ],
      controllers: [
        {
          name: 'OrderController',
          dependencies: [
            dep('OrderModule', 'OrderService'),
            dep('UserModule', 'UserService')
          ]
        }
      ]
    }),
    UserModule: module({
      exports: ['UserService'],
      providers: [{ name: 'UserService', dependencies: [] }]
    })
  }
}

type DeepDiveGraph = Pick<GraphOutput, 'modules'> & Partial<Pick<GraphOutput, 'cycles'>>

/** The deep dive of `moduleName`, failing the test outright when the graph has no such module. */
function build(
  graph: DeepDiveGraph,
  moduleName: string,
  options?: ModuleDeepDiveOptions
): ModuleDeepDive {
  const deepDive = buildModuleDeepDive(graph, moduleName, options)
  assert.ok(deepDive, `${moduleName} should exist`)
  return deepDive
}

/** The node drawn with `label`, failing the test when there is none. */
function nodeByLabel(deepDive: ModuleDeepDive, label: string): ModuleDeepDiveNode {
  const node = deepDive.nodes.find(candidate => candidate.label === label)
  assert.ok(node, `no node labelled ${label}`)
  return node
}

/**
 * Which layout column a node sits in, read back from its x position: columns
 * are an item's width plus the layout's 120px column gap apart.
 */
function columnOf(node: ModuleDeepDiveNode): number {
  return node.position.x / (DEEP_DIVE_ITEM_WIDTH + 120)
}

describe('buildModuleDeepDive', () => {
  test('a module the graph does not have has no deep dive', () => {
    assert.equal(buildModuleDeepDive(GRAPH, 'MissingModule'), null)
    // An inherited key is not a module either.
    assert.equal(buildModuleDeepDive(GRAPH, 'constructor'), null)
  })

  test('items keep the navigator\'s node ids, so Direct Run resolves them', () => {
    const deepDive = build(GRAPH, 'OrderModule')

    assert.equal(nodeByLabel(deepDive, 'OrderService').id, 'provider-OrderModule-OrderService')
    assert.equal(nodeByLabel(deepDive, 'OrderController').id, 'controller-OrderModule-OrderController')
  })

  test('items carry what their node shows', () => {
    const service = nodeByLabel(build(GRAPH, 'OrderModule'), 'OrderService')
    const repository = nodeByLabel(build(GRAPH, 'OrderModule'), 'OrderRepository')

    assert.equal(service.type, 'item')
    assert.equal(repository.type, 'item')
    if (service.type !== 'item' || repository.type !== 'item') return

    assert.equal(service.isExported, true)
    assert.equal(service.isRunnable, true)
    assert.equal(service.jsdoc, 'Places orders.')
    assert.equal(repository.isExported, false)
    assert.equal(repository.isRunnable, false)
  })

  test('a dependency from another module is one external node, however many inject it', () => {
    const deepDive = build(GRAPH, 'OrderModule')
    const externals = deepDive.nodes.filter(node => node.type === 'external')

    assert.deepEqual(
      externals.map(node => [node.moduleName, node.label]),
      [['NestJSCoreModule', 'ModuleRef'], ['UserModule', 'UserService']]
    )
  })

  test('edges run from the dependency to whatever injects it, typed by what they join', () => {
    const deepDive = build(GRAPH, 'OrderModule')
    const userService = nodeByLabel(deepDive, 'UserService')
    const kindsByPair = new Map(
      deepDive.edges.map(edge => [`${edge.source} => ${edge.target}`, edge.kind])
    )

    assert.equal(
      kindsByPair.get('provider-OrderModule-OrderRepository => provider-OrderModule-OrderService'),
      'provider'
    )
    assert.equal(
      kindsByPair.get('provider-OrderModule-OrderService => controller-OrderModule-OrderController'),
      'controller'
    )
    // External wins over controller: where it comes from is the point.
    assert.equal(
      kindsByPair.get(`${userService.id} => controller-OrderModule-OrderController`),
      'external'
    )
    assert.equal(deepDive.edges.length, 5)
  })

  test('external dependencies on the left, providers by depth, controllers on the right', () => {
    const deepDive = build(GRAPH, 'OrderModule')

    assert.equal(columnOf(nodeByLabel(deepDive, 'ModuleRef')), 0)
    assert.equal(columnOf(nodeByLabel(deepDive, 'UserService')), 0)
    assert.equal(columnOf(nodeByLabel(deepDive, 'OrderRepository')), 1)
    assert.equal(columnOf(nodeByLabel(deepDive, 'OrderService')), 2)
    assert.equal(columnOf(nodeByLabel(deepDive, 'OrderController')), 3)
  })

  test('no two nodes overlap', () => {
    const deepDive = build(GRAPH, 'OrderModule')

    for (const [index, left] of deepDive.nodes.entries()) {
      for (const right of deepDive.nodes.slice(index + 1)) {
        const apartX = Math.abs(left.position.x - right.position.x) >= DEEP_DIVE_ITEM_WIDTH
        const apartY = Math.abs(left.position.y - right.position.y)
          >= Math.max(getNodeHeight(left), getNodeHeight(right))
        assert.ok(apartX || apartY, `${left.label} overlaps ${right.label}`)
      }
    }
  })

  test('a module with no external dependencies starts at the first column', () => {
    const deepDive = build(GRAPH, 'UserModule')

    assert.deepEqual(deepDive.nodes.map(node => [node.label, columnOf(node)]), [['UserService', 0]])
  })

  test('a provider cycle still lays out, every provider once', () => {
    const graph = {
      modules: {
        CycleModule: module({
          providers: [
            { name: 'A', dependencies: [dep('CycleModule', 'B')] },
            { name: 'B', dependencies: [dep('CycleModule', 'A')] },
            { name: 'Self', dependencies: [dep('CycleModule', 'Self')] }
          ]
        })
      }
    }
    const deepDive = build(graph, 'CycleModule')

    assert.deepEqual(deepDive.nodes.map(node => node.label).sort(), ['A', 'B', 'Self'])
    assert.notEqual(columnOf(nodeByLabel(deepDive, 'A')), columnOf(nodeByLabel(deepDive, 'B')))
  })

  test('a token this module is said to provide but does not declare is drawn external', () => {
    const graph = {
      modules: {
        LooseModule: module({
          providers: [{ name: 'Svc', dependencies: [dep('LooseModule', 'Ghost')] }]
        })
      }
    }
    const deepDive = build(graph, 'LooseModule')
    const ghost = nodeByLabel(deepDive, 'Ghost')

    assert.equal(ghost.type, 'external')
    assert.equal(ghost.moduleName, 'LooseModule')
  })

  test('names that join to the same string stay separate nodes', () => {
    const graph = {
      modules: {
        HostModule: module({
          providers: [{
            name: 'Svc',
            dependencies: [dep('A-B', 'C'), dep('A', 'B-C')]
          }]
        })
      }
    }

    assert.equal(
      build(graph, 'HostModule').nodes.filter(node => node.type === 'external').length,
      2
    )
  })

  test('counts what the overview shows', () => {
    assert.deepEqual(build(GRAPH, 'OrderModule').stats, {
      imports: 1,
      exports: 1,
      providers: 2,
      controllers: 1,
      internalDependencies: 2,
      externalDependencies: 2
    })
  })

  test('is horizontal unless asked otherwise, and asking for horizontal changes nothing', () => {
    const byDefault = build(GRAPH, 'OrderModule')

    assert.equal(byDefault.orientation, 'horizontal')
    assert.equal(build(GRAPH, 'OrderModule', {}).orientation, 'horizontal')
    assert.deepEqual(build(GRAPH, 'OrderModule', { orientation: 'horizontal' }), byDefault)
  })

  test('the horizontal layout is where it always was', () => {
    const deepDive = build(GRAPH, 'OrderModule')

    assert.deepEqual(
      deepDive.nodes.map(node => [node.label, node.position]),
      [
        ['ModuleRef', { x: 0, y: -36 }],
        ['UserService', { x: 0, y: 36 }],
        ['OrderRepository', { x: 340, y: 0 }],
        ['OrderService', { x: 680, y: 0 }],
        ['OrderController', { x: 1020, y: 0 }]
      ]
    )
  })
})

describe('buildModuleDeepDive — vertical', () => {
  /** A box a node covers. */
  function boxOf(node: ModuleDeepDiveNode) {
    return {
      left: node.position.x,
      right: node.position.x + DEEP_DIVE_ITEM_WIDTH,
      top: node.position.y,
      bottom: node.position.y + getNodeHeight(node)
    }
  }

  // Ranks wider than one node: two externals, two level-0 providers, two controllers.
  const WIDE_GRAPH: DeepDiveGraph = {
    modules: {
      ShopModule: module({
        providers: [
          { name: 'CartService', dependencies: [dep('ShopModule', 'PriceService'), dep('ShopModule', 'StockService')] },
          { name: 'PriceService', dependencies: [dep('CurrencyModule', 'CurrencyService')] },
          { name: 'StockService', dependencies: [dep('NestJSCoreModule', 'ModuleRef')] }
        ],
        controllers: [
          { name: 'CartController', dependencies: [dep('ShopModule', 'CartService')] },
          { name: 'AdminController', dependencies: [dep('ShopModule', 'StockService')] }
        ]
      })
    }
  }

  test('says it is vertical, and draws the same nodes and edges as the horizontal layout', () => {
    const horizontal = build(GRAPH, 'OrderModule')
    const vertical = build(GRAPH, 'OrderModule', { orientation: 'vertical' })

    assert.equal(vertical.orientation, 'vertical')
    assert.deepEqual(
      vertical.nodes.map(({ position: _position, ...node }) => node),
      horizontal.nodes.map(({ position: _position, ...node }) => node)
    )
    assert.deepEqual(vertical.edges, horizontal.edges)
    assert.deepEqual(vertical.stats, horizontal.stats)
  })

  test('dependencies at the top, providers by depth below them, controllers at the bottom', () => {
    const deepDive = build(GRAPH, 'OrderModule', { orientation: 'vertical' })
    const y = (label: string) => nodeByLabel(deepDive, label).position.y

    assert.equal(y('ModuleRef'), y('UserService'))
    assert.ok(y('UserService') < y('OrderRepository'))
    assert.ok(y('OrderRepository') < y('OrderService'))
    assert.ok(y('OrderService') < y('OrderController'))
    // The rows start at the top: the external row is the first one.
    assert.equal(Math.min(...deepDive.nodes.map(node => node.position.y)), y('ModuleRef'))
  })

  test('every edge that is not on a cycle runs downwards, from a dependency to what injects it', () => {
    const deepDive = build(WIDE_GRAPH, 'ShopModule', { orientation: 'vertical' })
    const nodeById = new Map(deepDive.nodes.map(node => [node.id, node]))

    assert.ok(deepDive.edges.length > 0)
    for (const edge of deepDive.edges) {
      const source = nodeById.get(edge.source) as ModuleDeepDiveNode
      const target = nodeById.get(edge.target) as ModuleDeepDiveNode
      assert.ok(
        boxOf(source).bottom < boxOf(target).top,
        `${source.label} should sit above ${target.label}`
      )
    }
  })

  test('nodes in a row sit side by side, none overlapping, the row centred on the others', () => {
    const deepDive = build(WIDE_GRAPH, 'ShopModule', { orientation: 'vertical' })
    const rows = new Map<number, ModuleDeepDiveNode[]>()
    for (const node of deepDive.nodes) {
      rows.set(node.position.y, [...rows.get(node.position.y) ?? [], node])
    }

    assert.deepEqual(
      [...rows.values()].map(row => row.map(node => node.label)),
      [
        ['ModuleRef', 'CurrencyService'],
        ['PriceService', 'StockService'],
        ['CartService'],
        ['CartController', 'AdminController']
      ].map(labels => labels.sort((left, right) =>
        nodeByLabel(deepDive, left).position.x - nodeByLabel(deepDive, right).position.x
      ))
    )

    for (const row of rows.values()) {
      const sorted = [...row].sort((left, right) => left.position.x - right.position.x)
      for (const [index, node] of sorted.entries()) {
        const next = sorted[index + 1]
        if (next) {
          assert.ok(boxOf(node).right < boxOf(next).left, `${node.label} overlaps ${next.label}`)
        }
      }
      // Every row's middle is the same line, x = DEEP_DIVE_ITEM_WIDTH / 2.
      const middle = (boxOf(sorted[0] as ModuleDeepDiveNode).left
        + boxOf(sorted.at(-1) as ModuleDeepDiveNode).right) / 2
      assert.equal(middle, DEEP_DIVE_ITEM_WIDTH / 2)
    }
  })

  test('no two nodes overlap, and rows leave room between them', () => {
    const deepDive = build(WIDE_GRAPH, 'ShopModule', { orientation: 'vertical' })

    for (const [index, left] of deepDive.nodes.entries()) {
      for (const right of deepDive.nodes.slice(index + 1)) {
        const a = boxOf(left)
        const b = boxOf(right)
        const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
        assert.ok(apart, `${left.label} overlaps ${right.label}`)
      }
    }
  })

  test('the taller external row pushes the row below it down rather than into it', () => {
    const deepDive = build(GRAPH, 'OrderModule', { orientation: 'vertical' })
    const external = boxOf(nodeByLabel(deepDive, 'ModuleRef'))
    const firstProvider = boxOf(nodeByLabel(deepDive, 'OrderRepository'))
    const secondProvider = boxOf(nodeByLabel(deepDive, 'OrderService'))

    // The gap under the 52px external row is the gap under a 36px item row.
    assert.equal(firstProvider.top - external.bottom, secondProvider.top - firstProvider.bottom)
  })

  test('a module with no external dependencies starts at the top row', () => {
    const deepDive = build(GRAPH, 'UserModule', { orientation: 'vertical' })

    assert.deepEqual(deepDive.nodes.map(node => [node.label, node.position]), [['UserService', { x: 0, y: 0 }]])
  })

  test('a provider cycle still lays out, every provider once, on different rows', () => {
    const deepDive = build(
      {
        modules: {
          CycleModule: module({
            providers: [
              { name: 'A', dependencies: [dep('CycleModule', 'B')] },
              { name: 'B', dependencies: [dep('CycleModule', 'A')] },
              { name: 'Self', dependencies: [dep('CycleModule', 'Self')] }
            ]
          })
        }
      },
      'CycleModule',
      { orientation: 'vertical' }
    )

    assert.deepEqual(deepDive.nodes.map(node => node.label).sort(), ['A', 'B', 'Self'])
    assert.notEqual(nodeByLabel(deepDive, 'A').position.y, nodeByLabel(deepDive, 'B').position.y)
  })

  test('a module with nothing to draw has no nodes either way', () => {
    const deepDive = build(
      { modules: { AppModule: module({ imports: ['OrderModule'] }) } },
      'AppModule',
      { orientation: 'vertical' }
    )

    assert.deepEqual(deepDive.nodes, [])
    assert.equal(deepDive.orientation, 'vertical')
  })
})

/** A cycle report with no cycles, apart from the ones the test supplies. */
function cycles(overrides: Partial<GraphOutputCycles> = {}): GraphOutputCycles {
  return { modules: [], providers: [], controllers: [], ...overrides }
}

/** A provider cycle as the library reports it: each class injects the next. */
function providerCycle(
  id: number,
  path: Array<[moduleName: string, name: string]>
): GraphOutputProviderCycle {
  const [first, second] = path

  return {
    id,
    from: `${first?.[0]}:${first?.[1]}`,
    to: `${second?.[0]}:${second?.[1]}`,
    type: path.length <= 3 ? 'direct' : 'indirect',
    path: path.map(([moduleName, name]) => ({
      module: { name: moduleName },
      provider: { name }
    }))
  }
}

/** `source => target` → the cycles that edge is a step of. */
function cycleIdsByPair(deepDive: ModuleDeepDive): Map<string, number[]> {
  return new Map(
    deepDive.edges.map(edge => [`${edge.source} => ${edge.target}`, edge.cycleIds])
  )
}

describe('buildModuleDeepDive — cycles', () => {
  // Shaped like the demo's OrderModule: OrderService and
  // OrderNotificationService inject each other through forwardRef.
  const ORDER_CYCLE_GRAPH: DeepDiveGraph = {
    modules: {
      OrderModule: module({
        providers: [
          {
            name: 'OrderService',
            dependencies: [
              dep('OrderModule', 'OrderNotificationService'),
              dep('OrderModule', 'OrderRepository')
            ]
          },
          {
            name: 'OrderNotificationService',
            dependencies: [dep('OrderModule', 'OrderService')]
          },
          { name: 'OrderRepository', dependencies: [] }
        ]
      })
    },
    cycles: cycles({
      providers: [
        providerCycle(4, [
          ['OrderModule', 'OrderService'],
          ['OrderModule', 'OrderNotificationService'],
          ['OrderModule', 'OrderService']
        ])
      ]
    })
  }

  test('both edges of a pair that inject each other carry the cycle; the rest carry none', () => {
    const byPair = cycleIdsByPair(build(ORDER_CYCLE_GRAPH, 'OrderModule'))

    assert.deepEqual(
      byPair.get('provider-OrderModule-OrderNotificationService => provider-OrderModule-OrderService'),
      [4]
    )
    assert.deepEqual(
      byPair.get('provider-OrderModule-OrderService => provider-OrderModule-OrderNotificationService'),
      [4]
    )
    assert.deepEqual(
      byPair.get('provider-OrderModule-OrderRepository => provider-OrderModule-OrderService'),
      []
    )
  })

  test('a provider injecting itself is one self-loop edge on its own cycle', () => {
    const deepDive = build(
      {
        modules: {
          SelfModule: module({
            providers: [{ name: 'Self', dependencies: [dep('SelfModule', 'Self')] }]
          })
        },
        cycles: cycles({
          providers: [providerCycle(7, [['SelfModule', 'Self'], ['SelfModule', 'Self']])]
        })
      },
      'SelfModule'
    )

    assert.deepEqual(deepDive.edges, [{
      id: JSON.stringify(['provider-SelfModule-Self', 'provider-SelfModule-Self']),
      source: 'provider-SelfModule-Self',
      target: 'provider-SelfModule-Self',
      kind: 'provider',
      cycleIds: [7]
    }])
  })

  test('every injection of a longer cycle carries its id, from dependency to dependent', () => {
    const byPair = cycleIdsByPair(build(
      {
        modules: {
          RingModule: module({
            providers: [
              { name: 'A', dependencies: [dep('RingModule', 'B')] },
              { name: 'B', dependencies: [dep('RingModule', 'C')] },
              { name: 'C', dependencies: [dep('RingModule', 'A')] }
            ]
          })
        },
        cycles: cycles({
          providers: [providerCycle(9, [
            ['RingModule', 'A'],
            ['RingModule', 'B'],
            ['RingModule', 'C'],
            ['RingModule', 'A']
          ])]
        })
      },
      'RingModule'
    ))

    assert.deepEqual(byPair, new Map([
      ['provider-RingModule-B => provider-RingModule-A', [9]],
      ['provider-RingModule-C => provider-RingModule-B', [9]],
      ['provider-RingModule-A => provider-RingModule-C', [9]]
    ]))
  })

  test('a cycle through other modules marks only the injection that reaches this one', () => {
    const graph: DeepDiveGraph = {
      modules: {
        UserModule: module({
          providers: [{ name: 'UserService', dependencies: [dep('MobileModule', 'MobileService')] }]
        }),
        MobileModule: module({
          providers: [{ name: 'MobileService', dependencies: [dep('ProductModule', 'ProductService')] }]
        }),
        ProductModule: module({
          providers: [{ name: 'ProductService', dependencies: [dep('UserModule', 'UserService')] }]
        })
      },
      cycles: cycles({
        providers: [providerCycle(2, [
          ['UserModule', 'UserService'],
          ['MobileModule', 'MobileService'],
          ['ProductModule', 'ProductService'],
          ['UserModule', 'UserService']
        ])]
      })
    }
    const userDeepDive = build(graph, 'UserModule')

    assert.deepEqual(
      userDeepDive.edges.map(edge => [edge.source, edge.target, edge.cycleIds]),
      [[
        nodeByLabel(userDeepDive, 'MobileService').id,
        'provider-UserModule-UserService',
        [2]
      ]]
    )
    assert.deepEqual(build(graph, 'MobileModule').edges.map(edge => edge.cycleIds), [[2]])
  })

  test('the same class names cycling in another module mark nothing here', () => {
    const graph: DeepDiveGraph = {
      modules: {
        ModuleA: module({
          providers: [
            { name: 'Service', dependencies: [dep('ModuleA', 'Repo')] },
            { name: 'Repo', dependencies: [] }
          ]
        }),
        ModuleB: module({
          providers: [
            { name: 'Service', dependencies: [dep('ModuleB', 'Repo')] },
            { name: 'Repo', dependencies: [dep('ModuleB', 'Service')] }
          ]
        })
      },
      cycles: cycles({
        providers: [providerCycle(3, [
          ['ModuleB', 'Service'],
          ['ModuleB', 'Repo'],
          ['ModuleB', 'Service']
        ])]
      })
    }

    assert.deepEqual(build(graph, 'ModuleA').edges.map(edge => edge.cycleIds), [[]])
    assert.deepEqual(build(graph, 'ModuleB').edges.map(edge => edge.cycleIds), [[3], [3]])
  })

  test('a controller cycle, keyed Module:Class, marks its injections too', () => {
    const controllerCycle: GraphOutputCycle = {
      id: 5,
      from: 'WebModule:WebController',
      to: 'WebModule:WebService',
      type: 'direct',
      path: ['WebModule:WebController', 'WebModule:WebService', 'WebModule:WebController']
    }
    const byPair = cycleIdsByPair(build(
      {
        modules: {
          WebModule: module({
            providers: [{ name: 'WebService', dependencies: [dep('WebModule', 'WebController')] }],
            controllers: [{ name: 'WebController', dependencies: [dep('WebModule', 'WebService')] }]
          })
        },
        cycles: cycles({ controllers: [controllerCycle] })
      },
      'WebModule'
    ))

    assert.deepEqual(byPair.get('provider-WebModule-WebService => controller-WebModule-WebController'), [5])
    assert.deepEqual(byPair.get('controller-WebModule-WebController => provider-WebModule-WebService'), [5])
  })

  test('module cycles are imports, not injections, and mark no edge', () => {
    const deepDive = build(
      {
        ...GRAPH,
        cycles: cycles({
          modules: [{
            id: 1,
            from: 'OrderModule',
            to: 'UserModule',
            type: 'direct',
            path: ['OrderModule', 'UserModule', 'OrderModule']
          }]
        })
      },
      'OrderModule'
    )

    assert.ok(deepDive.edges.every(edge => edge.cycleIds.length === 0))
  })

  test('a module with no providers or controllers has no edges, whatever cycles exist', () => {
    const deepDive = build(
      {
        modules: { ...ORDER_CYCLE_GRAPH.modules, AppModule: module({ imports: ['OrderModule'] }) },
        cycles: ORDER_CYCLE_GRAPH.cycles
      },
      'AppModule'
    )

    assert.deepEqual(deepDive.nodes, [])
    assert.deepEqual(deepDive.edges, [])
  })
})

describe('getModuleDeepDiveBounds', () => {
  const ORDER_CYCLE_GRAPH: DeepDiveGraph = {
    modules: {
      OrderModule: module({
        providers: [
          {
            name: 'OrderService',
            dependencies: [
              dep('OrderModule', 'OrderNotificationService'),
              dep('OrderModule', 'OrderRepository')
            ]
          },
          {
            name: 'OrderNotificationService',
            dependencies: [dep('OrderModule', 'OrderService')]
          },
          { name: 'OrderRepository', dependencies: [] }
        ],
        controllers: [
          { name: 'OrderController', dependencies: [dep('OrderModule', 'OrderService')] }
        ]
      })
    },
    cycles: cycles({
      providers: [providerCycle(4, [
        ['OrderModule', 'OrderService'],
        ['OrderModule', 'OrderNotificationService'],
        ['OrderModule', 'OrderService']
      ])]
    })
  }

  type Box = { x: number, y: number, width: number, height: number }

  /** Whether `inner` lies wholly inside `outer`, touching edges included. */
  function contains(outer: Box, inner: Box): boolean {
    return inner.x >= outer.x
      && inner.y >= outer.y
      && inner.x + inner.width <= outer.x + outer.width
      && inner.y + inner.height <= outer.y + outer.height
  }

  /** Every cycle label's box, placed as the viewer places it. */
  function cycleLabelBoxes(deepDive: ModuleDeepDive, scale: number): Box[] {
    const nodeById = new Map(deepDive.nodes.map(node => [node.id, node]))

    return deepDive.edges
      .filter(edge => edge.cycleIds.length > 0)
      .map((edge) => {
        const source = nodeById.get(edge.source) as ModuleDeepDiveNode
        const target = nodeById.get(edge.target) as ModuleDeepDiveNode
        const isSelfLoop = edge.source === edge.target
        // Out of the bottom into the top when vertical, right into left otherwise.
        const geometry = getCircularEdgeGeometry(deepDive.orientation === 'vertical'
          ? {
              sourceX: source.position.x + DEEP_DIVE_ITEM_WIDTH / 2,
              sourceY: source.position.y + getNodeHeight(source),
              sourcePosition: 'bottom',
              targetX: target.position.x + DEEP_DIVE_ITEM_WIDTH / 2,
              targetY: target.position.y,
              targetPosition: 'top',
              isSelfLoop
            }
          : {
              sourceX: source.position.x + DEEP_DIVE_ITEM_WIDTH,
              sourceY: source.position.y + getNodeHeight(source) / 2,
              sourcePosition: 'right',
              targetX: target.position.x,
              targetY: target.position.y + getNodeHeight(target) / 2,
              targetPosition: 'left',
              isSelfLoop
            })

        return getCircularLabelBox(geometry, formatCircularEdgeLabel(edge.cycleIds), scale)
      })
  }

  test('frames every node and every cycle label, not only the nodes', () => {
    const deepDive = build(ORDER_CYCLE_GRAPH, 'OrderModule')
    const bounds = getModuleDeepDiveBounds(deepDive)
    assert.ok(bounds)

    const labels = cycleLabelBoxes(deepDive, 1)
    assert.equal(labels.length, 2)
    for (const label of labels) {
      assert.ok(contains(bounds, label), 'a cycle label falls outside the fitted box')
    }
    for (const node of deepDive.nodes) {
      assert.ok(contains(bounds, {
        x: node.position.x,
        y: node.position.y,
        width: DEEP_DIVE_ITEM_WIDTH,
        height: getNodeHeight(node)
      }))
    }

    // The closing edge doubles back below the columns: nodes alone are too short.
    const nodesBottom = Math.max(...deepDive.nodes.map(node => node.position.y + getNodeHeight(node)))
    assert.ok(bounds.y + bounds.height > nodesBottom + 20)
  })

  test('holds labels enlarged for a zoomed-out canvas too', () => {
    const deepDive = build(ORDER_CYCLE_GRAPH, 'OrderModule')
    const bounds = getModuleDeepDiveBounds(deepDive, 2.5)
    assert.ok(bounds)

    for (const label of cycleLabelBoxes(deepDive, 2.5)) {
      assert.ok(contains(bounds, label))
    }
  })

  test('takes a self-loop beside its node into the box', () => {
    const deepDive = build(
      {
        modules: {
          SelfModule: module({
            providers: [{ name: 'Self', dependencies: [dep('SelfModule', 'Self')] }]
          })
        },
        cycles: cycles({
          providers: [providerCycle(7, [['SelfModule', 'Self'], ['SelfModule', 'Self']])]
        })
      },
      'SelfModule'
    )
    const bounds = getModuleDeepDiveBounds(deepDive)
    assert.ok(bounds)

    assert.ok(bounds.x + bounds.width > DEEP_DIVE_ITEM_WIDTH + 40)
  })

  test('a deep dive without cycles is framed by its nodes alone', () => {
    const deepDive = build(GRAPH, 'OrderModule')
    const bounds = getModuleDeepDiveBounds(deepDive)
    const left = Math.min(...deepDive.nodes.map(node => node.position.x))
    const top = Math.min(...deepDive.nodes.map(node => node.position.y))

    assert.deepEqual(bounds && { x: bounds.x, y: bounds.y }, { x: left, y: top })
  })

  test('a module with nothing to draw has no box', () => {
    assert.equal(getModuleDeepDiveBounds(build(
      { modules: { AppModule: module({ imports: ['OrderModule'] }) } },
      'AppModule'
    )), null)
  })

  test('vertical: frames every node and every cycle label, at any label scale', () => {
    const deepDive = build(ORDER_CYCLE_GRAPH, 'OrderModule', { orientation: 'vertical' })

    for (const scale of [1, 2.5]) {
      const bounds = getModuleDeepDiveBounds(deepDive, scale)
      assert.ok(bounds)

      const labels = cycleLabelBoxes(deepDive, scale)
      assert.equal(labels.length, 2)
      for (const label of labels) {
        assert.ok(contains(bounds, label), `a cycle label falls outside the box at scale ${scale}`)
      }
      for (const node of deepDive.nodes) {
        assert.ok(contains(bounds, {
          x: node.position.x,
          y: node.position.y,
          width: DEEP_DIVE_ITEM_WIDTH,
          height: getNodeHeight(node)
        }))
      }
    }
  })

  test('vertical: the edge closing a cycle leaves a node\'s bottom, so the box reaches past the rows', () => {
    const vertical = build(ORDER_CYCLE_GRAPH, 'OrderModule', { orientation: 'vertical' })
    const bounds = getModuleDeepDiveBounds(vertical)
    assert.ok(bounds)

    // OrderService injects OrderNotificationService, a row above it: the edge
    // leaves OrderService's bottom and doubles back up, below its own row.
    const service = nodeByLabel(vertical, 'OrderService')
    const serviceBottom = service.position.y + getNodeHeight(service)
    const geometry = getCircularEdgeGeometry({
      sourceX: service.position.x + DEEP_DIVE_ITEM_WIDTH / 2,
      sourceY: serviceBottom,
      sourcePosition: 'bottom',
      targetX: nodeByLabel(vertical, 'OrderNotificationService').position.x + DEEP_DIVE_ITEM_WIDTH / 2,
      targetY: nodeByLabel(vertical, 'OrderNotificationService').position.y,
      targetPosition: 'top',
      isSelfLoop: false
    })
    const lowestControlPoint = Math.max(...geometry.points.map(point => point.y))
    assert.ok(lowestControlPoint > serviceBottom)
    assert.ok(bounds.y + bounds.height >= lowestControlPoint)
  })

  test('vertical: framed from bottom and top handles, not the horizontal right and left', () => {
    const vertical = build(ORDER_CYCLE_GRAPH, 'OrderModule', { orientation: 'vertical' })
    const asIfHorizontal = getModuleDeepDiveBounds({ nodes: vertical.nodes, edges: vertical.edges })

    assert.notDeepEqual(getModuleDeepDiveBounds(vertical), asIfHorizontal)
  })

  test('vertical: a self-loop hangs below its node, and the box holds it and its label', () => {
    const deepDive = build(
      {
        modules: {
          SelfModule: module({
            providers: [{ name: 'Self', dependencies: [dep('SelfModule', 'Self')] }]
          })
        },
        cycles: cycles({
          providers: [providerCycle(7, [['SelfModule', 'Self'], ['SelfModule', 'Self']])]
        })
      },
      'SelfModule',
      { orientation: 'vertical' }
    )
    const [node] = deepDive.nodes
    assert.ok(node)
    const bounds = getModuleDeepDiveBounds(deepDive)
    assert.ok(bounds)

    const nodeBottom = node.position.y + getNodeHeight(node)
    // Below the node, not beside it: the box keeps the node's width and grows downwards.
    assert.equal(bounds.x, node.position.x)
    assert.equal(bounds.width, DEEP_DIVE_ITEM_WIDTH)
    assert.equal(bounds.y, node.position.y)
    assert.ok(bounds.y + bounds.height > nodeBottom + 40)
    const [label] = cycleLabelBoxes(deepDive, 1)
    assert.ok(label)
    assert.ok(label.y >= nodeBottom)
    assert.ok(contains(bounds, label))
  })

  test('vertical: a deep dive without cycles is framed by its nodes alone', () => {
    const deepDive = build(GRAPH, 'OrderModule', { orientation: 'vertical' })
    const bounds = getModuleDeepDiveBounds(deepDive)
    const left = Math.min(...deepDive.nodes.map(node => node.position.x))
    const right = Math.max(...deepDive.nodes.map(node => node.position.x + DEEP_DIVE_ITEM_WIDTH))
    const top = Math.min(...deepDive.nodes.map(node => node.position.y))
    const bottom = Math.max(...deepDive.nodes.map(node => node.position.y + getNodeHeight(node)))

    assert.deepEqual(bounds, { x: left, y: top, width: right - left, height: bottom - top })
  })
})

describe('withLiveNodePositions', () => {
  test('moves the nodes the canvas has a position for, and leaves the rest and the input alone', () => {
    const deepDive = build(GRAPH, 'OrderModule')
    const dragged = nodeByLabel(deepDive, 'OrderService')
    const layoutPosition = { ...dragged.position }
    const live = withLiveNodePositions(deepDive, new Map([[dragged.id, { x: 2000, y: 900 }]]))

    for (const node of live.nodes) {
      const original = deepDive.nodes.find(candidate => candidate.id === node.id)
      assert.deepEqual(
        node.position,
        node.id === dragged.id ? { x: 2000, y: 900 } : original?.position
      )
    }
    assert.deepEqual(dragged.position, layoutPosition)
    assert.equal(live.edges, deepDive.edges)
  })

  test('the box follows a dragged node, and the cycle label beside it', () => {
    const deepDive = build(
      {
        modules: {
          SelfModule: module({
            providers: [{ name: 'Self', dependencies: [dep('SelfModule', 'Self')] }]
          })
        },
        cycles: cycles({
          providers: [providerCycle(7, [['SelfModule', 'Self'], ['SelfModule', 'Self']])]
        })
      },
      'SelfModule'
    )
    const [node] = deepDive.nodes
    assert.ok(node)
    const bounds = getModuleDeepDiveBounds(
      withLiveNodePositions(deepDive, new Map([[node.id, { x: 1500, y: 600 }]]))
    )
    assert.ok(bounds)

    assert.equal(bounds.x, 1500)
    // The self-loop and its label sit past the node's right side, where it was dragged.
    assert.ok(bounds.x + bounds.width > 1500 + DEEP_DIVE_ITEM_WIDTH + 40)
    assert.ok(bounds.y <= 600 && bounds.y + bounds.height >= 600 + getNodeHeight(node))
  })

  test('keeps the orientation, so a dragged vertical deep dive is still framed from its bottom and top', () => {
    const deepDive = build(
      {
        modules: {
          SelfModule: module({
            providers: [{ name: 'Self', dependencies: [dep('SelfModule', 'Self')] }]
          })
        },
        cycles: cycles({
          providers: [providerCycle(7, [['SelfModule', 'Self'], ['SelfModule', 'Self']])]
        })
      },
      'SelfModule',
      { orientation: 'vertical' }
    )
    const [node] = deepDive.nodes
    assert.ok(node)
    const live = withLiveNodePositions(deepDive, new Map([[node.id, { x: 1500, y: 600 }]]))

    assert.equal(live.orientation, 'vertical')
    assert.equal(withLiveNodePositions(build(GRAPH, 'OrderModule'), new Map()).orientation, 'horizontal')

    const bounds = getModuleDeepDiveBounds(live)
    assert.ok(bounds)
    // The self-loop hangs below the dragged node rather than past its right side.
    assert.equal(bounds.x, 1500)
    assert.equal(bounds.width, DEEP_DIVE_ITEM_WIDTH)
    assert.ok(bounds.y + bounds.height > 600 + getNodeHeight(node) + 40)
  })
})

describe('fitModuleDeepDive', () => {
  type Box = { x: number, y: number, width: number, height: number }

  /** A canvas that records each fit and answers with a fixed zoom. */
  function fakeViewport(zoom: number, isReady = true) {
    const fits: Box[] = []

    return {
      fits,
      viewport: {
        fitBounds: async (bounds: Box) => {
          fits.push(bounds)
          return isReady
        },
        getZoom: () => zoom
      }
    }
  }

  test('a viewport that is not ready yet refuses the fit, which stays owed', async () => {
    const { fits, viewport } = fakeViewport(1, false)

    assert.equal(await fitModuleDeepDive(build(GRAPH, 'OrderModule'), viewport), false)
    assert.equal(fits.length, 1)
  })

  test('a fit that keeps labels at their own size is made once', async () => {
    const { fits, viewport } = fakeViewport(1.5)

    assert.equal(await fitModuleDeepDive(build(GRAPH, 'OrderModule'), viewport), true)
    assert.equal(fits.length, 1)
  })

  test('a fit that zooms out is made again with labels enlarged to match', async () => {
    const deepDive = build(
      {
        modules: {
          SelfModule: module({
            providers: [{ name: 'Self', dependencies: [dep('SelfModule', 'Self')] }]
          })
        },
        cycles: cycles({
          providers: [providerCycle(7, [['SelfModule', 'Self'], ['SelfModule', 'Self']])]
        })
      },
      'SelfModule'
    )
    const { fits, viewport } = fakeViewport(0.5)

    assert.equal(await fitModuleDeepDive(deepDive, viewport), true)
    assert.equal(fits.length, 2)
    const [first, second] = fits as [Box, Box]
    assert.ok(second.width > first.width, 'the refit holds the doubled label')
  })

  test('a fit superseded by a newer one stops without moving the canvas again', async () => {
    const tracker = createDeepDiveFitTracker()
    const isCurrent = tracker.begin()
    const fits: Box[] = []
    const fitted = await fitModuleDeepDive(build(GRAPH, 'OrderModule'), {
      fitBounds: async (bounds) => {
        fits.push(bounds)
        // A resize asks for a newer fit while this one is moving the canvas.
        tracker.begin()
        return true
      },
      // Zoomed out, so a current fit would refit with enlarged labels.
      getZoom: () => 0.5,
      isCurrent
    })

    assert.equal(fitted, true)
    assert.equal(fits.length, 1)
    assert.equal(isCurrent(), false)
  })

  test('a node the reader dragged is framed where they left it', async () => {
    const deepDive = build(GRAPH, 'OrderModule')
    const dragged = nodeByLabel(deepDive, 'OrderController')
    const { fits, viewport } = fakeViewport(1)

    await fitModuleDeepDive(
      withLiveNodePositions(deepDive, new Map([[dragged.id, { x: 3000, y: -800 }]])),
      viewport
    )

    const [fit] = fits
    assert.ok(fit)
    assert.ok(fit.x + fit.width >= 3000 + DEEP_DIVE_ITEM_WIDTH)
    assert.ok(fit.y <= -800)
  })

  test('a module with nothing to draw needs no fit', async () => {
    const { fits, viewport } = fakeViewport(1)

    assert.equal(await fitModuleDeepDive(
      build({ modules: { AppModule: module({ imports: ['OrderModule'] }) } }, 'AppModule'),
      viewport
    ), true)
    assert.equal(fits.length, 0)
  })
})

describe('createDeepDiveFitTracker', () => {
  test('resizes reframe until the reader pans or zooms, then leave their view alone', () => {
    const tracker = createDeepDiveFitTracker()

    assert.equal(tracker.shouldFitOnResize(), true)
    tracker.noteReaderMove()
    assert.equal(tracker.shouldFitOnResize(), false)
  })

  test('another module, or a fit the reader asks for, starts over', () => {
    const tracker = createDeepDiveFitTracker()

    tracker.noteReaderMove()
    tracker.reset()
    assert.equal(tracker.shouldFitOnResize(), true)
  })

  test('only the latest fit is current', () => {
    const tracker = createDeepDiveFitTracker()
    const first = tracker.begin()

    assert.equal(first(), true)
    const second = tracker.begin()
    assert.equal(first(), false)
    assert.equal(second(), true)
  })
})

describe('getDependencyCycleSteps', () => {
  test('walks each path in order: each class injects the next', () => {
    assert.deepEqual(
      getDependencyCycleSteps(cycles({
        providers: [providerCycle(4, [['M', 'A'], ['M', 'B'], ['M', 'A']])]
      })),
      [
        { cycleId: 4, dependent: { moduleName: 'M', name: 'A' }, dependency: { moduleName: 'M', name: 'B' } },
        { cycleId: 4, dependent: { moduleName: 'M', name: 'B' }, dependency: { moduleName: 'M', name: 'A' } }
      ]
    )
  })

  test('a self-loop is a single step from a class to itself', () => {
    assert.deepEqual(
      getDependencyCycleSteps(cycles({
        providers: [providerCycle(7, [['M', 'Self'], ['M', 'Self']])]
      })),
      [{ cycleId: 7, dependent: { moduleName: 'M', name: 'Self' }, dependency: { moduleName: 'M', name: 'Self' } }]
    )
  })

  test('splits a controller key at its first colon and skips a key with no module', () => {
    assert.deepEqual(
      getDependencyCycleSteps(cycles({
        controllers: [{
          id: 6,
          from: 'M:Web',
          to: 'M:Svc:Extra',
          type: 'direct',
          path: ['M:Web', 'M:Svc:Extra', 'Bare', 'M:Web']
        }]
      })),
      [{ cycleId: 6, dependent: { moduleName: 'M', name: 'Web' }, dependency: { moduleName: 'M', name: 'Svc:Extra' } }]
    )
  })

  test('module cycles and a missing report have no steps', () => {
    assert.deepEqual(
      getDependencyCycleSteps(cycles({
        modules: [{ id: 1, from: 'A', to: 'B', type: 'direct', path: ['A', 'B', 'A'] }]
      })),
      []
    )
    assert.deepEqual(getDependencyCycleSteps(undefined), [])
  })
})
