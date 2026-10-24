import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import { INSPECTOR_ACCESS_TOKEN_PARAM } from './inspector-access-token.ts'
import {
  VIEWER_PAGES,
  decodeEndpointUrl,
  isViewerPage,
  isViewerPagePath,
  resolveViewerBootstrap,
  resolveViewerLanding,
  resolveViewerLink,
  resolveViewerPage
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

assert.deepEqual([...VIEWER_PAGES], ['navigator', 'issues', 'trace'])
assert.ok(isViewerPage('navigator'))
assert.ok(isViewerPage('trace'))
assert.ok(!isViewerPage('nope'))

// A renamed page still answers to its old name, as the page it became: the
// trace page was `execution-sequence`, and links made before still say so.
assert.equal(resolveViewerPage('trace'), 'trace')
assert.equal(resolveViewerPage('execution-sequence'), 'trace')
assert.ok(!isViewerPage('execution-sequence'), 'a former name is not a page')
assert.equal(resolveViewerPage('nope'), undefined)

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

// The library reads the token parameter by its decoded name, so a link spelling
// it percent-encoded still authenticates — and the endpoint it leaves behind
// carries the token under no spelling, while every other parameter, the user
// info and the fragment stay exactly as the link had them.
for (const name of ['%5F%5Finspector_token', '%5f%5finspector%5ftoken', '__inspector%5Ftoken']) {
  const link = Buffer.from(
    `http://dev:pw@0.0.0.0:53371/__graph-inspector?mode=a%20b&${name}=${TOKEN}#here`
  ).toString('base64url')
  const spent = resolveViewerBootstrap(`/view/${link}`)

  assert.equal(spent?.token, TOKEN, name)
  assert.equal(
    spent?.endpointUrl,
    'http://dev:pw@0.0.0.0:53371/__graph-inspector?mode=a%20b#here',
    name
  )
}

// A token parameter left empty is still one: the empty value is what is read,
// and a second spelling behind it must not survive into the endpoint.
const shadowed = resolveViewerBootstrap(
  `/view/${Buffer.from(`${ENDPOINT}?${INSPECTOR_ACCESS_TOKEN_PARAM}=&%5F%5Finspector_token=${TOKEN}`).toString('base64url')}`
)
assert.equal(shadowed?.endpointUrl, ENDPOINT)
assert.equal(shadowed?.token, '')

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
  resolveViewerBootstrap(`/view/${encoded}/trace`)?.path,
  '/view/trace'
)
// A link naming a page by its name before a rename lands on the page it became.
assert.equal(
  resolveViewerBootstrap(`/view/${encoded}/execution-sequence`)?.path,
  '/view/trace'
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
// decode "navigator" as an endpoint and redirect in a loop. A page's former name
// is no more a link than its current one.
for (const page of [...VIEWER_PAGES, 'execution-sequence']) {
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
  '/view/trace/x',
  '/view/execution-sequence/x'
]) {
  assert.equal(
    resolveViewerBootstrap(path),
    undefined,
    `treated ${path} as a bootstrap link`
  )
}

// Before anything reads the address bar — PostHog included — whatever stands
// where a printed link would is replaced. The viewer's own pages are not links,
// and are left exactly as they are.
const PAGE_PATHS = [
  '/view',
  '/view/',
  '/view/navigator',
  '/view/issues/',
  '/view/trace',
  '/view/execution-sequence',
  '/view/navigator/modules/UserModule',
  '/view/navigator/modules/Already%2520Encoded'
]

for (const path of PAGE_PATHS) {
  assert.ok(isViewerPagePath(path), `${path} is one of the viewer's pages`)
  assert.equal(resolveViewerLink(path), undefined, `${path} was rewritten`)
}

for (const path of ['/', '/getting-started', '/viewer/navigator', '/views/x']) {
  assert.ok(!isViewerPagePath(path), path)
  assert.equal(resolveViewerLink(path), undefined, `${path} is outside the viewer`)
}

// A link that can be spent lands on the page it names, as the plugin found it.
assert.deepEqual(resolveViewerLink(`/view/${encoded}`), bootstrap)
assert.equal(resolveViewerLink(`/view/${encoded}/issues`)?.path, '/view/issues')

// One that cannot be spent may still carry the token — damaged in copying,
// percent-encoded, hidden beneath a page — so it lands on `/view` and hands
// over nothing.
for (const path of [
  `/view/${encoded})`,
  `/view/${encoded}.`,
  `/view/%${encoded}`,
  '/view/%6Eavigator',
  `/view/navigator%2F${encoded}`,
  `/view/%2E%2E%2F${encoded}`,
  `/view/navigator/${encoded}`,
  `/view/issues/${encoded}`,
  `/view/execution-sequence/${encoded}`,
  `/view//${encoded}`,
  '/view/navigator/modules',
  `/view/navigator/modules/UserModule/${encoded}`,
  '/view/NAVIGATOR'
]) {
  assert.ok(!isViewerPagePath(path), `${path} is not a page`)
  assert.deepEqual(
    resolveViewerLink(path),
    { path: '/view', endpointUrl: '', token: '' },
    `${path} was not replaced with /view`
  )
}

// The router matches paths without regard to case, so another spelling of
// `/view` reaches the viewer too. Only the spelling the library prints is ever
// spent: a link under any other lands on `/view` and hands over nothing, however
// valid the link — and a page under one is no longer the canonical page.
for (const path of [
  `/VIEW/${encoded}`,
  `/View/${encoded}`,
  `/vIeW/${encoded}/issues`,
  `/VIEW/${encodeURIComponent(Buffer.from(BOOTSTRAP_ENDPOINT).toString('base64'))}`,
  `/VIEW/${encoded})`,
  '/VIEW/navigator',
  '/View/navigator/modules/UserModule',
  '/VIEW/'
]) {
  assert.ok(!isViewerPagePath(path), `${path} is not one of the viewer's pages`)
  assert.deepEqual(
    resolveViewerLink(path),
    { path: '/view', endpointUrl: '', token: '' },
    `${path} was not replaced with /view`
  )
}

// `/VIEW` alone stands where no link could: there is nothing after it.
assert.equal(resolveViewerLink('/VIEW'), undefined)

// More than one slash before `view` is still the link's place, and is not the
// spelling the library prints: it lands on `/view` and hands over nothing.
for (const path of [`//view/${encoded}`, `///VIEW/${encoded}/issues`, '//view/navigator']) {
  assert.deepEqual(
    resolveViewerLink(path),
    { path: '/view', endpointUrl: '', token: '' },
    `${path} was not replaced with /view`
  )
}

// The plugin reads the route out of the address bar with `withoutBase`, as
// Nuxt's router reads its first route, and replaces the path beneath the base.
const BASE = '/nest-graph-inspector/'

assert.deepEqual(
  resolveViewerLanding(`${BASE}view/${encoded}`, BASE),
  { ...bootstrap, address: `${BASE}view/navigator` }
)
assert.equal(resolveViewerLanding(`/view/${encoded}/issues`, '/')?.address, '/view/issues')

// A doubled slash after the base: whether the route keeps it or collapses it,
// the link is spent or cleared — never left in the address bar for PostHog.
for (const [pathname, base] of [
  [`${BASE}/view/${encoded}`, BASE],
  [`${BASE}//VIEW/${encoded}`, BASE],
  [`//view/${encoded}`, '/']
] as const) {
  const landing = resolveViewerLanding(pathname, base)

  assert.ok(landing, `${pathname} was left in the address bar`)
  assert.ok(
    [`${base}view`, `${base}view/navigator`].includes(landing.address),
    `${pathname} landed on ${landing.address}`
  )
}

// The viewer's own pages, and everything outside the viewer, are left alone.
for (const pathname of [
  BASE,
  `${BASE}view`,
  `${BASE}view/navigator`,
  `${BASE}view/navigator/modules/UserModule`,
  `${BASE}getting-started`
]) {
  assert.equal(resolveViewerLanding(pathname, BASE), undefined, pathname)
}

console.log('viewer-bootstrap-link.test.ts ok')
