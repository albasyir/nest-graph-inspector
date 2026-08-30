import { strict as assert } from 'node:assert'
import {
  appendOutputPath,
  normalizeSourceUrl,
  resolveDirectRunUrl
} from './inspector-endpoint-url.ts'

const ENDPOINT = 'http://0.0.0.0:53371/__graph-inspector'

// What a developer types is rarely a full URL, so a bare host and a host with no
// path both have to resolve to the default mount.
assert.equal(normalizeSourceUrl('localhost:53371'), 'http://localhost:53371/__graph-inspector')
assert.equal(normalizeSourceUrl('  localhost:53371  '), 'http://localhost:53371/__graph-inspector')
assert.equal(normalizeSourceUrl('http://localhost:53371'), 'http://localhost:53371/__graph-inspector')
assert.equal(normalizeSourceUrl('http://localhost:53371/'), 'http://localhost:53371/__graph-inspector')
assert.equal(normalizeSourceUrl('https://example.com'), 'https://example.com/__graph-inspector')

// A path the developer did give is theirs, not to be replaced.
assert.equal(normalizeSourceUrl('localhost:3000/custom'), 'http://localhost:3000/custom')

// https must survive: rewriting it to http would silently downgrade.
assert.ok(normalizeSourceUrl('https://example.com/graph').startsWith('https://'))

assert.throws(() => normalizeSourceUrl('not a url'))

// Files served beneath the endpoint.
assert.equal(appendOutputPath(ENDPOINT, 'output.json'), `${ENDPOINT}/output.json`)
assert.equal(appendOutputPath(`${ENDPOINT}/`, 'output.json'), `${ENDPOINT}/output.json`)
assert.equal(appendOutputPath(`${ENDPOINT}///`, 'output.md'), `${ENDPOINT}/output.md`)

// A query on the endpoint stays on the derived file URL — this is how the
// endpoint's own parameters survive, and why the token must never be one.
assert.equal(
  appendOutputPath(`${ENDPOINT}?keep=1`, 'output.json'),
  `${ENDPOINT}/output.json?keep=1`
)

// Nothing to build from means nothing to fetch, which every caller checks for.
assert.equal(appendOutputPath('', 'output.json'), '')
assert.equal(appendOutputPath('not a url', 'output.json'), '')

// A live application serves Direct Run at its origin root...
assert.equal(resolveDirectRunUrl(ENDPOINT, false), 'http://0.0.0.0:53371/direct-run')

// ...while a static graph is a directory of files, so its fixture sits beside
// them rather than at the root, where nothing would be served.
assert.equal(
  resolveDirectRunUrl('http://localhost:3000/mock-graph', true),
  'http://localhost:3000/mock-graph/direct-run'
)
assert.equal(
  resolveDirectRunUrl('http://localhost:3000/mock-graph/', true),
  'http://localhost:3000/mock-graph/direct-run'
)

// The query and fragment must be dropped: the history URLs are built by
// appending a path onto this result, and a surviving query would put that path
// inside a parameter value instead.
const directRun = resolveDirectRunUrl(`${ENDPOINT}?token=secret#frag`, false)
assert.equal(directRun, 'http://0.0.0.0:53371/direct-run')
assert.ok(!directRun.includes('secret'))
assert.equal(
  `${directRun}/history/index.json`,
  'http://0.0.0.0:53371/direct-run/history/index.json'
)

assert.equal(resolveDirectRunUrl('', false), '')
assert.equal(resolveDirectRunUrl('not a url', true), '')

console.log('inspector-endpoint-url.test.ts ok')
