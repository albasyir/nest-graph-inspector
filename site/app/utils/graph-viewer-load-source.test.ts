// @ts-nocheck
import { strict as assert } from 'node:assert'
import { resolveGraphViewerLoadSource } from './graph-viewer-analytics.ts'

assert.equal(resolveGraphViewerLoadSource(false), 'initial_mount')
assert.equal(resolveGraphViewerLoadSource(true), 'route_change')

console.log('graph-viewer-load-source.test.ts ok')
