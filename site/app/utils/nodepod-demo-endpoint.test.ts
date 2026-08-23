import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import { decodeEndpointUrl } from './inspector-access-token.ts'
import {
  NODEPOD_ROUTE_SEGMENT,
  buildDemoEndpointUrl,
  encodeEndpointUrlForRoute,
  readDemoRequestTarget,
  readViewerLinkEndpoint,
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
// under whatever path the site itself is served from.
assert.equal(
  buildDemoEndpointUrl({ endpointUrl: DEMO_ENDPOINT, siteBaseUrl: SITE_BASE }),
  `https://albasyir.github.io/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector?__inspector_token=${TOKEN}`
)
assert.equal(
  buildDemoEndpointUrl({
    endpointUrl: DEMO_ENDPOINT,
    siteBaseUrl: 'http://localhost:3000/'
  }),
  `http://localhost:3000/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector?__inspector_token=${TOKEN}`
)

// The route segment survives a round trip through the viewer's own encoding.
const demoEndpoint = buildDemoEndpointUrl({
  endpointUrl: DEMO_ENDPOINT,
  siteBaseUrl: SITE_BASE
})
assert.equal(
  decodeEndpointUrl(
    decodeURIComponent(encodeEndpointUrlForRoute(demoEndpoint))
  ),
  demoEndpoint
)

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
  readDemoRequestTarget(
    `${demoEndpoint.split('?')[0]}/output.json?__inspector_token=${TOKEN}`,
    SITE_BASE
  ),
  {
    port: 53371,
    path: `/__graph-inspector/output.json?__inspector_token=${TOKEN}`
  }
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

console.log('nodepod-demo-endpoint: ok')
