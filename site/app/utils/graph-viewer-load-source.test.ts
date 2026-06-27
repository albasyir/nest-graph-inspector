import { strict as assert } from 'node:assert'
import type { LoadSource } from './graph-viewer-analytics'

function resolveLoadSource(hasTrackedInitialMount: boolean): LoadSource {
  return hasTrackedInitialMount ? 'route_change' : 'initial_mount'
}

assert.equal(resolveLoadSource(false), 'initial_mount')
assert.equal(resolveLoadSource(true), 'route_change')

console.log('graph-viewer-load-source.test.ts ok')
