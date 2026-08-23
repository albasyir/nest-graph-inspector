import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import {
  INSPECTOR_ACCESS_TOKEN_HEADER,
  INSPECTOR_ACCESS_TOKEN_PARAM,
  accessTokenHeaders,
  readAccessToken,
  redactAccessToken
} from './inspector-access-token.ts'
import { createGraphViewerEventProperties } from './graph-viewer-analytics.ts'

const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'
// The default host, which is what the printed viewer link uses.
const ENDPOINT = 'http://0.0.0.0:53371/__graph-inspector'
const BOOTSTRAP_ENDPOINT = `${ENDPOINT}?${INSPECTOR_ACCESS_TOKEN_PARAM}=${TOKEN}`

// The endpoint as the printed link carries it. Decoding that link is covered by
// viewer-bootstrap-link.test.ts; this file is the token contract itself.
const encoded = Buffer.from(BOOTSTRAP_ENDPOINT).toString('base64url')

assert.equal(readAccessToken(BOOTSTRAP_ENDPOINT), TOKEN)
assert.equal(readAccessToken(ENDPOINT), undefined)
assert.equal(readAccessToken('not a url'), undefined)

// Redaction: the token must not survive into anything shipped off the browser.
const redacted = redactAccessToken(BOOTSTRAP_ENDPOINT)
assert.ok(!redacted.includes(TOKEN), 'redacted url still carries the token')
assert.equal(redacted, ENDPOINT)

assert.equal(redactAccessToken(ENDPOINT), ENDPOINT)

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

// Requests authenticate through a header, so no derived URL has to carry a
// token — which is what kept breaking when one was concatenated onto.
assert.deepEqual(accessTokenHeaders(TOKEN), {
  [INSPECTOR_ACCESS_TOKEN_HEADER]: TOKEN
})
assert.deepEqual(accessTokenHeaders(''), {})
assert.deepEqual(accessTokenHeaders(undefined), {})

// The analytics payload is the sink that matters most. The viewer route is
// `/view/<base64url endpoint>`, so a token also reaches it encoded — asserting
// only on the raw token would pass while the encoded one leaks.
const properties = createGraphViewerEventProperties({
  graphUrl: BOOTSTRAP_ENDPOINT,
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
assert.equal(properties.graph_url, ENDPOINT)
assert.equal(properties.graph_url_host, '0.0.0.0:53371')
assert.equal(properties.graph_url_path, '/__graph-inspector')

// A transport error quotes the URL it failed on, so the error message is a URL
// in disguise — and the failing request is exactly the one a token was on.
const failure = createGraphViewerEventProperties({
  graphUrl: BOOTSTRAP_ENDPOINT,
  viewerRoute: `/view/${encoded}`,
  loadSource: 'manual_refresh',
  errorMessage: `[GET] "${BOOTSTRAP_ENDPOINT}": 401 Unauthorized`
})

assert.ok(
  !JSON.stringify(failure).includes(TOKEN),
  'analytics leaked the access token through an error message'
)
assert.ok(failure.error_message?.includes('401 Unauthorized'))

// A partially stripped token is still a leak, and a scrub that stops early
// leaves the tail behind while an assertion on the whole token still passes.
const tokenFragments = TOKEN.split(/[.\-_]/).filter(part => part.length > 3)
assert.ok(tokenFragments.length >= 3, 'expected a multi-part token fixture')

for (const fragment of tokenFragments) {
  assert.ok(
    !failure.error_message?.includes(fragment),
    `error message kept the token fragment ${fragment}`
  )
  assert.ok(
    !malformed.includes(fragment),
    `malformed url kept the token fragment ${fragment}`
  )
  assert.ok(
    !redacted.includes(fragment),
    `redacted url kept the token fragment ${fragment}`
  )
  assert.ok(
    !withExtras.includes(fragment),
    `redacted query kept the token fragment ${fragment}`
  )
}

// A route with no encoded segment is left alone.
assert.equal(
  createGraphViewerEventProperties({
    graphUrl: '',
    viewerRoute: '/view',
    loadSource: 'initial_mount'
  }).viewer_route,
  '/view'
)

// The viewer's own pages must survive intact: which view a load or a failure
// happened on is the whole point of the property, and a redaction that collapsed
// them would leave every event in one bucket while still passing the leak check
// above.
for (const page of ['/view/navigator', '/view/issues', '/view/execution-sequence']) {
  assert.equal(
    createGraphViewerEventProperties({
      graphUrl: ENDPOINT,
      viewerRoute: page,
      loadSource: 'route_change'
    }).viewer_route,
    page,
    `analytics collapsed the ${page} route`
  )
}

console.log('inspector-access-token.test.ts ok')
