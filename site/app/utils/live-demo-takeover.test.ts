import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  liveDemoTakesOver,
  resolveTabGraphSource,
  resolveViewerPageTakeover,
  type TabGraphSource
} from './live-demo-takeover.ts'
import { NODEPOD_ROUTE_SEGMENT } from './nodepod-demo-endpoint.ts'
import { resolveViewerLandingAction } from './viewer-landing.ts'

const SITE_ORIGIN = 'https://albasyir.github.io'
const SITE_BASE = `${SITE_ORIGIN}/nest-graph-inspector`
const SITE_BASE_URL = `${SITE_BASE}/`
const DEMO_ENDPOINT = `${SITE_BASE}/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`
const OWN_ENDPOINT = 'http://localhost:53371/__graph-inspector'
/** Somebody's own application, served under a path that holds the runtime's segment. */
const OWN_ENDPOINT_UNDER_SEGMENT = `https://staging.example.com/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`

const SOURCES: TabGraphSource[] = ['none', 'example', 'file', 'demo', 'application']

/** The demo the visitor started with "Load Example", up and answering. */
const RUNNING = { isDemoRunning: true, isDemoStarting: false }
/** The demo the visitor started, still downloading or booting: no endpoint yet. */
const STARTING = { isDemoRunning: false, isDemoStarting: true }
/** No demo in this document: never started, stopped, or failed. */
const OFF = { isDemoRunning: false, isDemoStarting: false }

/** A tab opening `/view` from a link, with nothing restored yet. */
const fresh = {
  query: {},
  restoredEndpointUrl: '',
  canOpenRestoredSession: false,
  isDemoActive: false,
  siteBaseUrl: SITE_BASE_URL
}

describe('which graph a tab is on', () => {
  const siteBaseUrl = SITE_BASE_URL

  test('a graph file is the visitor\'s own or the demo\'s static graph, by its kind', () => {
    assert.equal(resolveTabGraphSource({ graphFile: 'file', endpointUrl: '', siteBaseUrl }), 'file')
    assert.equal(resolveTabGraphSource({ graphFile: 'example', endpointUrl: '', siteBaseUrl }), 'example')
  })

  test('an endpoint is the in-browser demo\'s or somebody\'s own application, by its address', () => {
    assert.equal(resolveTabGraphSource({ endpointUrl: DEMO_ENDPOINT, siteBaseUrl }), 'demo')
    assert.equal(resolveTabGraphSource({ graphFile: null, endpointUrl: OWN_ENDPOINT, siteBaseUrl }), 'application')
    assert.equal(resolveTabGraphSource({ endpointUrl: 'https://staging.example.com/__graph-inspector', siteBaseUrl }), 'application')
  })

  // The demo is only ever served from this site's own origin. The runtime's
  // segment in somebody else's path is a coincidence, not the demo.
  test('the runtime\'s segment on another origin is somebody\'s own application', () => {
    assert.equal(resolveTabGraphSource({ endpointUrl: OWN_ENDPOINT_UNDER_SEGMENT, siteBaseUrl }), 'application')
    assert.equal(resolveTabGraphSource({ endpointUrl: DEMO_ENDPOINT, siteBaseUrl: 'https://other.example/nest-graph-inspector/' }), 'application')
    assert.equal(resolveTabGraphSource({ endpointUrl: DEMO_ENDPOINT, siteBaseUrl: '' }), 'application')
  })

  test('a tab on neither is on none', () => {
    assert.equal(resolveTabGraphSource({ endpointUrl: '', siteBaseUrl }), 'none')
    assert.equal(resolveTabGraphSource({ graphFile: null, endpointUrl: '', siteBaseUrl }), 'none')
  })
})

describe('the demo the visitor started', () => {
  // Nothing of the visitor's own choosing is on screen in these: no graph, the
  // static graph the site showed of the demo before it ran, or the demo itself
  // under a session this document may no longer be answering.
  test('takes over no graph, the demo\'s static graph, and a demo session', () => {
    for (const source of ['none', 'example', 'demo'] as const) {
      assert.equal(liveDemoTakesOver({ source, isDemoActive: true }), true, source)
    }
  })

  // The visitor chose these themselves: a file they opened, or the link their
  // own application printed.
  test('never takes over the visitor\'s own graph file or their own application', () => {
    for (const source of ['file', 'application'] as const) {
      assert.equal(liveDemoTakesOver({ source, isDemoActive: true }), false, source)
    }
  })

  // "Load Example" is the only thing that starts the demo, and a reload ends it.
  test('takes nothing over before it has been started', () => {
    for (const source of SOURCES) {
      assert.equal(liveDemoTakesOver({ source, isDemoActive: false }), false, source)
    }
  })
})

describe('/view, once the visitor has started the demo', () => {
  // R1: "Load Example" on a landing-page preview, then the header's View Graph.
  test('R1: a tab with no graph joins the demo the previews are running', () => {
    assert.deepEqual(
      resolveViewerLandingAction({ ...fresh, isDemoActive: true }),
      { kind: 'join-demo' }
    )
  })

  // R2: "Open full-screen demo" before the example was loaded opened the static
  // graph; "Load Example" back on the landing page started the demo since.
  test('R2: the demo\'s static graph gives way to the demo running', () => {
    assert.deepEqual(
      resolveViewerLandingAction({ ...fresh, restoredGraphFile: 'example', isDemoActive: true }),
      { kind: 'join-demo' }
    )
  })

  // R3: the demo was started from `/view`, and the visitor came back to it from
  // the landing page.
  test('R3: a demo session joins the demo running in this document', () => {
    assert.deepEqual(
      resolveViewerLandingAction({
        ...fresh,
        restoredEndpointUrl: DEMO_ENDPOINT,
        canOpenRestoredSession: true,
        isDemoActive: true
      }),
      { kind: 'join-demo' }
    )
  })

  test('goes back to the visitor\'s own graph file or own application instead', () => {
    assert.deepEqual(
      resolveViewerLandingAction({ ...fresh, restoredGraphFile: 'file', isDemoActive: true }),
      { kind: 'open-session', path: '/view/navigator' }
    )
    assert.deepEqual(
      resolveViewerLandingAction({
        ...fresh,
        restoredEndpointUrl: OWN_ENDPOINT,
        canOpenRestoredSession: true,
        isDemoActive: true
      }),
      { kind: 'open-session', path: '/view/navigator' }
    )
    // Even served under a path that holds the runtime's segment.
    assert.deepEqual(
      resolveViewerLandingAction({
        ...fresh,
        restoredEndpointUrl: OWN_ENDPOINT_UNDER_SEGMENT,
        canOpenRestoredSession: true,
        isDemoActive: true
      }),
      { kind: 'open-session', path: '/view/navigator' }
    )
    // Their own application's session without a usable token stays theirs:
    // the landing card, where Load Example still joins the running demo.
    assert.deepEqual(
      resolveViewerLandingAction({
        ...fresh,
        restoredEndpointUrl: OWN_ENDPOINT,
        canOpenRestoredSession: false,
        isDemoActive: true
      }),
      { kind: 'manual' }
    )
  })

  // Close Graph and Try Another URL land on `/view?autoload=false`: the
  // visitor asked for the landing card, so the demo does not pull them past it.
  test('?autoload=false holds the demo back', () => {
    for (const restored of [
      {},
      { restoredGraphFile: 'example' as const },
      { restoredEndpointUrl: DEMO_ENDPOINT, canOpenRestoredSession: true }
    ]) {
      assert.deepEqual(
        resolveViewerLandingAction({
          ...fresh,
          ...restored,
          query: { autoload: 'false' },
          isDemoActive: true
        }),
        { kind: 'manual' }
      )
    }
  })
})

describe('/view, before the visitor has started the demo', () => {
  test('waits on the landing card, starting nothing', () => {
    assert.deepEqual(resolveViewerLandingAction(fresh), { kind: 'manual' })
    assert.deepEqual(
      resolveViewerLandingAction({ ...fresh, restoredEndpointUrl: DEMO_ENDPOINT, canOpenRestoredSession: true }),
      { kind: 'manual' }
    )
  })

  test('goes back to the static graph a preview opened, and opens it for ?preview=true', () => {
    assert.deepEqual(
      resolveViewerLandingAction({ ...fresh, restoredGraphFile: 'example' }),
      { kind: 'open-session', path: '/view/navigator' }
    )
    assert.deepEqual(
      resolveViewerLandingAction({ ...fresh, query: { preview: 'true' } }),
      { kind: 'open-example' }
    )
  })
})

describe('a viewer page arrived at while the demo runs', () => {
  // R2: Back to the `/view/navigator` entry that showed the static graph.
  test('R2: puts the demo running in place of the static graph', () => {
    assert.equal(
      resolveViewerPageTakeover({ source: 'example', ...RUNNING, isSamePage: false }),
      'adopt'
    )
  })

  // R1: a viewer page reached in the document that started the demo from a
  // preview, with no graph of its own to show — not sent back to `/view`.
  test('R1: opens a tab with no graph on the demo running', () => {
    assert.equal(
      resolveViewerPageTakeover({ source: 'none', ...RUNNING, isSamePage: false }),
      'adopt'
    )
  })

  // R3: whatever credential the session kept, the running pod's is the one its
  // endpoint accepts — and the page's own session check is what puts it there
  // (`resolveDemoSessionAction`'s `reuse`), keeping how the demo is drawn.
  test('R3: leaves a demo session to the page, which puts it on the demo running', () => {
    assert.equal(
      resolveViewerPageTakeover({ source: 'demo', ...RUNNING, isSamePage: false }),
      'keep'
    )
  })

  test('keeps the visitor\'s own graph file and their own application', () => {
    for (const demo of [RUNNING, STARTING]) {
      for (const source of ['file', 'application'] as const) {
        assert.equal(
          resolveViewerPageTakeover({ source, ...demo, isSamePage: false }),
          'keep',
          `${source}, ${demo.isDemoRunning ? 'running' : 'starting'}`
        )
      }
    }
  })
})

describe('a viewer page arrived at while the demo starts', () => {
  // There is no endpoint to show yet. `/view` waits for it, behind the
  // demo's progress, and opens the viewer on it; the page never boots one.
  test('sends a tab with no graph, or the static graph, to /view to join it', () => {
    for (const source of ['none', 'example'] as const) {
      assert.equal(
        resolveViewerPageTakeover({ source, ...STARTING, isSamePage: false }),
        'join',
        source
      )
    }
  })

  // The page's own session check already waits for a start in flight behind a
  // demo session (`resolveDemoSessionAction`'s `join`), on the page the
  // visitor asked for.
  test('leaves a demo session to the page, which waits for the demo in place', () => {
    assert.equal(
      resolveViewerPageTakeover({ source: 'demo', ...STARTING, isSamePage: false }),
      'keep'
    )
  })
})

test('a viewer page keeps whatever it has before anyone has pressed Load Example', () => {
  for (const source of SOURCES) {
    assert.equal(
      resolveViewerPageTakeover({ source, ...OFF, isSamePage: false }),
      'keep',
      source
    )
  }
})

// A query or hash change keeps the page on screen, which loaded its graph once
// as it mounted: swapping the graph under it would leave it with none to draw.
test('a page changing only its own query keeps the graph it already shows', () => {
  for (const demo of [RUNNING, STARTING]) {
    for (const source of SOURCES) {
      assert.equal(
        resolveViewerPageTakeover({ source, ...demo, isSamePage: true }),
        'keep',
        source
      )
    }
  }
})
