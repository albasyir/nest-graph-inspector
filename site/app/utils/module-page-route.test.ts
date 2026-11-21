import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { GraphOutput } from 'nest-graph-inspector'
import { DEFAULT_BRACKET_DEPTH } from './module-dependency-bracket.ts'
import { decodeModuleId } from './module-id.ts'
import {
  MAX_REQUESTED_BRACKET_DEPTH,
  buildModulePageLocation,
  buildModulePagePath,
  buildModulePageQuery,
  buildPreviewModulePageLocation,
  parseModulePageQuery,
  resolveNodeModulePage,
  resolvePreviewModulePage
} from './module-page-route.ts'

const DEFAULTS = {
  view: 'dependencies',
  depth: { left: DEFAULT_BRACKET_DEPTH, right: DEFAULT_BRACKET_DEPTH },
  directRunOn: null
} as const

describe('a module page address', () => {
  test('says nothing for the plainest view of a module', () => {
    assert.deepEqual(parseModulePageQuery({}), DEFAULTS)
    assert.deepEqual(buildModulePageQuery({}), {})
    assert.deepEqual(buildModulePageQuery({
      view: 'dependencies',
      depth: { left: DEFAULT_BRACKET_DEPTH, right: DEFAULT_BRACKET_DEPTH },
      directRunOn: null
    }), {})
  })

  test('holds the view and each side\'s depth, separately', () => {
    const query = buildModulePageQuery({ view: 'inside', depth: { left: 5 } })
    assert.deepEqual(query, { view: 'inside', left: '5' })
    assert.deepEqual(parseModulePageQuery(query), {
      view: 'inside',
      depth: { left: 5, right: DEFAULT_BRACKET_DEPTH },
      directRunOn: null
    })

    assert.deepEqual(buildModulePageQuery({ depth: { right: 1 } }), { right: '1' })
    assert.deepEqual(parseModulePageQuery({ right: '7' }).depth, { left: DEFAULT_BRACKET_DEPTH, right: 7 })
  })

  test('opens Direct Run in the inside view, which an older deep-dive link lands on too', () => {
    const query = buildModulePageQuery({ directRunOn: 'provider-OrderModule-OrderService' })
    assert.deepEqual(query, { 'view': 'inside', 'direct-run-on': 'provider-OrderModule-OrderService' })
    assert.deepEqual(
      parseModulePageQuery({ 'direct-run-on': 'controller-OrderModule-OrderController' }),
      { ...DEFAULTS, view: 'inside', directRunOn: 'controller-OrderModule-OrderController' }
    )
  })

  test('reads a malformed or out-of-range value as the default', () => {
    for (const value of ['0', '-2', '2.5', 'three', '', ' 4', '1e2', String(MAX_REQUESTED_BRACKET_DEPTH + 1), undefined, null, 4]) {
      assert.equal(parseModulePageQuery({ left: value }).depth.left, DEFAULT_BRACKET_DEPTH, `left=${String(value)}`)
    }
    assert.equal(parseModulePageQuery({ left: String(MAX_REQUESTED_BRACKET_DEPTH) }).depth.left, MAX_REQUESTED_BRACKET_DEPTH)
    // The router hands a repeated parameter over as a list: the first counts.
    assert.equal(parseModulePageQuery({ left: ['6', '2'] }).depth.left, 6)
    assert.equal(parseModulePageQuery({ view: ['inside'] }).view, 'inside')
    assert.equal(parseModulePageQuery({ view: 'outside' }).view, 'dependencies')
    assert.equal(parseModulePageQuery({ 'direct-run-on': '' }).directRunOn, null)
  })

  test('names its module in one path segment, whatever the name holds', () => {
    for (const name of ['OrderModule', 'Weird/Name 100%', '..', 'Café(1)']) {
      const path = buildModulePagePath(name)
      const segment = path.slice('/view/navigator/modules/'.length)
      assert.equal(segment.includes('/'), false)
      assert.equal(decodeModuleId(segment), name)
    }

    assert.deepEqual(buildModulePageLocation('OrderModule', { depth: { left: 2 } }), {
      path: '/view/navigator/modules/OrderModule',
      query: { left: '2' }
    })
  })
})

describe('a preview\'s hand-off through /view', () => {
  test('carries the module and the page\'s own query, and lands on that page', () => {
    const link = buildPreviewModulePageLocation('Weird/Name', { view: 'inside', directRunOn: 'provider-Weird/Name-S' })
    assert.deepEqual(link, {
      path: '/view',
      query: {
        'preview': 'true',
        'module': 'Weird/Name',
        'view': 'inside',
        'direct-run-on': 'provider-Weird/Name-S'
      }
    })
    assert.deepEqual(resolvePreviewModulePage(link.query), {
      path: buildModulePagePath('Weird/Name'),
      query: { 'view': 'inside', 'direct-run-on': 'provider-Weird/Name-S' }
    })
    assert.deepEqual(resolvePreviewModulePage(buildPreviewModulePageLocation('OrderModule').query), {
      path: '/view/navigator/modules/OrderModule',
      query: {}
    })
  })

  test('is only a preview\'s own link with a module in it', () => {
    for (const query of [
      { module: 'OrderModule' },
      { preview: 'false', module: 'OrderModule' },
      { preview: ['true'], module: 'OrderModule' },
      { preview: 'true' },
      { preview: 'true', module: '' },
      { preview: 'true', trace: 'true' }
    ]) {
      assert.equal(resolvePreviewModulePage(query), undefined, JSON.stringify(query))
    }
  })
})

describe('a click on the module graph', () => {
  const graph: Pick<GraphOutput, 'modules'> = {
    modules: {
      'OrderModule': {
        imports: [],
        exports: [],
        providers: [{ name: 'Order', dependencies: [] }],
        controllers: [{ name: 'Order', dependencies: [] }]
      },
      'module-Odd': { imports: [], exports: [], providers: [], controllers: [] }
    }
  }

  test('on a module opens its page', () => {
    assert.deepEqual(resolveNodeModulePage(graph, 'module-OrderModule'), { moduleName: 'OrderModule', state: {} })
    assert.deepEqual(resolveNodeModulePage(graph, 'module-module-Odd'), { moduleName: 'module-Odd', state: {} })
  })

  test('on a provider or a controller opens its own module\'s inside view, on it', () => {
    assert.deepEqual(resolveNodeModulePage(graph, 'provider-OrderModule-Order'), {
      moduleName: 'OrderModule',
      state: { view: 'inside', directRunOn: 'provider-OrderModule-Order' }
    })
    assert.deepEqual(resolveNodeModulePage(graph, 'controller-OrderModule-Order'), {
      moduleName: 'OrderModule',
      state: { view: 'inside', directRunOn: 'controller-OrderModule-Order' }
    })
  })

  test('on anything the graph does not name goes nowhere', () => {
    for (const nodeId of ['module-MissingModule', 'module-toString', 'provider-OrderModule-Missing', 'Order', '']) {
      assert.equal(resolveNodeModulePage(graph, nodeId), null, nodeId)
    }
  })
})
