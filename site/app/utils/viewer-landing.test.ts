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
  isDemoActive: false,
  siteBaseUrl: `${SITE_BASE}/`
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

// Once the visitor has started the demo in this document, though, the plain
// `/view` joins it: a tab on no graph has nothing of its own to go back to.
assert.deepEqual(
  resolveViewerLandingAction({ ...fresh, isDemoActive: true }),
  { kind: 'join-demo' }
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
    isDemoActive: true,
    siteBaseUrl: `${SITE_BASE}/`
  }),
  { kind: 'join-demo' }
)

// …but never boots one: with no demo in the tab it opens the demo's static
// graph — what a preview that has not loaded the example draws — even when the
// tab could go back to the visitor's own graph, or file, instead.
assert.deepEqual(
  resolveViewerLandingAction({ ...fresh, query: { preview: 'true' } }),
  { kind: 'open-example' }
)
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    query: { preview: 'true', trace: 'true' },
    restoredEndpointUrl: OWN_ENDPOINT,
    canOpenRestoredSession: true,
    restoredGraphFile: 'file'
  }),
  { kind: 'open-example' }
)
// Only `preview=true` itself is the preview's link: anything else neither opens
// the static graph nor joins the demo over the visitor's own file.
for (const preview of ['false', '1', '', ['true']]) {
  assert.deepEqual(
    resolveViewerLandingAction({ ...fresh, query: { preview } }),
    { kind: 'manual' }
  )
  assert.deepEqual(
    resolveViewerLandingAction({
      ...fresh,
      query: { preview },
      restoredGraphFile: 'file',
      isDemoActive: true
    }),
    { kind: 'open-session', path: '/view/navigator' }
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

// A tab on a graph file goes back to it, in the navigator — a file has no
// trace history — and the opt-out holds it back like any session.
for (const query of [{}, { trace: 'true' }]) {
  assert.deepEqual(
    resolveViewerLandingAction({ ...fresh, query, restoredGraphFile: 'file' }),
    { kind: 'open-session', path: '/view/navigator' }
  )
}
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    query: { autoload: 'false' },
    restoredGraphFile: 'file'
  }),
  { kind: 'manual' }
)

// A restored demo session nothing in this document answers any more — a
// reload, a restored tab — is not redirected: the landing card is where the
// visitor starts the demo again. One this document is running, or starting,
// is joined.
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    restoredEndpointUrl: DEMO_ENDPOINT,
    canOpenRestoredSession: true
  }),
  { kind: 'manual' }
)
assert.deepEqual(
  resolveViewerLandingAction({
    ...fresh,
    restoredEndpointUrl: DEMO_ENDPOINT,
    canOpenRestoredSession: true,
    isDemoActive: true
  }),
  { kind: 'join-demo' }
)

assert.equal(resolveViewerLandingPath({}), '/view/navigator')
assert.equal(resolveViewerLandingPath({ trace: 'true' }), '/view/trace')
assert.equal(resolveViewerLandingPath({ trace: 'false' }), '/view/navigator')
