import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import { readAccessToken } from './inspector-access-token.ts'
import {
  NODEPOD_ROUTE_SEGMENT,
  buildDemoEndpointUrl,
  readDemoRequestTarget,
  readViewerLinkEndpoint,
  redactViewerLinks,
  resolveInspectorMountBase
} from './nodepod-demo-endpoint.ts'

const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'
const DEMO_ENDPOINT = `http://localhost:53371/__graph-inspector?__inspector_token=${TOKEN}`
const SITE_BASE = 'https://albasyir.github.io/nest-graph-inspector/'

function viewerLink(endpoint: string, baseUrl = SITE_BASE) {
  return `${baseUrl}view/${Buffer.from(endpoint).toString('base64url')}`
}

// The endpoint is read back out of the application's own startup log, which
// arrives coloured and interleaved with every other line Nest prints.
const log = [
  '[Nest] 1  - LOG [NestFactory] Starting Nest application...',
  `[Nest] 1  - DEBUG [NestGraphInspectorSetup] Graph Viewer is available at ${viewerLink(DEMO_ENDPOINT)} (access token expires at 2026-08-23T16:12:54.997Z)`,
  '[Nest] 1  - LOG [NestApplication] Nest application successfully started'
].join('\n')

assert.equal(readViewerLinkEndpoint(log), DEMO_ENDPOINT)

// A restarted pod prints a second link with a fresh token; the newest wins.
const restartedEndpoint = DEMO_ENDPOINT.replace(TOKEN, 'ngi1.second.token_2')
assert.equal(
  readViewerLinkEndpoint(`${log}\n${viewerLink(restartedEndpoint)}`),
  restartedEndpoint
)

// Anything that is not a decodable endpoint is ignored rather than guessed at.
assert.equal(readViewerLinkEndpoint(''), null)
assert.equal(readViewerLinkEndpoint('no link here'), null)
assert.equal(
  readViewerLinkEndpoint(`http://localhost:3000/view/${'a'.repeat(20)}`),
  null
)

// A viewer link that already points at a deeper route still yields the endpoint.
assert.equal(
  readViewerLinkEndpoint(
    `${viewerLink(DEMO_ENDPOINT)}/execution-sequence`
  ),
  DEMO_ENDPOINT
)

// The application's own address is rewritten into one this tab can reach,
// under whatever path the site itself is served from — and the token the
// printed link carried is left behind, because the viewer sends it as a header.
assert.equal(
  buildDemoEndpointUrl({ endpointUrl: DEMO_ENDPOINT, siteBaseUrl: SITE_BASE }),
  `https://albasyir.github.io/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`
)
assert.equal(
  buildDemoEndpointUrl({
    endpointUrl: DEMO_ENDPOINT,
    siteBaseUrl: 'http://localhost:3000/'
  }),
  `http://localhost:3000/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`
)

const demoEndpoint = buildDemoEndpointUrl({
  endpointUrl: DEMO_ENDPOINT,
  siteBaseUrl: SITE_BASE
})
assert.equal(readAccessToken(demoEndpoint), undefined)
assert.ok(!demoEndpoint.includes(TOKEN))

// Sibling endpoints of the in-browser demo hang off the port segment...
assert.equal(
  resolveInspectorMountBase(demoEndpoint),
  `/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/53371`
)
// ...while an inspector reached over the network keeps resolving them from the
// origin root, which is where the library mounts them.
assert.equal(resolveInspectorMountBase(DEMO_ENDPOINT), '')
assert.equal(resolveInspectorMountBase('not a url'), '')
assert.equal(resolveInspectorMountBase(''), '')

// Requests the viewer makes are routed back to the virtual server they name.
assert.deepEqual(
  readDemoRequestTarget(`${demoEndpoint}/output.json`, SITE_BASE),
  { port: 53371, path: '/__graph-inspector/output.json' }
)
// A query the viewer does add — anything but a token — travels with the request.
assert.deepEqual(
  readDemoRequestTarget(`${demoEndpoint}/output.json?pretty=1`, SITE_BASE),
  { port: 53371, path: '/__graph-inspector/output.json?pretty=1' }
)
assert.deepEqual(
  readDemoRequestTarget(
    `https://albasyir.github.io/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/8889/users`,
    SITE_BASE
  ),
  { port: 8889, path: '/users' }
)
// A bare port with no path still addresses the server's root.
assert.deepEqual(
  readDemoRequestTarget(
    `https://albasyir.github.io/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/8889`,
    SITE_BASE
  ),
  { port: 8889, path: '/' }
)

// Everything else has to reach the network untouched.
assert.equal(
  readDemoRequestTarget(
    'https://albasyir.github.io/nest-graph-inspector/api/anything',
    SITE_BASE
  ),
  null
)
assert.equal(
  readDemoRequestTarget(
    `https://example.com/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/53371/output.json`,
    SITE_BASE
  ),
  null
)
assert.equal(
  readDemoRequestTarget(
    `https://albasyir.github.io/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/not-a-port/output.json`,
    SITE_BASE
  ),
  null
)
assert.equal(readDemoRequestTarget('not a url', 'also not a url'), null)

// A log is diagnostic output, and the printed link inside it is a credential:
// the token rides along base64url-encoded, so stripping a query parameter would
// walk straight past it. What is left has to still read as the same log.
const redacted = redactViewerLinks(log)
assert.equal(readViewerLinkEndpoint(redacted), null)
assert.equal(redacted.includes(TOKEN), false)
assert.equal(
  redacted.includes(Buffer.from(DEMO_ENDPOINT).toString('base64url')),
  false
)
assert.ok(redacted.includes('[NestFactory] Starting Nest application...'))
assert.ok(redacted.includes('(access token expires at 2026-08-23T16:12:54.997Z)'))
assert.ok(redacted.includes(`${SITE_BASE}view/<redacted>`))

// Every link goes, not just the last one, and a log without any is untouched.
assert.equal(
  redactViewerLinks(`${log}\n${viewerLink(restartedEndpoint)}`).includes(
    'second.token_2'
  ),
  false
)
assert.equal(redactViewerLinks('no link here'), 'no link here')

console.log('nodepod-demo-endpoint: ok')
