import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import { INSPECTOR_ACCESS_TOKEN_PARAM } from './inspector-access-token.ts'
import {
  VIEWER_PAGES,
  decodeEndpointUrl,
  isViewerPage,
  resolveViewerBootstrap
} from './viewer-bootstrap-link.ts'

const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'
const ENDPOINT = 'http://0.0.0.0:53371/__graph-inspector'
const BOOTSTRAP_ENDPOINT = `${ENDPOINT}?${INSPECTOR_ACCESS_TOKEN_PARAM}=${TOKEN}`

// The library encodes the endpoint with the base64url alphabet. Whether that
// produces '-' or '_' depends on how the origin, path, and token align, and the
// default origin carrying a token does produce them — which plain atob rejects.
const encoded = Buffer.from(BOOTSTRAP_ENDPOINT).toString('base64url')
assert.ok(/[-_]/.test(encoded), 'expected a base64url-only alphabet in fixture')
assert.equal(decodeEndpointUrl(encoded), BOOTSTRAP_ENDPOINT)

// Standard base64 still decodes, so links this site used to mint keep working.
assert.equal(
  decodeEndpointUrl(Buffer.from(BOOTSTRAP_ENDPOINT).toString('base64')),
  BOOTSTRAP_ENDPOINT
)

assert.deepEqual([...VIEWER_PAGES], ['navigator', 'issues', 'execution-sequence'])
assert.ok(isViewerPage('navigator'))
assert.ok(!isViewerPage('nope'))

// The printed link is spent on arrival: the endpoint and token come out, and
// the visitor lands on a page whose URL says nothing about either.
const bootstrap = resolveViewerBootstrap(`/view/${encoded}`)
assert.ok(bootstrap, 'a printed link must resolve')
assert.equal(bootstrap.path, '/view/navigator')
assert.equal(bootstrap.endpointUrl, ENDPOINT)
assert.equal(bootstrap.token, TOKEN)
assert.ok(
  !bootstrap.path.includes(TOKEN) && !bootstrap.path.includes(encoded),
  'the landing path still carries the link it was resolved from'
)

// A trailing slash is the same link.
assert.deepEqual(resolveViewerBootstrap(`/view/${encoded}/`), bootstrap)

// A link with no token is a graph the viewer can open without a credential —
// the demo fixture is one.
const tokenFree = Buffer.from(ENDPOINT).toString('base64url')
assert.deepEqual(resolveViewerBootstrap(`/view/${tokenFree}`), {
  path: '/view/navigator',
  endpointUrl: ENDPOINT,
  token: ''
})

// Links this site used to build carried the view in a second segment. An old
// bookmark has to land on the view it named, not just the navigator.
assert.equal(
  resolveViewerBootstrap(`/view/${encoded}/issues`)?.path,
  '/view/issues'
)
assert.equal(
  resolveViewerBootstrap(`/view/${encoded}/execution-sequence`)?.path,
  '/view/execution-sequence'
)
// …and an unrecognised second segment falls back rather than 404s.
assert.equal(
  resolveViewerBootstrap(`/view/${encoded}/whatever`)?.path,
  '/view/navigator'
)

// Percent-encoded segments — what the old site produced — still resolve.
assert.equal(
  resolveViewerBootstrap(
    `/view/${encodeURIComponent(Buffer.from(BOOTSTRAP_ENDPOINT).toString('base64'))}`
  )?.endpointUrl,
  ENDPOINT
)

// The viewer's own pages are not links to spend. Treating one as a link would
// decode "navigator" as an endpoint and redirect in a loop.
for (const page of VIEWER_PAGES) {
  assert.equal(
    resolveViewerBootstrap(`/view/${page}`),
    undefined,
    `treated /view/${page} as a bootstrap link`
  )
}

// Neither is anything that fails to decode, or decodes to something that is not
// an endpoint — a mistyped path must not be mistaken for a graph.
for (const path of [
  '/view',
  '/view/',
  '/view/%%%',
  '/view/bm90LWEtdXJs', // "not-a-url"
  `/view/${Buffer.from('ftp://example.com/graph').toString('base64url')}`,
  `/view/${Buffer.from('/relative/path').toString('base64url')}`,
  `/view/${Buffer.from('http://').toString('base64url')}`
]) {
  assert.equal(
    resolveViewerBootstrap(path),
    undefined,
    `accepted ${path} as a bootstrap link`
  )
}

// A deeper path under a viewer page is not a link either. It matches no page, so
// the router layer has to send it back to /view rather than strand it on the
// bootstrap placeholder — which needs resolveViewerBootstrap to decline it.
for (const path of [
  '/view/navigator/anything',
  '/view/issues/1/2',
  '/view/execution-sequence/x'
]) {
  assert.equal(
    resolveViewerBootstrap(path),
    undefined,
    `treated ${path} as a bootstrap link`
  )
}

console.log('viewer-bootstrap-link.test.ts ok')
