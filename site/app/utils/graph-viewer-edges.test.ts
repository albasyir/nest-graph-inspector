import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  CIRCULAR_DEPENDENCY_EDGE_COLOR,
  CONTROLLER_EDGE_COLOR,
  MODULE_EDGE_COLOR,
  PROVIDER_EDGE_COLOR,
  getEdgeColor,
  getEdgeRelationClass,
  resolveEdgeRelationship,
  type EdgeRelationship
} from './graph-viewer-edges.ts'

const RELATIONSHIPS: EdgeRelationship[] = [
  'module',
  'provider',
  'controller',
  'circular'
]

describe('resolveEdgeRelationship', () => {
  test('a module importing another is a module edge', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'module-UserModule',
        target: 'module-AppModule'
      }),
      'module'
    )
  })

  test('a provider injected into a provider is a provider edge, within a module or across one', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'provider-UserModule-UserRepository',
        target: 'provider-UserModule-UserService'
      }),
      'provider'
    )
    assert.equal(
      resolveEdgeRelationship({
        source: 'provider-MobileModule-MobileService',
        target: 'provider-UserModule-UserService'
      }),
      'provider'
    )
  })

  test('a provider injected into a controller is a controller edge', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'provider-UserModule-UserService',
        target: 'controller-UserModule-UserController'
      }),
      'controller'
    )
  })

  // Dependency edges point from what is injected to what receives it, so a
  // controller normally sits at the target; one at the source counts too.
  test('a controller at the source end is still a controller edge', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'controller-UserModule-UserController',
        target: 'provider-UserModule-UserService'
      }),
      'controller'
    )
  })

  test('only an edge with a module at both ends is a module edge', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'module-UserModule',
        target: 'provider-UserModule-UserService'
      }),
      'provider'
    )
  })

  test('an edge closing a cycle is circular, whatever it connects', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'module-OrderModule',
        target: 'module-UserModule',
        isCircular: true
      }),
      'circular'
    )
    assert.equal(
      resolveEdgeRelationship({
        source: 'provider-OrderModule-OrderNotificationService',
        target: 'provider-OrderModule-OrderService',
        isCircular: true
      }),
      'circular'
    )
    assert.equal(
      resolveEdgeRelationship({
        source: 'provider-UserModule-UserService',
        target: 'controller-UserModule-UserController',
        isCircular: true
      }),
      'circular'
    )
  })

  test('isCircular: false resolves as if it were left out', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'module-UserModule',
        target: 'module-AppModule',
        isCircular: false
      }),
      'module'
    )
  })
})

describe('getEdgeColor', () => {
  test('maps each relationship to its colour', () => {
    assert.equal(getEdgeColor('module'), MODULE_EDGE_COLOR)
    assert.equal(getEdgeColor('provider'), PROVIDER_EDGE_COLOR)
    assert.equal(getEdgeColor('controller'), CONTROLLER_EDGE_COLOR)
    assert.equal(getEdgeColor('circular'), CIRCULAR_DEPENDENCY_EDGE_COLOR)
  })

  // The viewer's themes override the custom property; the literal is what a
  // page that never defines it falls back to.
  test('each colour is a themeable custom property with a literal fallback', () => {
    assert.equal(MODULE_EDGE_COLOR, 'var(--mg-edge-module, #38bdf8)')
    assert.equal(PROVIDER_EDGE_COLOR, 'var(--mg-edge-provider, #34d399)')
    assert.equal(CONTROLLER_EDGE_COLOR, 'var(--mg-edge-controller, #c084fc)')
    assert.equal(
      CIRCULAR_DEPENDENCY_EDGE_COLOR,
      'var(--mg-edge-circular, #facc15)'
    )
  })

  test('no two relationships share a colour', () => {
    const colors = new Set(RELATIONSHIPS.map(getEdgeColor))
    assert.equal(colors.size, RELATIONSHIPS.length)
  })
})

describe('getEdgeRelationClass', () => {
  test('names the class after the relationship', () => {
    assert.equal(getEdgeRelationClass('module'), 'edge-relation--module')
    assert.equal(getEdgeRelationClass('provider'), 'edge-relation--provider')
    assert.equal(
      getEdgeRelationClass('controller'),
      'edge-relation--controller'
    )
    assert.equal(getEdgeRelationClass('circular'), 'edge-relation--circular')
  })
})
