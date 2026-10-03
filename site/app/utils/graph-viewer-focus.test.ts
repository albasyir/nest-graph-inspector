import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  MODULE_FOCUS_DURATION_MS,
  MODULE_FOCUS_MAX_ZOOM,
  MODULE_FOCUS_MIN_ZOOM,
  MODULE_FOCUS_PADDING,
  buildModuleFocusFitViewOptions,
  getModuleNodeId,
  resolveModuleFocusTargetNodeIds
} from './graph-viewer-focus.ts'

describe('getModuleNodeId', () => {
  test('prefixes the module name, as the viewer ids its module nodes', () => {
    assert.equal(getModuleNodeId('UserModule'), 'module-UserModule')
  })
})

describe('resolveModuleFocusTargetNodeIds', () => {
  test('a collapsed module is framed alone, since its items are not on the canvas', () => {
    assert.deepEqual(
      resolveModuleFocusTargetNodeIds('UserModule', [
        { id: 'module-AppModule' },
        { id: 'module-UserModule' }
      ]),
      ['module-UserModule']
    )
  })

  test('an open module is framed with every item inside it, module first', () => {
    assert.deepEqual(
      resolveModuleFocusTargetNodeIds('UserModule', [
        { id: 'module-UserModule' },
        { id: 'provider-UserModule-UserService', parentNode: 'module-UserModule' },
        { id: 'controller-UserModule-UserController', parentNode: 'module-UserModule' }
      ]),
      [
        'module-UserModule',
        'provider-UserModule-UserService',
        'controller-UserModule-UserController'
      ]
    )
  })

  test('the items of other modules are left out', () => {
    assert.deepEqual(
      resolveModuleFocusTargetNodeIds('UserModule', [
        { id: 'module-UserModule' },
        { id: 'provider-UserModule-UserService', parentNode: 'module-UserModule' },
        { id: 'module-OrderModule' },
        { id: 'provider-OrderModule-OrderService', parentNode: 'module-OrderModule' }
      ]),
      ['module-UserModule', 'provider-UserModule-UserService']
    )
  })

  // `module-User` is a prefix of `module-UserModule`, but only an exact parent
  // id makes an item part of a module.
  test('items are matched on the exact id of their parent, not a shared prefix', () => {
    assert.deepEqual(
      resolveModuleFocusTargetNodeIds('User', [
        { id: 'module-User' },
        { id: 'module-UserModule' },
        { id: 'provider-UserModule-UserService', parentNode: 'module-UserModule' }
      ]),
      ['module-User']
    )
  })

  // Vue Flow reads an empty `nodes` list as every node. Falling back to the
  // module's own id keeps a focus on a module that is not on the canvas from
  // zooming out to the whole graph: fitView finds nothing to frame and stays put.
  test('a module missing from the canvas falls back to its own id', () => {
    assert.deepEqual(
      resolveModuleFocusTargetNodeIds('UserModule', [
        { id: 'module-AppModule' }
      ]),
      ['module-UserModule']
    )
  })

  test('an empty canvas falls back to the module id too', () => {
    assert.deepEqual(resolveModuleFocusTargetNodeIds('UserModule', []), [
      'module-UserModule'
    ])
  })

  test('items whose module node is missing fall back to the module id alone', () => {
    assert.deepEqual(
      resolveModuleFocusTargetNodeIds('UserModule', [
        { id: 'provider-UserModule-UserService', parentNode: 'module-UserModule' }
      ]),
      ['module-UserModule']
    )
  })
})

describe('buildModuleFocusFitViewOptions', () => {
  test('the focus defaults are 650 ms, 0.2 padding and a 0.05 to 1.2 zoom range', () => {
    assert.equal(MODULE_FOCUS_DURATION_MS, 650)
    assert.equal(MODULE_FOCUS_PADDING, 0.2)
    assert.equal(MODULE_FOCUS_MAX_ZOOM, 1.2)
    assert.equal(MODULE_FOCUS_MIN_ZOOM, 0.05)
  })

  test('frames the given nodes with the focus defaults', () => {
    assert.deepEqual(
      buildModuleFocusFitViewOptions([
        'module-UserModule',
        'provider-UserModule-UserService'
      ]),
      {
        nodes: ['module-UserModule', 'provider-UserModule-UserService'],
        duration: MODULE_FOCUS_DURATION_MS,
        padding: MODULE_FOCUS_PADDING,
        maxZoom: MODULE_FOCUS_MAX_ZOOM,
        minZoom: MODULE_FOCUS_MIN_ZOOM
      }
    )
  })

  test('every override replaces its own default', () => {
    assert.deepEqual(
      buildModuleFocusFitViewOptions(['module-UserModule'], {
        duration: 300,
        padding: 0.5,
        maxZoom: 2,
        minZoom: 0.1
      }),
      {
        nodes: ['module-UserModule'],
        duration: 300,
        padding: 0.5,
        maxZoom: 2,
        minZoom: 0.1
      }
    )
  })

  test('a partial override keeps the remaining defaults', () => {
    assert.deepEqual(
      buildModuleFocusFitViewOptions(['module-UserModule'], { maxZoom: 2 }),
      {
        nodes: ['module-UserModule'],
        duration: MODULE_FOCUS_DURATION_MS,
        padding: MODULE_FOCUS_PADDING,
        maxZoom: 2,
        minZoom: MODULE_FOCUS_MIN_ZOOM
      }
    )
  })

  // `0` is a real duration — an instant jump — not a missing one.
  test('a zero duration is kept rather than replaced by the default', () => {
    assert.equal(
      buildModuleFocusFitViewOptions(['module-UserModule'], { duration: 0 })
        .duration,
      0
    )
  })

  test('an override left undefined keeps the default', () => {
    assert.equal(
      buildModuleFocusFitViewOptions(['module-UserModule'], {
        duration: undefined
      }).duration,
      MODULE_FOCUS_DURATION_MS
    )
  })
})
