import { strict as assert } from 'node:assert'
import {
  DIRECT_RUN_UNEXPECTED_RESPONSE_MESSAGE,
  buildDirectRunArgsJsonSchema,
  buildDirectRunArgsSchema,
  buildDirectRunEditorPath,
  buildDirectRunRequest,
  buildDirectRunSnapshot,
  canRerunSpanAsProvider,
  directRunRequestSchema,
  directRunTargetTypeSchema,
  findDirectRunTarget,
  getDirectRunMethodHttp,
  getDirectRunMethodSignature,
  getDirectRunNodeId,
  getDirectRunParameterCount,
  getDirectRunParameterInfos,
  getDirectRunProviderState,
  getDirectRunTargetState,
  parseDirectRunArgs,
  parseDirectRunRequest,
  parseDirectRunResultPayload,
  resolveDirectRunFailure,
  resolveDirectRunResponse,
  summarizeDirectRunResult,
  typeScriptTypeToZodSchema
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

// --- Target state: read from the target's own instance table ---------------

const stateGraph = {
  modules: {
    UserModule: {
      imports: [],
      exports: [],
      providers: [
        {
          name: 'Shared',
          dependencies: [],
          directRun: { methods: [{ name: 'fromProvider', parameterTypes: '[]' }] }
        }
      ],
      controllers: [
        {
          name: 'Shared',
          dependencies: [],
          directRun: { methods: [{ name: 'fromController', parameterTypes: '[]' }] }
        }
      ]
    }
  }
}
assert.deepEqual(
  getDirectRunTargetState(stateGraph, {
    moduleName: 'UserModule',
    targetType: 'controller',
    targetName: 'Shared'
  })?.methods.map(method => method.name),
  ['fromController']
)
assert.deepEqual(
  getDirectRunTargetState(stateGraph, {
    moduleName: 'UserModule',
    targetType: 'provider',
    targetName: 'Shared'
  })?.methods.map(method => method.name),
  ['fromProvider']
)
assert.equal(
  getDirectRunTargetState(stateGraph, {
    moduleName: 'OrderModule',
    targetType: 'provider',
    targetName: 'Shared'
  }),
  null
)
// An inherited key is not a module of the graph.
assert.equal(
  getDirectRunTargetState(stateGraph, {
    moduleName: 'constructor',
    targetType: 'provider',
    targetName: 'Shared'
  }),
  null
)

// --- Request schema ---------------------------------------------------------

assert.equal(directRunTargetTypeSchema.safeParse('provider').success, true)
assert.equal(directRunTargetTypeSchema.safeParse('controller').success, true)
assert.equal(directRunTargetTypeSchema.safeParse('module').success, false)

assert.deepEqual(
  parseDirectRunRequest({
    module: 'UserModule',
    target: 'controller',
    controller: 'UserController',
    method: 'getUser',
    args: ['42']
  }),
  {
    module: 'UserModule',
    target: 'controller',
    controller: 'UserController',
    method: 'getUser',
    args: ['42']
  }
)
// A request names its instance through the field matching its target only.
assert.equal(
  directRunRequestSchema.safeParse({
    module: 'UserModule',
    target: 'provider',
    provider: 'Shared',
    controller: 'Shared',
    method: 'find'
  }).success,
  false
)
assert.equal(
  directRunRequestSchema.safeParse({
    module: 'UserModule',
    target: 'controller',
    provider: 'Shared',
    method: 'find'
  }).success,
  false
)
// `target` is always sent: the viewer never leans on the server's default.
assert.equal(
  directRunRequestSchema.safeParse({
    module: 'UserModule',
    provider: 'UserService',
    method: 'find'
  }).success,
  false
)
for (const blank of ['', '   ']) {
  assert.throws(
    () =>
      buildDirectRunRequest({
        moduleName: 'UserModule',
        targetType: 'provider',
        targetName: 'UserService',
        methodName: blank
      }),
    /Invalid Direct Run request: method: must not be empty/
  )
}
assert.throws(
  () =>
    buildDirectRunRequest({
      moduleName: '',
      targetType: 'controller',
      targetName: 'UserController',
      methodName: 'getUser'
    }),
  /Invalid Direct Run request: module: must not be empty/
)
// No args key at all when there is nothing to send — not `args: undefined`.
assert.equal(
  Object.hasOwn(
    buildDirectRunRequest({
      moduleName: 'UserModule',
      targetType: 'provider',
      targetName: 'UserService',
      methodName: 'ping'
    }),
    'args'
  ),
  false
)
// A one-parameter method that takes an array still gets the array as is.
assert.deepEqual(
  buildDirectRunRequest({
    moduleName: 'UserModule',
    targetType: 'provider',
    targetName: 'UserService',
    methodName: 'sum',
    args: [[1, 2, 3]]
  }).args,
  [1, 2, 3]
)

// --- Response schema --------------------------------------------------------

const validTrace = {
  traceId: 'trace-1',
  runId: 'run-1',
  entrypoint: { methodName: 'ping' },
  startedAt: '2026-06-28T10:00:00.000Z',
  endedAt: '2026-06-28T10:00:01.000Z',
  totalDurationMs: 1000,
  status: 'success',
  totalSpans: 0,
  spans: []
}
assert.deepEqual(
  parseDirectRunResultPayload({
    ok: true,
    method: 'ping',
    result: { pong: true },
    traceId: 'trace-1',
    runtimeTrace: validTrace,
    unrelated: 'dropped'
  }),
  {
    ok: true,
    method: 'ping',
    result: { pong: true },
    traceId: 'trace-1',
    runtimeTrace: validTrace
  }
)
// An unreadable trace is dropped; the result it came with is kept.
assert.deepEqual(
  parseDirectRunResultPayload({
    ok: true,
    result: 1,
    runtimeTrace: { traceId: 7 }
  }),
  { ok: true, result: 1 }
)
assert.equal(parseDirectRunResultPayload({ result: 1 }), null)
assert.equal(parseDirectRunResultPayload({ ok: 'yes' }), null)
assert.equal(parseDirectRunResultPayload({ ok: false, error: 404 }), null)
assert.equal(parseDirectRunResultPayload('<html>'), null)
assert.equal(parseDirectRunResultPayload(null), null)

assert.deepEqual(resolveDirectRunResponse({ ok: true }), { ok: true })
assert.deepEqual(resolveDirectRunResponse('<html>'), {
  ok: false,
  error: DIRECT_RUN_UNEXPECTED_RESPONSE_MESSAGE
})

// A refusal answers with the payload saying why.
assert.deepEqual(
  resolveDirectRunFailure(
    Object.assign(new Error('400 Bad Request'), {
      data: { ok: false, error: 'Method find expects 2 arguments.' }
    })
  ),
  {
    payload: { ok: false, error: 'Method find expects 2 arguments.' },
    answered: true
  }
)
assert.deepEqual(
  resolveDirectRunFailure(Object.assign(new Error('500'), { data: { ok: false } })),
  { payload: { ok: false, error: 'Direct run failed.' }, answered: true }
)
// No payload: a network failure, or a request refused before it was sent.
assert.deepEqual(resolveDirectRunFailure(new Error('fetch failed')), {
  payload: { ok: false, error: 'fetch failed' },
  answered: false
})
assert.deepEqual(
  resolveDirectRunFailure(Object.assign(new Error('502'), { data: '<html>' })),
  { payload: { ok: false, error: '502' }, answered: false }
)
assert.deepEqual(resolveDirectRunFailure('boom'), {
  payload: { ok: false, error: 'Direct run failed.' },
  answered: false
})

// --- Parameters and signatures ----------------------------------------------

const noArgs = { name: 'ping', parameterTypes: '[]' }
const oneArg = { name: 'find', parameterTypes: '[id: number]' }
const twoArgs = {
  name: 'update',
  parameterTypes: '[id: string, patch: { name?: string; age: number | null }]'
}
const routed = {
  name: 'getUser',
  parameterTypes: '[id: string]',
  http: { method: 'GET', path: '/users/:id' }
}

assert.equal(getDirectRunParameterCount(noArgs), 0)
assert.equal(getDirectRunParameterCount({ parameterTypes: '' }), 0)
assert.equal(getDirectRunParameterCount({ parameterTypes: 'not a tuple' }), 0)
assert.equal(getDirectRunParameterCount(twoArgs), 2)
assert.deepEqual(
  getDirectRunParameterInfos({
    parameterTypes: '[...ids: string[], readonly flag?: boolean, Map<string, number>]'
  }).map(({ name, type }) => ({ name, type })),
  [
    { name: 'ids', type: 'string[]' },
    { name: 'flag', type: 'boolean' },
    { name: 'arg3', type: 'Map<string, number>' }
  ]
)
assert.equal(getDirectRunMethodSignature(noArgs), 'ping()')
assert.equal(getDirectRunMethodSignature(twoArgs), 'update(id, patch)')
assert.deepEqual(getDirectRunMethodHttp(routed), { method: 'GET', path: '/users/:id' })
assert.equal(getDirectRunMethodHttp(oneArg), undefined)

// --- TypeScript type text → runtime schema ----------------------------------

const accepts = (type: string, value: unknown) =>
  typeScriptTypeToZodSchema(type).safeParse(value).success

assert.equal(accepts('string', 'a'), true)
assert.equal(accepts('string', 1), false)
assert.equal(accepts('number', 1.5), true)
assert.equal(accepts('number', '1'), false)
assert.equal(accepts('boolean', false), true)
assert.equal(accepts('null', null), true)
assert.equal(accepts('null', 0), false)
assert.equal(accepts('object', {}), true)
assert.equal(accepts('object', []), false)
assert.equal(accepts('object', null), false)
// A type the viewer cannot see into accepts any JSON value.
for (const opaque of ['unknown', 'any', 'CreateUserDto', 'Date', 'Partial<User>']) {
  assert.equal(accepts(opaque, { anything: [1] }), true)
}
assert.equal(accepts('\'admin\'', 'admin'), true)
assert.equal(accepts('\'admin\'', 'user'), false)
assert.equal(accepts('"a" | "b" | 3', 3), true)
assert.equal(accepts('"a" | "b" | 3', 'c'), false)
assert.equal(accepts('string | number', 1), true)
assert.equal(accepts('string | number', true), false)
assert.equal(accepts('string | undefined', 'a'), true)
assert.equal(accepts('(string)', 'a'), true)
assert.equal(accepts('number[]', [1, 2]), true)
assert.equal(accepts('number[]', [1, '2']), false)
assert.equal(accepts('Array<string>', ['a']), true)
assert.equal(accepts('ReadonlyArray<string>', [1]), false)
assert.equal(accepts('(string | number)[]', ['a', 1]), true)
assert.equal(accepts('[string, number]', ['a', 1]), true)
assert.equal(accepts('[string, number]', ['a', 1, 2]), false)
assert.equal(accepts('{ id: number; name?: string }', { id: 1 }), true)
assert.equal(accepts('{ id: number; name?: string }', { id: 1, extra: true }), true)
assert.equal(accepts('{ id: number; name?: string }', { name: 'x' }), false)
assert.equal(accepts('{ id: number; name?: string }', { id: 1, name: 2 }), false)
assert.equal(accepts('{ tag: string | undefined }', {}), true)
// Separators inside a nested type or a string literal are not top-level.
assert.equal(
  accepts('{ range: [number, number], label: \'a, b\' }', {
    range: [1, 2],
    label: 'a, b'
  }),
  true
)

// --- Arguments --------------------------------------------------------------

assert.deepEqual(parseDirectRunArgs(noArgs, ''), { ok: true, args: undefined })
assert.deepEqual(parseDirectRunArgs(noArgs, 'ignored'), { ok: true, args: undefined })
assert.deepEqual(parseDirectRunArgs(oneArg, '[7]'), { ok: true, args: [7] })
assert.deepEqual(
  parseDirectRunArgs(twoArgs, '["u1", { "age": null, "name": "Ada" }]'),
  { ok: true, args: ['u1', { age: null, name: 'Ada' }] }
)
assert.deepEqual(parseDirectRunArgs(oneArg, '  '), {
  ok: false,
  error: 'Enter JSON arguments for find().'
})
assert.deepEqual(parseDirectRunArgs(oneArg, '[7,]'), {
  ok: false,
  error: 'Arguments must be valid JSON.'
})
assert.deepEqual(parseDirectRunArgs(oneArg, '7'), {
  ok: false,
  error: 'find() takes its arguments as a JSON array.'
})
assert.deepEqual(parseDirectRunArgs(oneArg, '[]'), {
  ok: false,
  error: 'find() expects 1 argument.'
})
assert.deepEqual(parseDirectRunArgs(twoArgs, '["u1"]'), {
  ok: false,
  error: 'update() expects 2 arguments.'
})
assert.deepEqual(parseDirectRunArgs(twoArgs, '["u1", {}, 3]'), {
  ok: false,
  error: 'update() expects 2 arguments.'
})

// A failure names the parameter, and the path into it.
const typeError = parseDirectRunArgs(oneArg, '["7"]')
assert.equal(typeError.ok, false)
assert.match(!typeError.ok ? typeError.error : '', /^id: .*number/)
const nestedError = parseDirectRunArgs(twoArgs, '["u1", { "age": "old" }]')
assert.equal(nestedError.ok, false)
assert.match(!nestedError.ok ? nestedError.error : '', /^patch\.age: /)
const missingError = parseDirectRunArgs(twoArgs, '["u1", { "name": "Ada" }]')
assert.equal(missingError.ok, false)
assert.match(!missingError.ok ? missingError.error : '', /^patch\.age: /)
const itemError = parseDirectRunArgs(
  { name: 'tag', parameterTypes: '[tags: string[]]' },
  '[["a", 2]]'
)
assert.match(!itemError.ok ? itemError.error : '', /^tags\[1\]: /)

// The runtime schema is the same check, usable on its own.
assert.equal(buildDirectRunArgsSchema(twoArgs).safeParse(['u1', { age: 3 }]).success, true)
assert.equal(buildDirectRunArgsSchema(twoArgs).safeParse(['u1', { age: '3' }]).success, false)
assert.equal(buildDirectRunArgsSchema(noArgs).safeParse([]).success, true)
assert.equal(buildDirectRunArgsSchema(noArgs).safeParse([1]).success, false)
// Cached per method object, and rebuilt if its parameter types change.
assert.equal(buildDirectRunArgsSchema(twoArgs), buildDirectRunArgsSchema(twoArgs))
const mutable = { name: 'grow', parameterTypes: '[a: string]' }
const before = buildDirectRunArgsSchema(mutable)
mutable.parameterTypes = '[a: string, b: number]'
assert.notEqual(buildDirectRunArgsSchema(mutable), before)
assert.equal(parseDirectRunArgs(mutable, '["x", 1]').ok, true)

// --- The editor's JSON Schema -----------------------------------------------

const twoArgsJsonSchema = buildDirectRunArgsJsonSchema(twoArgs)
assert.equal(twoArgsJsonSchema.type, 'array')
assert.equal(twoArgsJsonSchema.title, 'update() arguments')
assert.equal(twoArgsJsonSchema.minItems, 2)
assert.equal(twoArgsJsonSchema.maxItems, 2)
assert.ok(Array.isArray(twoArgsJsonSchema.items))
const [idItem, patchItem] = twoArgsJsonSchema.items as Array<Record<string, unknown>>
assert.equal(idItem?.title, 'id')
assert.equal(idItem?.description, 'string')
assert.equal(idItem?.type, 'string')
assert.equal(patchItem?.title, 'patch')
assert.equal(patchItem?.type, 'object')
assert.deepEqual(patchItem?.required, ['age'])
assert.deepEqual(buildDirectRunArgsJsonSchema(oneArg).description, 'JSON array passed as id: number.')
const noArgsJsonSchema = buildDirectRunArgsJsonSchema(noArgs)
assert.equal(noArgsJsonSchema.minItems, 0)
assert.equal(noArgsJsonSchema.maxItems, 0)
// The editor's schema is plain JSON: Monaco serialises it to register it.
assert.deepEqual(JSON.parse(JSON.stringify(twoArgsJsonSchema)), twoArgsJsonSchema)

console.log('direct-run-provider.test.ts ok')
