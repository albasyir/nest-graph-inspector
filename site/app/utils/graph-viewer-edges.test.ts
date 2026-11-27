import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  CIRCULAR_DEPENDENCY_EDGE_COLOR,
  CONTROLLER_EDGE_COLOR,
  MODULE_EDGE_COLOR,
  PROVIDER_EDGE_COLOR,
  collectCircularEdgeInfo,
  getEdgeColor,
  getEdgeRelationClass,
  isControllerEdge,
  isEdgeVisible,
  pickModuleEdgeHandles,
  placeDependencyEdge,
  resolveEdgeRelationship,
  roundedPolylinePath,
  type EdgeRelationship,
  type ModuleEdgeBox
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

  // A collapsed module hides its providers, so a dependency between two
  // collapsed modules is drawn from one module node to the other. It is
  // still a provider dependency, not an import, and names its relationship
  // to say so.
  test('a named relationship outranks the nodes the edge is drawn between', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'module-PaymentModule',
        target: 'module-OrderModule',
        relationship: 'provider'
      }),
      'provider'
    )
  })

  test('a controller dependency drawn onto a collapsed module stays a controller edge', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'provider-PaymentModule-PaymentService',
        target: 'module-OrderModule',
        relationship: 'controller'
      }),
      'controller'
    )
  })

  test('an edge closing a cycle is circular, whatever relationship it names', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'module-PaymentModule',
        target: 'module-OrderModule',
        relationship: 'provider',
        isCircular: true
      }),
      'circular'
    )
  })

  test('relationship: undefined resolves as if it were left out', () => {
    assert.equal(
      resolveEdgeRelationship({
        source: 'module-UserModule',
        target: 'module-AppModule',
        relationship: undefined
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

describe('isControllerEdge', () => {
  test('is true for a provider injected into a controller', () => {
    assert.equal(
      isControllerEdge(
        'provider-UserModule-UserService',
        'controller-UserModule-UserController'
      ),
      true
    )
  })

  test('is true with the controller at the source end', () => {
    assert.equal(
      isControllerEdge(
        'controller-UserModule-UserController',
        'provider-UserModule-UserService'
      ),
      true
    )
  })

  test('is false for a provider injected into a provider', () => {
    assert.equal(
      isControllerEdge(
        'provider-UserModule-UserRepository',
        'provider-UserModule-UserService'
      ),
      false
    )
  })

  test('is false for a module import', () => {
    assert.equal(
      isControllerEdge('module-UserModule', 'module-AppModule'),
      false
    )
  })
})

describe('isEdgeVisible', () => {
  const controllerToProvider = {
    source: 'controller-UserModule-UserController',
    target: 'provider-UserModule-UserService'
  }

  test('hiding controller lines hides a controller-to-provider edge its own toggle shows', () => {
    assert.equal(
      isEdgeVisible({
        ...controllerToProvider,
        isShownBySetting: true,
        showControllerLines: false
      }),
      false
    )
  })

  test('hiding controller lines hides a provider-to-controller edge too', () => {
    assert.equal(
      isEdgeVisible({
        source: 'provider-UserModule-UserService',
        target: 'controller-UserModule-UserController',
        isShownBySetting: true,
        showControllerLines: false
      }),
      false
    )
  })

  test('showing controller lines leaves the edge to its own toggle', () => {
    assert.equal(
      isEdgeVisible({
        ...controllerToProvider,
        isShownBySetting: true,
        showControllerLines: true
      }),
      true
    )
    assert.equal(
      isEdgeVisible({
        ...controllerToProvider,
        isShownBySetting: false,
        showControllerLines: true
      }),
      false
    )
  })

  test('the controller toggle never hides an edge without a controller', () => {
    assert.equal(
      isEdgeVisible({
        source: 'provider-UserModule-UserRepository',
        target: 'provider-UserModule-UserService',
        isShownBySetting: true,
        showControllerLines: false
      }),
      true
    )
  })

  // A collapsed module hides its controllers, so a controller's dependency is
  // drawn onto the module node instead; the relationship it names is all that
  // still says a controller is involved.
  test('the controller toggle governs an edge that names a controller relationship', () => {
    assert.equal(
      isEdgeVisible({
        source: 'provider-PaymentModule-PaymentService',
        target: 'module-OrderModule',
        relationship: 'controller',
        isShownBySetting: true,
        showControllerLines: false
      }),
      false
    )
    assert.equal(
      isEdgeVisible({
        source: 'provider-PaymentModule-PaymentService',
        target: 'module-OrderModule',
        relationship: 'controller',
        isShownBySetting: true,
        showControllerLines: true
      }),
      true
    )
  })

  test('naming another relationship never exempts an edge with a controller end', () => {
    assert.equal(
      isEdgeVisible({
        source: 'controller-PaymentModule-PaymentController',
        target: 'module-OrderModule',
        relationship: 'provider',
        isShownBySetting: true,
        showControllerLines: false
      }),
      false
    )
  })

  test('the controller toggle never hides a provider edge between two collapsed modules', () => {
    assert.equal(
      isEdgeVisible({
        source: 'module-PaymentModule',
        target: 'module-OrderModule',
        relationship: 'provider',
        isShownBySetting: true,
        showControllerLines: false
      }),
      true
    )
  })
})

describe('placeDependencyEdge', () => {
  const paymentServiceIntoOrderService = {
    source: 'provider-PaymentModule-PaymentService',
    target: 'provider-OrderModule-OrderService',
    sourceModule: 'PaymentModule',
    targetModule: 'OrderModule'
  }

  const orderRepositoryIntoOrderService = {
    source: 'provider-OrderModule-OrderRepository',
    target: 'provider-OrderModule-OrderService',
    sourceModule: 'OrderModule',
    targetModule: 'OrderModule'
  }

  test('a dependency inside a collapsed module is not drawn', () => {
    assert.deepEqual(
      placeDependencyEdge({
        ...orderRepositoryIntoOrderService,
        isSourceModuleCollapsed: true,
        isTargetModuleCollapsed: true
      }),
      { type: 'hidden' }
    )
  })

  test('a dependency between items on show is drawn between them', () => {
    assert.deepEqual(
      placeDependencyEdge({
        ...orderRepositoryIntoOrderService,
        isSourceModuleCollapsed: false,
        isTargetModuleCollapsed: false
      }),
      { type: 'direct', isInsideModule: true }
    )
    assert.deepEqual(
      placeDependencyEdge({
        ...paymentServiceIntoOrderService,
        isSourceModuleCollapsed: false,
        isTargetModuleCollapsed: false
      }),
      { type: 'direct', isInsideModule: false }
    )
  })

  test('a dependency out of a collapsed module is redrawn from the module node', () => {
    assert.deepEqual(
      placeDependencyEdge({
        ...paymentServiceIntoOrderService,
        isSourceModuleCollapsed: true,
        isTargetModuleCollapsed: false
      }),
      {
        type: 'redirected',
        source: 'module-PaymentModule',
        target: 'provider-OrderModule-OrderService',
        relationship: 'provider',
        key: 'module-PaymentModule->provider-OrderModule-OrderService:provider',
        id: 'e-dep-module-PaymentModule->provider-OrderModule-OrderService-provider',
        isBetweenModules: false,
        itemEdgeKey:
          'provider-PaymentModule-PaymentService->provider-OrderModule-OrderService'
      }
    )
  })

  // Regression: a controller hidden in a collapsed module leaves no
  // `controller-` id at either end of the edge redrawn for its dependency, so
  // only the relationship the placement keeps says what the edge still is.
  test('a controller dependency redrawn onto its collapsed module stays a controller edge, hidden with controller lines', () => {
    const placement = placeDependencyEdge({
      source: 'provider-PaymentModule-PaymentService',
      target: 'controller-OrderModule-OrderController',
      sourceModule: 'PaymentModule',
      targetModule: 'OrderModule',
      isSourceModuleCollapsed: false,
      isTargetModuleCollapsed: true
    })
    assert.ok(placement.type === 'redirected')
    assert.equal(placement.target, 'module-OrderModule')
    assert.equal(isControllerEdge(placement.source, placement.target), false)

    const edge = {
      source: placement.source,
      target: placement.target,
      relationship: placement.relationship
    }
    assert.equal(resolveEdgeRelationship(edge), 'controller')
    assert.equal(
      isEdgeVisible({
        ...edge,
        isShownBySetting: true,
        showControllerLines: false
      }),
      false
    )
    assert.equal(
      isEdgeVisible({
        ...edge,
        isShownBySetting: true,
        showControllerLines: true
      }),
      true
    )
  })

  test('a dependency between two collapsed modules runs module to module', () => {
    const placement = placeDependencyEdge({
      ...paymentServiceIntoOrderService,
      isSourceModuleCollapsed: true,
      isTargetModuleCollapsed: true
    })
    assert.ok(placement.type === 'redirected')
    assert.equal(placement.source, 'module-PaymentModule')
    assert.equal(placement.target, 'module-OrderModule')
    assert.equal(placement.isBetweenModules, true)
    assert.equal(
      placement.id,
      'e-agg-dep-module-PaymentModule->module-OrderModule-provider'
    )
  })

  test('dependencies redrawn onto the same ends share an edge only when the same kind of item depends', () => {
    const placeIntoCollapsedOrderModule = (target: string) =>
      placeDependencyEdge({
        source: 'provider-PaymentModule-PaymentService',
        target,
        sourceModule: 'PaymentModule',
        targetModule: 'OrderModule',
        isSourceModuleCollapsed: false,
        isTargetModuleCollapsed: true
      })
    const service = placeIntoCollapsedOrderModule(
      'provider-OrderModule-OrderService'
    )
    const repository = placeIntoCollapsedOrderModule(
      'provider-OrderModule-OrderRepository'
    )
    const controller = placeIntoCollapsedOrderModule(
      'controller-OrderModule-OrderController'
    )
    assert.ok(
      service.type === 'redirected'
      && repository.type === 'redirected'
      && controller.type === 'redirected'
    )
    assert.equal(service.key, repository.key)
    assert.notEqual(service.key, controller.key)
    assert.notEqual(service.id, controller.id)
  })
})

describe('collectCircularEdgeInfo', () => {
  const paymentIntoOrder
    = 'provider-PaymentModule-PaymentService->provider-OrderModule-OrderService'
  const refundIntoOrder
    = 'provider-PaymentModule-RefundService->provider-OrderModule-OrderService'
  const ledgerIntoOrder
    = 'provider-PaymentModule-LedgerService->provider-OrderModule-OrderService'
  const circularEdges = new Map([
    [paymentIntoOrder, [{ id: 1 }]],
    [refundIntoOrder, [{ id: 1 }, { id: 2 }]]
  ])

  test('an edge carries every cycle its item edges close, each once', () => {
    assert.deepEqual(
      collectCircularEdgeInfo(
        [paymentIntoOrder, refundIntoOrder, ledgerIntoOrder],
        circularEdges
      ).map(info => info.id),
      [1, 2]
    )
  })

  test('an edge whose item edges close no cycle carries none', () => {
    assert.deepEqual(
      collectCircularEdgeInfo([ledgerIntoOrder], circularEdges),
      []
    )
  })

  // Regression: a cycle is recorded under the item edge that closes it, so an
  // edge redrawn between collapsed modules finds nothing under its own ends.
  test('a cycle through collapsed modules stays on the edge redrawn for it', () => {
    const placement = placeDependencyEdge({
      source: 'provider-PaymentModule-PaymentService',
      target: 'provider-OrderModule-OrderService',
      sourceModule: 'PaymentModule',
      targetModule: 'OrderModule',
      isSourceModuleCollapsed: true,
      isTargetModuleCollapsed: true
    })
    assert.ok(placement.type === 'redirected')
    assert.deepEqual(
      collectCircularEdgeInfo(
        [`${placement.source}->${placement.target}`],
        circularEdges
      ),
      []
    )

    const circularInfo = collectCircularEdgeInfo(
      [placement.itemEdgeKey],
      circularEdges
    )
    assert.deepEqual(
      circularInfo.map(info => info.id),
      [1]
    )
    assert.equal(
      resolveEdgeRelationship({
        source: placement.source,
        target: placement.target,
        relationship: placement.relationship,
        isCircular: circularInfo.length > 0
      }),
      'circular'
    )
  })
})

describe('roundedPolylinePath', () => {
  test('draws a straight route as one line', () => {
    assert.equal(
      roundedPolylinePath([{ x: 0, y: 100 }, { x: 0, y: 0 }], 5),
      'M 0,100 L 0,0'
    )
  })

  test('rounds each corner off by the radius', () => {
    assert.equal(
      roundedPolylinePath([{ x: 0, y: 100 }, { x: 0, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 0 }], 5),
      'M 0,100 L 0,55 Q 0,50 5,50 L 75,50 Q 80,50 80,45 L 80,0'
    )
  })

  test('rounds a corner on a short leg by no more than half of it', () => {
    assert.equal(
      roundedPolylinePath([{ x: 0, y: 4 }, { x: 0, y: 0 }, { x: 20, y: 0 }], 5),
      'M 0,4 L 0,2 Q 0,0 2,0 L 20,0'
    )
  })

  test('draws nothing for no points', () => {
    assert.equal(roundedPolylinePath([], 5), '')
  })
})

describe('pickModuleEdgeHandles', () => {
  // An import edge runs from the module imported to its importer.
  const importer: ModuleEdgeBox = { x: 500, y: 0, width: 240, height: 40 }

  test('an import leaves the top of the module imported for the bottom of its importer above', () => {
    const imported: ModuleEdgeBox = { x: 520, y: 140, width: 240, height: 40 }

    assert.deepEqual(pickModuleEdgeHandles({ source: imported, target: importer }), {
      sourceHandle: 'source-top',
      targetHandle: 'target-bottom'
    })
  })

  test('the import closing a cycle, its importer below, leaves the bottom for the importer\'s top', () => {
    const importerBelow: ModuleEdgeBox = { x: 900, y: 420, width: 240, height: 40 }

    assert.deepEqual(pickModuleEdgeHandles({ source: importer, target: importerBelow }), {
      sourceHandle: 'source-bottom',
      targetHandle: 'target-top'
    })
  })

  test('joins two modules in different layers bottom to top, however far apart across', () => {
    const farAside: ModuleEdgeBox = { x: -1400, y: 140, width: 240, height: 40 }

    assert.deepEqual(pickModuleEdgeHandles({ source: farAside, target: importer }), {
      sourceHandle: 'source-top',
      targetHandle: 'target-bottom'
    })
  })

  test('joins two modules level with each other side to side, towards each other', () => {
    const tallBeside: ModuleEdgeBox = { x: 900, y: -100, width: 492, height: 352 }

    assert.deepEqual(pickModuleEdgeHandles({ source: importer, target: tallBeside }), {
      sourceHandle: 'source-right',
      targetHandle: 'target-left'
    })
    assert.deepEqual(pickModuleEdgeHandles({ source: tallBeside, target: importer }), {
      sourceHandle: 'source-left',
      targetHandle: 'target-right'
    })
  })
})
