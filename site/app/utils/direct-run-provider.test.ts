import { strict as assert } from 'node:assert'
import {
  buildDirectRunRequest,
  buildDirectRunSnapshot,
  getDirectRunProviderState,
  parseProviderNodeId,
  summarizeDirectRunResult
} from './direct-run-provider.ts'

assert.deepEqual(parseProviderNodeId('provider-UserModule-UserService'), {
  moduleName: 'UserModule',
  providerName: 'UserService'
})
assert.equal(parseProviderNodeId('controller-UserModule-UserController'), null)

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

assert.deepEqual(buildDirectRunRequest({
  moduleName: 'UserModule',
  providerName: 'UserService',
  methodName: 'ping'
}), {
  module: 'UserModule',
  provider: 'UserService',
  method: 'ping'
})
assert.deepEqual(buildDirectRunRequest({
  moduleName: 'UserModule',
  providerName: 'UserService',
  methodName: 'find',
  args: [{ id: 1 }]
}), {
  module: 'UserModule',
  provider: 'UserService',
  method: 'find',
  args: { id: 1 }
})
assert.deepEqual(buildDirectRunRequest({
  moduleName: 'UserModule',
  providerName: 'UserService',
  methodName: 'range',
  args: [1, 10]
}), {
  module: 'UserModule',
  provider: 'UserService',
  method: 'range',
  args: [1, 10]
})

assert.equal(summarizeDirectRunResult({ ok: true, result: { pong: true } }), '{"pong":true}')
assert.equal(summarizeDirectRunResult({ ok: true, result: undefined }), 'Completed with no return value.')
assert.equal(summarizeDirectRunResult({ ok: false, error: 'boom' }), 'boom')
assert.deepEqual(buildDirectRunSnapshot({
  response: { ok: true, method: 'ping', result: { pong: true } },
  requestedMethod: 'ping',
  updatedAt: new Date('2026-06-28T10:00:00.000Z')
}), {
  state: 'success',
  summary: '{"pong":true}',
  method: 'ping',
  updatedAt: '2026-06-28T10:00:00.000Z'
})

console.log('direct-run-provider.test.ts ok')
