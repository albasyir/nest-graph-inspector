import { strict as assert } from 'node:assert'
// ponytail: node ESM needs the .ts suffix for this standalone script; Nuxt typecheck doesn't.
// @ts-expect-error standalone node test imports the source file with its real extension
import { resolveGraphViewerLoadSource } from './graph-viewer-analytics.ts'

assert.equal(resolveGraphViewerLoadSource(false), 'initial_mount')
assert.equal(resolveGraphViewerLoadSource(true), 'route_change')
assert.equal(resolveGraphViewerLoadSource(Boolean('previous')), 'route_change')
assert.equal(resolveGraphViewerLoadSource(Boolean('stale-after-failure')), 'route_change')

console.log('graph-viewer-load-source.test.ts ok')
