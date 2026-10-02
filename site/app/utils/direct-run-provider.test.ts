import { strict as assert } from 'node:assert'
import {
  buildDirectRunEditorPath,
  buildDirectRunRequest,
  buildDirectRunSnapshot,
  canRerunSpanAsProvider,
  findDirectRunTarget,
  getDirectRunNodeId,
  getDirectRunProviderState,
  summarizeDirectRunResult
} from './direct-run-provider.ts'

// A module holding a provider and a controller of the same name: the case
// every Direct Run identity check below exists for.
const sameNameGraph = {
  modules: {
    UserModule: {
      imports: [],
      exports: [],
      providers: [
        { name: 'Shared', dependencies: [] },
        { name: 'UserService', dependencies: [] }
      ],
      controllers: [
        { name: 'Shared', dependencies: [] },
        { name: 'UserController', dependencies: [] }
      ]
    }
  }
}

assert.equal(
  getDirectRunNodeId('provider', 'UserModule', 'Shared'),
  'provider-UserModule-Shared'
)
assert.equal(
  getDirectRunNodeId('controller', 'UserModule', 'Shared'),
  'controller-UserModule-Shared'
)

// The id names the target type, so each same-named node resolves to itself.
assert.deepEqual(
  findDirectRunTarget(sameNameGraph, 'controller-UserModule-Shared'),
  {
    nodeId: 'controller-UserModule-Shared',
    moduleName: 'UserModule',
    targetType: 'controller',
    targetName: 'Shared'
  }
)
assert.deepEqual(
  findDirectRunTarget(sameNameGraph, 'provider-UserModule-Shared'),
  {
    nodeId: 'provider-UserModule-Shared',
    moduleName: 'UserModule',
    targetType: 'provider',
    targetName: 'Shared'
  }
)
for (const [targetType, targetName] of [
  ['provider', 'UserService'],
  ['controller', 'UserController']
] as const) {
  const nodeId = getDirectRunNodeId(targetType, 'UserModule', targetName)
  assert.deepEqual(findDirectRunTarget(sameNameGraph, nodeId), {
    nodeId,
    moduleName: 'UserModule',
    targetType,
    targetName
  })
}
// A bare class name — what `direct-run-on` carried before it carried node
// ids — resolves to nothing, so it cannot pick a provider for a controller.
assert.equal(findDirectRunTarget(sameNameGraph, 'Shared'), null)
assert.equal(findDirectRunTarget(sameNameGraph, 'UserController'), null)
assert.equal(
  findDirectRunTarget(sameNameGraph, 'controller-OrderModule-Shared'),
  null
)
assert.equal(findDirectRunTarget(sameNameGraph, undefined), null)

// Same module, same name, same method: separate editor models and schemas.
assert.equal(
  buildDirectRunEditorPath(
    { targetType: 'controller', moduleName: 'UserModule', targetName: 'Shared' },
    'find'
  ),
  'direct-run://controller/UserModule/Shared/find.json'
)
assert.notEqual(
  buildDirectRunEditorPath(
    { targetType: 'controller', moduleName: 'UserModule', targetName: 'Shared' },
    'find'
  ),
  buildDirectRunEditorPath(
    { targetType: 'provider', moduleName: 'UserModule', targetName: 'Shared' },
    'find'
  )
)

// A trace span says nothing about its target type, so only a class the graph
// knows solely as a provider of that module may be re-run.
const spanOf = (className: string) => ({
  moduleName: 'UserModule',
  className,
  methodName: 'find'
})
assert.equal(canRerunSpanAsProvider(sameNameGraph, spanOf('UserService')), true)
assert.equal(
  canRerunSpanAsProvider(sameNameGraph, spanOf('UserController')),
  false
)
assert.equal(canRerunSpanAsProvider(sameNameGraph, spanOf('Shared')), false)
assert.equal(canRerunSpanAsProvider(sameNameGraph, spanOf('Unknown')), false)
assert.equal(canRerunSpanAsProvider(null, spanOf('UserService')), false)
assert.equal(
  canRerunSpanAsProvider(sameNameGraph, {
    moduleName: 'UserModule',
    className: 'UserService'
  }),
  false
)
assert.equal(
  canRerunSpanAsProvider(sameNameGraph, {
    ...spanOf('UserService'),
    moduleName: 'constructor'
  }),
  false
)

assert.deepEqual(
  getDirectRunProviderState({
    directRun: { methods: [{ name: 'ping', parameterTypes: '[]' }] }
  }),
  {
    runnable: true,
    reason: '',
    methods: [{ name: 'ping', parameterTypes: '[]' }]
  }
)
assert.deepEqual(
  getDirectRunProviderState({
    directRun: { methods: [] }
  }),
  {
    runnable: false,
    reason: 'No public methods available for direct run.',
    methods: []
  }
)
// A controller's methods carry the same shape, plus optional `http` — the
// state builder is target-agnostic and does not need a separate function.
assert.deepEqual(
  getDirectRunProviderState({
    directRun: {
      methods: [
        {
          name: 'getUser',
          parameterTypes: '[id: string]',
          http: { method: 'GET', path: '/users/:id' }
        }
      ]
    }
  }),
  {
    runnable: true,
    reason: '',
    methods: [
      {
        name: 'getUser',
        parameterTypes: '[id: string]',
        http: { method: 'GET', path: '/users/:id' }
      }
    ]
  }
)

assert.deepEqual(
  buildDirectRunRequest({
    moduleName: 'UserModule',
    targetType: 'provider',
    targetName: 'UserService',
    methodName: 'ping'
  }),
  {
    module: 'UserModule',
    target: 'provider',
    provider: 'UserService',
    method: 'ping'
  }
)
assert.deepEqual(
  buildDirectRunRequest({
    moduleName: 'UserModule',
    targetType: 'controller',
    targetName: 'UserController',
    methodName: 'getUserById'
  }),
  {
    module: 'UserModule',
    target: 'controller',
    controller: 'UserController',
    method: 'getUserById'
  }
)
assert.deepEqual(
  buildDirectRunRequest({
    moduleName: 'UserModule',
    targetType: 'provider',
    targetName: 'UserService',
    methodName: 'find',
    args: [{ id: 1 }]
  }),
  {
    module: 'UserModule',
    target: 'provider',
    provider: 'UserService',
    method: 'find',
    args: { id: 1 }
  }
)
assert.deepEqual(
  buildDirectRunRequest({
    moduleName: 'UserModule',
    targetType: 'provider',
    targetName: 'UserService',
    methodName: 'range',
    args: [1, 10]
  }),
  {
    module: 'UserModule',
    target: 'provider',
    provider: 'UserService',
    method: 'range',
    args: [1, 10]
  }
)

assert.equal(
  summarizeDirectRunResult({ ok: true, result: { pong: true } }),
  '{"pong":true}'
)
assert.equal(
  summarizeDirectRunResult({ ok: true, result: undefined }),
  'Completed with no return value.'
)
assert.equal(summarizeDirectRunResult({ ok: false, error: 'boom' }), 'boom')
assert.deepEqual(
  buildDirectRunSnapshot({
    response: {
      ok: true,
      method: 'ping',
      result: { pong: true },
      runId: 'run-1',
      traceId: 'trace-1',
      runtimeTrace: {
        traceId: 'trace-1',
        runId: 'run-1',
        entrypoint: { methodName: 'ping' },
        startedAt: '2026-06-28T10:00:00.000Z',
        endedAt: '2026-06-28T10:00:01.000Z',
        totalDurationMs: 1000,
        status: 'success',
        totalSpans: 1,
        spans: [
          {
            spanId: 'span-1',
            runId: 'run-1',
            order: 0,
            name: 'UserService.ping',
            startedAt: '2026-06-28T10:00:00.000Z',
            endedAt: '2026-06-28T10:00:01.000Z',
            durationMs: 1000,
            status: 'success'
          }
        ]
      }
    },
    requestedMethod: 'ping',
    updatedAt: new Date('2026-06-28T10:00:00.000Z')
  }),
  {
    state: 'success',
    summary: '{"pong":true}',
    method: 'ping',
    updatedAt: '2026-06-28T10:00:00.000Z',
    runId: 'run-1',
    traceId: 'trace-1',
    runtimeTrace: {
      traceId: 'trace-1',
      runId: 'run-1',
      entrypoint: { methodName: 'ping' },
      startedAt: '2026-06-28T10:00:00.000Z',
      endedAt: '2026-06-28T10:00:01.000Z',
      totalDurationMs: 1000,
      status: 'success',
      totalSpans: 1,
      spans: [
        {
          spanId: 'span-1',
          runId: 'run-1',
          order: 0,
          name: 'UserService.ping',
          startedAt: '2026-06-28T10:00:00.000Z',
          endedAt: '2026-06-28T10:00:01.000Z',
          durationMs: 1000,
          status: 'success'
        }
      ]
    }
  }
)

console.log('direct-run-provider.test.ts ok')
