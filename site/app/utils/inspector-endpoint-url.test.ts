import { strict as assert } from 'node:assert'
import {
  appendOutputPath,
  normalizeSourceUrl,
  resolveDirectRunUrl,
  resolveOriginPath
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

// A sibling service at the origin, not under the endpoint's own path.
assert.equal(resolveOriginPath(ENDPOINT, 'ollama'), 'http://0.0.0.0:53371/ollama')
assert.equal(resolveOriginPath(ENDPOINT, '/ollama'), 'http://0.0.0.0:53371/ollama')
assert.equal(resolveOriginPath(ENDPOINT, '///ollama'), 'http://0.0.0.0:53371/ollama')

// The query and fragment must be dropped. Callers append a path onto this
// result, so a surviving query would put that path inside a parameter value —
// which is exactly the bug that broke AI chat when a token lived in the URL.
const derived = resolveOriginPath(`${ENDPOINT}?token=secret#frag`, 'ollama')
assert.equal(derived, 'http://0.0.0.0:53371/ollama')
assert.ok(!derived.includes('secret'))
assert.ok(!derived.includes('?') && !derived.includes('#'))
assert.equal(`${derived}/api/tags`, 'http://0.0.0.0:53371/ollama/api/tags')

assert.equal(resolveOriginPath('', 'ollama'), '')
assert.equal(resolveOriginPath('not a url', 'ollama'), '')

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

// Same reasoning as above: the history URLs are built by appending to this.
const directRun = resolveDirectRunUrl(`${ENDPOINT}?token=secret#frag`, false)
assert.equal(directRun, 'http://0.0.0.0:53371/direct-run')
assert.ok(!directRun.includes('secret'))
assert.equal(
  `${directRun}/history/index.json`,
  'http://0.0.0.0:53371/direct-run/history/index.json'
)

assert.equal(resolveDirectRunUrl('', false), '')
assert.equal(resolveDirectRunUrl('not a url', true), '')

// The in-browser demo's servers are addressed under a segment of this site's
// own origin, so "the root of the application's own server" is a path prefix
// there rather than the origin.
const DEMO_ENDPOINT
  = 'https://albasyir.github.io/nest-graph-inspector/__nodepod__/53371/__graph-inspector'

assert.equal(
  resolveDirectRunUrl(DEMO_ENDPOINT, false),
  'https://albasyir.github.io/nest-graph-inspector/__nodepod__/53371/direct-run'
)
assert.equal(
  resolveOriginPath(DEMO_ENDPOINT, 'ollama'),
  'https://albasyir.github.io/nest-graph-inspector/__nodepod__/53371/ollama'
)
assert.equal(
  appendOutputPath(DEMO_ENDPOINT, 'output.json'),
  'https://albasyir.github.io/nest-graph-inspector/__nodepod__/53371/__graph-inspector/output.json'
)

console.log('inspector-endpoint-url.test.ts ok')
