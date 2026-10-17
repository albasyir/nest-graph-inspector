import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import {
  INSPECTOR_ACCESS_TOKEN_HEADER,
  INSPECTOR_ACCESS_TOKEN_PARAM,
  accessTokenHeaders,
  canOpenWithoutAccessToken,
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

// Something that does not parse cannot be searched reliably — a percent-encoded
// name defeats any textual match — so none of it comes back.
for (const input of [
  `not a url %5F%5Finspector_token=${TOKEN}`,
  `http://local host:53371/?%5F%5Finspector_token=${TOKEN}`
]) {
  assert.equal(redactAccessToken(input), '', input)
}

// The library and `readAccessToken` decode a parameter's name before comparing
// it, so a name spelled with percent-escapes is the token all the same: it has
// to keep authenticating, and redaction has to recognise every such spelling.
for (const name of [
  '%5F%5Finspector_token',
  '%5f%5finspector%5ftoken',
  '__inspector%5Ftoken',
  '__%69nspector_token'
]) {
  const url = `${ENDPOINT}?${name}=${TOKEN}`

  assert.equal(readAccessToken(url), TOKEN, `${name} no longer authenticates`)
  assert.equal(redactAccessToken(url), ENDPOINT, `${name} survived redaction`)
}

// Only the token's pairs go. Every other parameter stays exactly as written,
// and so do the user info and the fragment, which the URL may still need.
assert.equal(
  redactAccessToken(
    `http://dev:pw@0.0.0.0:53371/__graph-inspector?a=b%20c&flag&%5F%5Finspector_token=${TOKEN}&x=~y&${INSPECTOR_ACCESS_TOKEN_PARAM}=${TOKEN}#frag`
  ),
  'http://dev:pw@0.0.0.0:53371/__graph-inspector?a=b%20c&flag&x=~y#frag'
)

// A token parameter left empty is still the token's: `readAccessToken` reports
// that empty value, and a second spelling behind it must not survive.
const shadowed = `${ENDPOINT}?${INSPECTOR_ACCESS_TOKEN_PARAM}=&%5F%5Finspector_token=${TOKEN}`
assert.equal(readAccessToken(shadowed), '')
assert.equal(redactAccessToken(shadowed), ENDPOINT)

// A URL with no token pair comes back exactly as given, not even normalised,
// and a parameter that merely contains the name is not the token.
for (const url of [
  ENDPOINT,
  `${ENDPOINT}?`,
  'HTTP://LocalHost:53371/__graph-inspector?keep=a+b',
  `${ENDPOINT}?x${INSPECTOR_ACCESS_TOKEN_PARAM}=1&${INSPECTOR_ACCESS_TOKEN_PARAM}_old=2`
]) {
  assert.equal(redactAccessToken(url), url)
}

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

// A transport error quotes the URL it failed on — exactly the request a token
// was on — so a failure is reported by its status, never in its own words.
const failure = createGraphViewerEventProperties({
  graphUrl: BOOTSTRAP_ENDPOINT,
  viewerRoute: `/view/${encoded}`,
  loadSource: 'manual_refresh',
  failure: { status: 401, unreachable: false, unsupported: false }
})

assert.ok(
  !JSON.stringify(failure).includes(TOKEN),
  'analytics leaked the access token through a failure'
)
assert.equal(failure.error_status, 401)
assert.equal(failure.error_message, 'HTTP 401')

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
for (const page of ['/view/navigator', '/view/issues', '/view/trace']) {
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

// A viewer page is unreachable without a credential, so this decides who is
// exempt. Only a graph on this site's own origin is: the demo that runs in the
// visitor's own browser, which is reachable from nowhere else — and which
// refuses a request without the token it printed all the same.
const VIEWER_ORIGIN = 'https://albasyir.github.io'
const DEMO_ENDPOINT
  = `${VIEWER_ORIGIN}/nest-graph-inspector/__nodepod__/53371/__graph-inspector`

assert.ok(
  canOpenWithoutAccessToken(DEMO_ENDPOINT, VIEWER_ORIGIN),
  'the in-browser demo must open without a token'
)

// Somebody's running application, on any other origin, may not.
for (const endpoint of [
  ENDPOINT,
  'http://localhost:53371/__graph-inspector',
  'https://albasyir.github.io.evil.example/__nodepod__/53371/__graph-inspector',
  'http://albasyir.github.io/nest-graph-inspector/__nodepod__/53371/__graph-inspector'
]) {
  assert.equal(
    canOpenWithoutAccessToken(endpoint, VIEWER_ORIGIN),
    false,
    `${endpoint} was let through without a token`
  )
}

// A port or scheme difference is a different origin, so it is not exempt.
assert.equal(
  canOpenWithoutAccessToken('http://localhost:3000/graph', 'http://localhost:3001'),
  false
)
assert.ok(
  canOpenWithoutAccessToken('http://localhost:3000/graph', 'http://localhost:3000')
)

// Nothing to compare, or nothing parseable, is never exempt.
assert.equal(canOpenWithoutAccessToken('', VIEWER_ORIGIN), false)
assert.equal(canOpenWithoutAccessToken(ENDPOINT, ''), false)
assert.equal(canOpenWithoutAccessToken('not a url', VIEWER_ORIGIN), false)

console.log('inspector-access-token.test.ts ok')
