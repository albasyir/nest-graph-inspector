import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import {
  INSPECTOR_ACCESS_TOKEN_PARAM,
  decodeEndpointUrl,
  readAccessToken,
  redactAccessToken,
  withAccessToken
} from './inspector-access-token.ts'
import { createGraphViewerEventProperties } from './graph-viewer-analytics.ts'

const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'
// The default host, which is what the printed viewer link uses.
const ENDPOINT = `http://0.0.0.0:53371/__graph-inspector?${INSPECTOR_ACCESS_TOKEN_PARAM}=${TOKEN}`

// The library encodes the endpoint with the base64url alphabet. Whether that
// produces '-' or '_' depends on how the origin, path, and token align, and
// the default origin carrying a token does produce them — which plain atob
// would reject.
const encoded = Buffer.from(ENDPOINT).toString('base64url')
assert.ok(/[-_]/.test(encoded), 'expected a base64url-only alphabet in fixture')
assert.equal(decodeEndpointUrl(encoded), ENDPOINT)

// Standard base64 from btoa still decodes, so viewer links keep working.
assert.equal(
  decodeEndpointUrl(Buffer.from(ENDPOINT).toString('base64')),
  ENDPOINT
)

assert.equal(readAccessToken(ENDPOINT), TOKEN)
assert.equal(readAccessToken('http://0.0.0.0:53371/__graph-inspector'), undefined)
assert.equal(readAccessToken('not a url'), undefined)

// Derived endpoints are rebuilt from the origin, so the token must be copied on.
const derived = new URL('http://0.0.0.0:53371/direct-run')
assert.equal(
  withAccessToken(derived, ENDPOINT).searchParams.get(INSPECTOR_ACCESS_TOKEN_PARAM),
  TOKEN
)

// Redaction: the token must not survive into anything shipped off the browser.
const redacted = redactAccessToken(ENDPOINT)
assert.ok(!redacted.includes(TOKEN), 'redacted url still carries the token')
assert.equal(redacted, 'http://0.0.0.0:53371/__graph-inspector')

assert.equal(
  redactAccessToken('http://0.0.0.0:53371/__graph-inspector'),
  'http://0.0.0.0:53371/__graph-inspector'
)

// Other query parameters survive redaction.
const withExtras = redactAccessToken(
  `http://0.0.0.0:53371/graph?keep=1&${INSPECTOR_ACCESS_TOKEN_PARAM}=${TOKEN}&also=2`
)
assert.ok(!withExtras.includes(TOKEN))
assert.ok(withExtras.includes('keep=1'))
assert.ok(withExtras.includes('also=2'))

// Unparseable input still gets scrubbed rather than passed through.
const malformed = redactAccessToken(
  `::not-a-url::?${INSPECTOR_ACCESS_TOKEN_PARAM}=${TOKEN}`
)
assert.ok(!malformed.includes(TOKEN), 'malformed url leaked the token')

// The analytics payload is the sink that matters most. The viewer route is
// `/view/<base64url endpoint>`, so the token also reaches it encoded — asserting
// only on the raw token would pass while the encoded one leaks.
const properties = createGraphViewerEventProperties({
  graphUrl: ENDPOINT,
  viewerRoute: `/view/${encoded}/issues`,
  loadSource: 'initial_mount'
})
const serialized = JSON.stringify(properties)

assert.ok(!serialized.includes(TOKEN), 'analytics leaked the access token')
assert.ok(
  !serialized.includes(encoded),
  'analytics leaked the encoded endpoint, which contains the token'
)
assert.equal(properties.viewer_route, '/view/[url]/issues')
assert.equal(properties.graph_url, 'http://0.0.0.0:53371/__graph-inspector')
assert.equal(properties.graph_url_host, '0.0.0.0:53371')
assert.equal(properties.graph_url_path, '/__graph-inspector')

// A route with no encoded segment is left alone.
assert.equal(
  createGraphViewerEventProperties({
    graphUrl: '',
    viewerRoute: '/view',
    loadSource: 'initial_mount'
  }).viewer_route,
  '/view'
)

console.log('inspector-access-token.test.ts ok')
