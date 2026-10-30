import { strict as assert } from 'node:assert'
import { NODEPOD_ROUTE_SEGMENT } from './nodepod-demo-endpoint.ts'
import {
  resolveViewerLandingAction,
  resolveViewerLandingPath
} from './viewer-landing.ts'

const SITE_BASE = 'https://albasyir.github.io/nest-graph-inspector'
const DEMO_ENDPOINT = `${SITE_BASE}/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`
const OWN_ENDPOINT = 'http://localhost:53371/__graph-inspector'

const fresh = {
  query: {},
  restoredEndpointUrl: '',
  canOpenRestoredSession: false,
  isDemoActive: false
}

// A fresh tab opening the viewer gets the landing card: the demo is the
// visitor's to start, so nothing is downloaded or booted on arrival.
assert.deepEqual(resolveViewerLandingAction(fresh), { kind: 'manual' })
for (const autoload of ['true', 'false', '0', '', null, ['false']]) {
  assert.deepEqual(
    resolveViewerLandingAction({ ...fresh, query: { autoload } }),
    { kind: 'manual' }
  )
}

// Nor does a demo already running in the tab pull the plain `/view` into it.
assert.deepEqual(
  resolveViewerLandingAction({ ...fresh, isDemoActive: true }),
  { kind: 'manual' }
)

// A preview's "Open full-screen demo" joins the demo that preview is running or
// starting, over the opt-out and a session for another graph…
assert.deepEqual(
  resolveViewerLandingAction({ ...fresh, query: { preview: 'true' }, isDemoActive: true }),
  { kind: 'join-demo' }
)
assert.deepEqual(
  resolveViewerLandingAction({
    query: { preview: 'true', autoload: 'false' },
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: true,
    isDemoActive: true
  }),
  { kind: 'join-demo' }
)

// …but never boots one: with no demo in the tab it is the landing card, even
// when the tab could go back to the visitor's own graph instead.
assert.deepEqual(
  resolveViewerLandingAction({ ...fresh, query: { preview: 'true' } }),
  { kind: 'manual' }
)
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    query: { preview: 'true', trace: 'true' },
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: true
  }),
  { kind: 'manual' }
)
for (const preview of ['false', '1', '', ['true']]) {
  assert.deepEqual(
    resolveViewerLandingAction({ ...fresh, query: { preview }, isDemoActive: true }),
    { kind: 'manual' }
  )
}

// A tab already on somebody's own graph goes back to it.
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: true
  }),
  { kind: 'open-session', path: '/view/navigator' }
)
for (const query of [{ trace: 'true' }, { 'execution-sequence': 'true' }]) {
  assert.deepEqual(
    resolveViewerLandingAction({
      ...fresh,
      query,
      restoredEndpointUrl: OWN_ENDPOINT,
      canOpenRestoredSession: true
    }),
    { kind: 'open-session', path: '/view/trace' }
  )
}

// The opt-out holds a restored session back: "Try Another URL" lands here.
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    query: { autoload: 'false' },
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: true
  }),
  { kind: 'manual' }
)

// A session the viewer would refuse is not redirected, or the middleware would
// send it straight back here.
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: false
  }),
  { kind: 'manual' }
)

// A restored demo session is never redirected, with or without a demo running:
// the landing card is where the visitor starts or opens it.
for (const isDemoActive of [false, true]) {
  assert.deepEqual(
    resolveViewerLandingAction({
      ...fresh,
      restoredEndpointUrl: DEMO_ENDPOINT,
      canOpenRestoredSession: true,
      isDemoActive
    }),
    { kind: 'manual' }
  )
}

assert.equal(resolveViewerLandingPath({}), '/view/navigator')
assert.equal(resolveViewerLandingPath({ trace: 'true' }), '/view/trace')
assert.equal(resolveViewerLandingPath({ trace: 'false' }), '/view/navigator')
