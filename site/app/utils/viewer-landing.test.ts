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
  demoFailed: false
}

// A fresh tab opening the viewer is asking to see a graph: the demo starts.
assert.deepEqual(resolveViewerLandingAction(fresh), { kind: 'start-demo' })

// `autoload=false` keeps the landing card, and nothing else counts as false.
assert.deepEqual(
  resolveViewerLandingAction({ ...fresh, query: { autoload: 'false' } }),
  { kind: 'manual' }
)
for (const autoload of ['true', '0', '', null, ['false']]) {
  assert.deepEqual(
    resolveViewerLandingAction({ ...fresh, query: { autoload } }),
    { kind: 'start-demo' }
  )
}

// A docs preview asks for the demo by name, over the opt-out and a session.
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    query: { preview: 'true', autoload: 'false' },
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: true
  }),
  { kind: 'start-demo' }
)

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

// The opt-out also holds a restored session back: "Try Another URL" lands here.
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
  { kind: 'start-demo' }
)

// A restored demo session is recovered by starting the demo from here.
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    restoredEndpointUrl: DEMO_ENDPOINT,
    canOpenRestoredSession: true
  }),
  { kind: 'start-demo' }
)

// A demo that already failed in this tab is not started again on its own…
assert.deepEqual(
  resolveViewerLandingAction({ ...fresh, demoFailed: true }),
  { kind: 'manual' }
)
// …though a usable session of the visitor's own still opens.
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    demoFailed: true,
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: true
  }),
  { kind: 'open-session', path: '/view/navigator' }
)

assert.equal(resolveViewerLandingPath({}), '/view/navigator')
assert.equal(resolveViewerLandingPath({ trace: 'true' }), '/view/trace')
assert.equal(resolveViewerLandingPath({ trace: 'false' }), '/view/navigator')
