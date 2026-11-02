import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { NODEPOD_ROUTE_SEGMENT } from './nodepod-demo-endpoint.ts'
import { resolveViewerPageArrival } from './viewer-page-arrival.ts'

const SITE_ORIGIN = 'https://albasyir.github.io'
const DEMO_ENDPOINT = `${SITE_ORIGIN}/nest-graph-inspector/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`
const OWN_ENDPOINT = 'http://localhost:53371/__graph-inspector'
/** Somebody's own application, served under a path that holds the runtime's segment. */
const OWN_ENDPOINT_UNDER_SEGMENT = `https://staging.example.com/${NODEPOD_ROUTE_SEGMENT}/53371/__graph-inspector`

const VIEWER_PAGES = [
  '/view/navigator',
  '/view/issues',
  '/view/trace',
  '/view/navigator/modules/UserModule'
]

/**
 * A tab arriving at the navigator from the landing page — through a link, or
 * Back — on no graph, in a document that has not started the demo.
 */
const arriving = {
  toPath: '/view/navigator',
  fromPath: '/',
  graphFile: null,
  endpointUrl: '',
  hasAccessToken: false,
  siteBaseUrl: `${SITE_ORIGIN}/nest-graph-inspector/`,
  isDemoRunning: false,
  isDemoStarting: false
}

/** The demo the visitor started with "Load Example", up and answering. */
const RUNNING = { isDemoRunning: true, isDemoStarting: false }
/** The demo the visitor started, still downloading or booting. */
const STARTING = { isDemoRunning: false, isDemoStarting: true }

describe('a viewer page arrived at once the visitor has started the demo', () => {
  // R2: "Open full-screen demo" opened the demo's static graph at
  // /view/navigator; "Load Example" back on the landing page started the demo;
  // Back returns to that entry.
  test('R2: Back to the navigator that showed the static graph opens the demo running', () => {
    assert.equal(
      resolveViewerPageArrival({ ...arriving, graphFile: 'example', ...RUNNING }),
      'adopt-demo'
    )
  })

  // R1: the demo was started from a preview, and the tab has no graph of its
  // own: every viewer page shows the demo, rather than sending the visitor to
  // the landing card.
  test('R1: /view/issues, and every viewer page, opens the demo running', () => {
    for (const toPath of VIEWER_PAGES) {
      assert.equal(
        resolveViewerPageArrival({ ...arriving, toPath, fromPath: '/', ...RUNNING }),
        'adopt-demo',
        toPath
      )
      assert.equal(
        resolveViewerPageArrival({ ...arriving, toPath, fromPath: '/view/navigator', graphFile: 'example', ...RUNNING }),
        toPath === '/view/navigator' ? 'open' : 'adopt-demo',
        `${toPath}, from the navigator on the static graph`
      )
    }
  })

  // R3: the tab is on a demo session. The page's own session check puts it on
  // the running pod's credential (`resolveDemoSessionAction`'s `reuse`); the
  // demo is served from this site's own origin, so it opens without a token.
  test('R3: a demo session opens, for the page to put on the demo running', () => {
    for (const hasAccessToken of [true, false]) {
      assert.equal(
        resolveViewerPageArrival({ ...arriving, endpointUrl: DEMO_ENDPOINT, hasAccessToken, ...RUNNING }),
        'open'
      )
    }
  })

  test('keeps the visitor\'s own graph file', () => {
    for (const toPath of VIEWER_PAGES) {
      assert.equal(
        resolveViewerPageArrival({ ...arriving, toPath, graphFile: 'file', ...RUNNING }),
        'open',
        toPath
      )
    }
  })

  test('keeps the visitor\'s own application, with its credential, and refuses it without', () => {
    for (const endpointUrl of [OWN_ENDPOINT, OWN_ENDPOINT_UNDER_SEGMENT]) {
      assert.equal(
        resolveViewerPageArrival({ ...arriving, endpointUrl, hasAccessToken: true, ...RUNNING }),
        'open',
        endpointUrl
      )
      assert.equal(
        resolveViewerPageArrival({ ...arriving, endpointUrl, hasAccessToken: false, ...RUNNING }),
        'no-credential',
        endpointUrl
      )
    }
  })

  // A query or hash change keeps the page on screen, which loaded its graph as
  // it mounted: swapping the graph under it would leave it with none to draw.
  test('a page changing only its query or hash keeps the graph it already shows', () => {
    for (const fromPath of ['/view/navigator', '/view/navigator/']) {
      assert.equal(
        resolveViewerPageArrival({ ...arriving, fromPath, graphFile: 'example', ...RUNNING }),
        'open',
        fromPath
      )
    }
    // With no graph at all there is nothing to keep: the page goes to `/view`,
    // which joins the demo.
    assert.equal(
      resolveViewerPageArrival({ ...arriving, fromPath: '/view/navigator', ...RUNNING }),
      'no-graph'
    )
  })
})

describe('a viewer page arrived at while the demo starts', () => {
  // There is no endpoint to show yet: `/view` waits for it behind its
  // progress, and opens the viewer on it once it is up.
  test('a tab with no graph, or the static graph, waits for it on /view', () => {
    for (const graphFile of [null, 'example'] as const) {
      for (const toPath of VIEWER_PAGES) {
        assert.equal(
          resolveViewerPageArrival({ ...arriving, toPath, graphFile, ...STARTING }),
          'join-demo',
          `${graphFile}, ${toPath}`
        )
      }
    }
  })

  // The page's own session check waits for a start in flight
  // (`resolveDemoSessionAction`'s `join`), on the page the visitor asked for.
  test('a demo session waits on the page itself', () => {
    assert.equal(
      resolveViewerPageArrival({ ...arriving, toPath: '/view/issues', endpointUrl: DEMO_ENDPOINT, ...STARTING }),
      'open'
    )
  })

  test('the visitor\'s own file and application are kept', () => {
    assert.equal(resolveViewerPageArrival({ ...arriving, graphFile: 'file', ...STARTING }), 'open')
    assert.equal(
      resolveViewerPageArrival({ ...arriving, endpointUrl: OWN_ENDPOINT, hasAccessToken: true, ...STARTING }),
      'open'
    )
  })
})

describe('a viewer page before anyone has pressed Load Example', () => {
  test('a tab with no graph goes to /view, and nothing is started', () => {
    for (const toPath of VIEWER_PAGES) {
      assert.equal(resolveViewerPageArrival({ ...arriving, toPath }), 'no-graph', toPath)
    }
  })

  test('the static graph a preview opened shows as it is', () => {
    assert.equal(resolveViewerPageArrival({ ...arriving, graphFile: 'example' }), 'open')
  })

  // Nothing in a new document answers a demo session; the page's session
  // check lets it go and sends the visitor to the landing card.
  test('a demo session is left to the page', () => {
    assert.equal(resolveViewerPageArrival({ ...arriving, endpointUrl: DEMO_ENDPOINT }), 'open')
  })

  test('the visitor\'s own file opens, and their application only with its credential', () => {
    assert.equal(resolveViewerPageArrival({ ...arriving, graphFile: 'file' }), 'open')
    assert.equal(
      resolveViewerPageArrival({ ...arriving, endpointUrl: OWN_ENDPOINT, hasAccessToken: true }),
      'open'
    )
    assert.equal(
      resolveViewerPageArrival({ ...arriving, endpointUrl: OWN_ENDPOINT }),
      'no-credential'
    )
  })
})
