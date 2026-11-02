import { strict as assert } from 'node:assert'
import { NODEPOD_ROUTE_SEGMENT } from './nodepod-demo-endpoint.ts'
import { resolveDemoSessionAction } from './nodepod-demo-session.ts'

const SITE_ORIGIN = 'https://albasyir.github.io'
const SITE_BASE = `${SITE_ORIGIN}/nest-graph-inspector`
const DEMO_ENDPOINT = `${SITE_BASE}/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`

const noDemo = {
  siteBaseUrl: `${SITE_BASE}/`,
  isDemoRunning: false,
  isDemoStarting: false,
  endpointRefusedToken: false
}

// An application on the developer's own machine is reached over the network by
// anything that holds its address, so a restored session is all it needs —
// whatever the demo in this tab is doing.
for (const endpointUrl of [
  'http://localhost:53371/__graph-inspector',
  'https://staging.example.com/__graph-inspector',
  ''
]) {
  assert.equal(
    resolveDemoSessionAction({ ...noDemo, endpointUrl }),
    'pass-through'
  )
  assert.equal(
    resolveDemoSessionAction({
      endpointUrl,
      siteBaseUrl: `${SITE_BASE}/`,
      isDemoRunning: true,
      isDemoStarting: false,
      endpointRefusedToken: true
    }),
    'pass-through'
  )
}

// So is one on another origin whose path happens to hold the runtime's segment:
// the demo is only ever served from this site's own origin, so whatever the
// demo in this tab is doing, the page loads that application as it is — it is
// never let go, stopped, or swapped for the demo.
const OWN_ENDPOINT_UNDER_SEGMENT = `https://staging.example.com/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`
for (const demo of [
  { isDemoRunning: false, isDemoStarting: false, endpointRefusedToken: false },
  { isDemoRunning: true, isDemoStarting: false, endpointRefusedToken: false },
  { isDemoRunning: true, isDemoStarting: false, endpointRefusedToken: true },
  { isDemoRunning: false, isDemoStarting: true, endpointRefusedToken: false }
]) {
  assert.equal(
    resolveDemoSessionAction({ ...demo, endpointUrl: OWN_ENDPOINT_UNDER_SEGMENT, siteBaseUrl: `${SITE_BASE}/` }),
    'pass-through',
    JSON.stringify(demo)
  )
}

// The demo's address survives a reload; the pod that answered it does not, and
// a viewer page does not boot another one: the session is let go, and the
// visitor starts the demo again from `/view`.
assert.equal(
  resolveDemoSessionAction({ ...noDemo, endpointUrl: DEMO_ENDPOINT }),
  'release'
)

// The pod this document booted is still the one behind that address.
assert.equal(
  resolveDemoSessionAction({
    ...noDemo,
    endpointUrl: DEMO_ENDPOINT,
    isDemoRunning: true
  }),
  'reuse'
)

// A start already in flight is waited for rather than repeated, and a token
// refused before it began is no reason not to: the pod coming up mints its own.
for (const endpointRefusedToken of [false, true]) {
  assert.equal(
    resolveDemoSessionAction({
      endpointUrl: DEMO_ENDPOINT,
      siteBaseUrl: `${SITE_BASE}/`,
      isDemoRunning: false,
      isDemoStarting: true,
      endpointRefusedToken
    }),
    'join'
  )
}

// A tab left open outlives the token the demo minted for itself. Joining the
// application that is still running would only hand back the credential the
// endpoint has already refused, so it is stopped — not replaced: the visitor
// starts the next one.
assert.equal(
  resolveDemoSessionAction({
    endpointUrl: DEMO_ENDPOINT,
    siteBaseUrl: `${SITE_BASE}/`,
    isDemoRunning: true,
    isDemoStarting: false,
    endpointRefusedToken: true
  }),
  'stop'
)

console.log('nodepod-demo-session: ok')
