import { strict as assert } from 'node:assert'
import { NODEPOD_ROUTE_SEGMENT } from './nodepod-demo-endpoint.ts'
import { resolveDemoSessionAction } from './nodepod-demo-session.ts'

const SITE_BASE = 'https://albasyir.github.io/nest-graph-inspector'
const DEMO_ENDPOINT = `${SITE_BASE}/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`

// An application on the developer's own machine is reached over the network by
// anything that holds its address, so a restored session is all it needs.
for (const endpointUrl of [
  'http://localhost:53371/__graph-inspector',
  'https://staging.example.com/__graph-inspector',
  ''
]) {
  assert.equal(
    resolveDemoSessionAction({
      endpointUrl,
      isDemoRunning: false,
      endpointRefusedToken: false
    }),
    'pass-through'
  )
}

// The demo's address survives a reload; the pod that answered it does not.
assert.equal(
  resolveDemoSessionAction({
    endpointUrl: DEMO_ENDPOINT,
    isDemoRunning: false,
    endpointRefusedToken: false
  }),
  'start'
)

// The pod this document booted is still the one behind that address.
assert.equal(
  resolveDemoSessionAction({
    endpointUrl: DEMO_ENDPOINT,
    isDemoRunning: true,
    endpointRefusedToken: false
  }),
  'reuse'
)

// A tab left open outlives the token the demo minted for itself. Joining the
// application that is still running would only hand back the credential the
// endpoint has already refused, so this one has to be replaced.
assert.equal(
  resolveDemoSessionAction({
    endpointUrl: DEMO_ENDPOINT,
    isDemoRunning: true,
    endpointRefusedToken: true
  }),
  'restart'
)

console.log('nodepod-demo-session: ok')
