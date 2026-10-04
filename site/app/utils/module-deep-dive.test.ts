import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { GraphOutput, GraphOutputModule } from 'nest-graph-inspector'
import {
  DEEP_DIVE_ITEM_WIDTH,
  buildModuleDeepDive,
  getNodeHeight,
  type ModuleDeepDive,
  type ModuleDeepDiveNode
} from './module-deep-dive.ts'

function module(overrides: Partial<GraphOutputModule> = {}): GraphOutputModule {
  return { imports: [], exports: [], providers: [], controllers: [], ...overrides }
}

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

function build(graph: Pick<GraphOutput, 'modules'>, moduleName: string): ModuleDeepDive {
  const deepDive = buildModuleDeepDive(graph, moduleName)
  assert.ok(deepDive, `${moduleName} should exist`)
  return deepDive
}

function nodeByLabel(deepDive: ModuleDeepDive, label: string): ModuleDeepDiveNode {
  const node = deepDive.nodes.find(candidate => candidate.label === label)
  assert.ok(node, `no node labelled ${label}`)
  return node
}

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
})
