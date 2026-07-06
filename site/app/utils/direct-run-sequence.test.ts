// @ts-nocheck
import { strict as assert } from 'node:assert'
import { buildRuntimeTraceSequenceDiagram } from './direct-run-sequence.ts'

const diagram = buildRuntimeTraceSequenceDiagram({
  traceId: 'trace-1',
  runId: 'run-1',
  entrypoint: { methodName: 'ping' },
  startedAt: '2026-07-04T12:00:00.000Z',
  endedAt: '2026-07-04T12:00:00.021Z',
  totalDurationMs: 21,
  status: 'success',
  totalSpans: 2,
  slowestSpanId: 'span-2',
  spans: [
    {
      spanId: 'span-2',
      parentSpanId: 'span-1',
      traceId: 'trace-1',
      runId: 'run-1',
      order: 1,
      name: 'ProductService.find',
      type: 'provider',
      moduleName: 'ProductModule',
      className: 'ProductService',
      methodName: 'find',
      startedAt: '2026-07-04T12:00:00.011Z',
      endedAt: '2026-07-04T12:00:00.021Z',
      durationMs: 11,
      status: 'success'
    },
    {
      spanId: 'span-1',
      traceId: 'trace-1',
      runId: 'run-1',
      order: 0,
      name: 'UserService.ping',
      type: 'provider',
      moduleName: 'UserModule',
      className: 'UserService',
      methodName: 'ping',
      startedAt: '2026-07-04T12:00:00.000Z',
      endedAt: '2026-07-04T12:00:00.010Z',
      durationMs: 10,
      status: 'success'
    }
  ]
})

assert.equal(diagram.nodes.filter(node => node.data?.kind === 'participant').length, 2)
assert.equal(diagram.nodes.filter(node => node.data?.kind === 'step').length, 2)
assert.equal(diagram.edges.length, 4)
assert.equal(diagram.edges[2]?.source, 'participant:UserService')
assert.equal(diagram.edges[2]?.target, 'step:span-2')
assert.equal(diagram.nodes.find(node => node.id === 'step:span-1')?.position.y, 124)
assert.equal(diagram.nodes.find(node => node.id === 'step:span-2')?.position.y, 248)

console.log('direct-run-sequence.test.ts ok')
