import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { MOBILE_BREAKPOINT_PX, isMobileDevice } from './device-detection.ts'
import {
  describeViewerGraphStatus,
  resolveAiChatAvailability,
  resolveEndpointHost,
  resolveViewerHeaderPage,
  type ViewerGraphState,
  type ViewerGraphStatusInput
} from './viewer-header.ts'

const ENDPOINT = 'http://localhost:53371/__graph-inspector'
const DEMO_ENDPOINT = 'http://127.0.0.1:3000/nest-graph-inspector/__nodepod__/53371/__graph-inspector'
const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'

/** A tab that has loaded a live application's graph, and nothing else going on. */
function loaded(overrides: Partial<ViewerGraphStatusInput> = {}): ViewerGraphStatusInput {
  return {
    endpointUrl: ENDPOINT,
    isDemo: false,
    isDemoStarting: false,
    isLoading: false,
    hasGraph: true,
    graphVersion: '3',
    isStatic: false,
    requiresAccessToken: false,
    isUnreachable: false,
    hasLoadError: false,
    ...overrides
  }
}

describe('the page a route marks current', () => {
  test('each viewer page is its own tab', () => {
    assert.equal(resolveViewerHeaderPage('/view/navigator'), 'navigator')
    assert.equal(resolveViewerHeaderPage('/view/issues'), 'issues')
    assert.equal(resolveViewerHeaderPage('/view/trace'), 'trace')
  })

  test('a trailing slash is the same page', () => {
    assert.equal(resolveViewerHeaderPage('/view/navigator/'), 'navigator')
    assert.equal(resolveViewerHeaderPage('/view/issues/'), 'issues')
    assert.equal(resolveViewerHeaderPage('/view/trace/'), 'trace')
  })

  test('a module deep dive is still the navigator', () => {
    assert.equal(resolveViewerHeaderPage('/view/navigator/modules/UserModule'), 'navigator')
    assert.equal(resolveViewerHeaderPage('/view/navigator/modules/Already%2520Encoded'), 'navigator')
  })

  test('the trace page under its former name is the trace page', () => {
    assert.equal(resolveViewerHeaderPage('/view/execution-sequence'), 'trace')
  })

  test('only the navigator has pages beneath it', () => {
    assert.equal(resolveViewerHeaderPage('/view/issues/modules/UserModule'), undefined)
    assert.equal(resolveViewerHeaderPage('/view/trace/anything'), undefined)
  })

  test('a route outside the viewer\'s pages marks none of them', () => {
    const printedLink = `/view/${Buffer.from(`${ENDPOINT}?__inspector_token=${TOKEN}`).toString('base64url')}`

    for (const path of ['/', '/view', '/view/', printedLink, `${printedLink}/issues`, '/view/navigator-old', '/viewer/navigator', '/getting-started']) {
      assert.equal(resolveViewerHeaderPage(path), undefined, path)
    }
  })

  // The layout is not remounted between viewer pages, so the current tab has
  // to follow whatever route the browser's own buttons land on.
  test('back and forward move the current tab with the route', () => {
    const visited = [
      '/view/navigator',
      '/view/navigator/modules/OrderModule',
      '/view/issues',
      '/view/trace'
    ]
    const forward = visited.map(resolveViewerHeaderPage)

    assert.deepEqual(forward, ['navigator', 'navigator', 'issues', 'trace'])
    assert.deepEqual(
      [...visited].reverse().map(resolveViewerHeaderPage),
      [...forward].reverse()
    )
  })
})

describe('the graph status', () => {
  test('a loaded graph says so, under the host it came from', () => {
    const status = describeViewerGraphStatus(loaded())

    assert.equal(status.state, 'ready')
    assert.equal(status.tone, 'success')
    assert.equal(status.title, 'localhost:53371')
    assert.equal(status.host, 'localhost:53371')
    assert.equal(status.label, 'Graph loaded')
    assert.equal(status.busy, false)
  })

  test('the demo is named as the demo, never by an address that means nothing outside the tab', () => {
    const status = describeViewerGraphStatus(loaded({ endpointUrl: DEMO_ENDPOINT, isDemo: true }))

    assert.equal(status.title, 'In-browser demo')
    assert.equal(status.host, undefined)
    assert.ok(!status.description.includes('127.0.0.1'), status.description)
    assert.ok(!status.description.includes('__nodepod__'), status.description)
  })

  test('a static graph says it is one', () => {
    const status = describeViewerGraphStatus(loaded({ isStatic: true }))

    assert.equal(status.state, 'ready')
    assert.equal(status.label, 'Static snapshot')
  })

  // The store keeps a graph in an output version this viewer cannot read, and
  // opens the "update your package" modal over it, so holding a graph is not
  // the same as having one to show.
  test('a graph in an output version the viewer does not read asks for an update', () => {
    for (const graphVersion of ['2', 2, '1.0', 'nonsense', undefined, null]) {
      const status = describeViewerGraphStatus(loaded({ graphVersion }))

      assert.equal(status.state, 'unsupported', String(graphVersion))
      assert.equal(status.tone, 'warning', String(graphVersion))
      assert.equal(status.label, 'Update required', String(graphVersion))
      assert.match(status.description, /Update nest-graph-inspector/)
    }

    for (const graphVersion of ['3', 3, '4']) {
      assert.equal(describeViewerGraphStatus(loaded({ graphVersion })).state, 'ready', String(graphVersion))
    }
  })

  test('a load under way, or a failure, outranks a graph in a version the viewer does not read', () => {
    assert.equal(describeViewerGraphStatus(loaded({ graphVersion: '2', isLoading: true })).state, 'loading')
    assert.equal(
      describeViewerGraphStatus(loaded({ graphVersion: '2', requiresAccessToken: true, hasLoadError: true })).state,
      'token-required'
    )
    assert.equal(
      describeViewerGraphStatus(loaded({ graphVersion: '2', isUnreachable: true, hasLoadError: true })).state,
      'unreachable'
    )
    assert.equal(describeViewerGraphStatus(loaded({ graphVersion: '2', hasLoadError: true })).state, 'failed')
  })

  test('a load under way outranks the last attempt\'s error and the graph still held', () => {
    const status = describeViewerGraphStatus(loaded({
      isLoading: true,
      hasLoadError: true,
      isUnreachable: true,
      requiresAccessToken: true
    }))

    assert.equal(status.state, 'loading')
    assert.equal(status.busy, true)
    assert.equal(status.description, 'Fetching the graph from localhost:53371.')
  })

  test('a refused token outranks every other failure', () => {
    const status = describeViewerGraphStatus(loaded({
      requiresAccessToken: true,
      isUnreachable: true,
      hasLoadError: true
    }))

    assert.equal(status.state, 'token-required')
    assert.equal(status.tone, 'warning')
    assert.match(status.description, /link printed in your application console/)
  })

  test('an endpoint that never answered is told apart from one that failed', () => {
    assert.equal(
      describeViewerGraphStatus(loaded({ isUnreachable: true, hasLoadError: true })).state,
      'unreachable'
    )
    assert.equal(describeViewerGraphStatus(loaded({ hasLoadError: true })).state, 'failed')
  })

  // A failed reload keeps the graph from before it, and the page shows the
  // failure rather than that graph; the header must not call it loaded.
  test('a graph held through a failed reload is reported as the failure', () => {
    for (const failure of [{ isUnreachable: true }, { hasLoadError: true }, { requiresAccessToken: true }]) {
      const status = describeViewerGraphStatus(loaded({ ...failure, hasLoadError: true }))

      assert.notEqual(status.state, 'ready', JSON.stringify(failure))
      assert.ok(status.tone === 'error' || status.tone === 'warning', status.tone)
    }
  })

  test('an endpoint with no graph and no failure is not loaded yet', () => {
    const status = describeViewerGraphStatus(loaded({ hasGraph: false }))

    assert.equal(status.state, 'not-loaded')
    assert.equal(status.busy, false)
  })

  test('no endpoint is none, unless the demo is starting to provide one', () => {
    const none = describeViewerGraphStatus(loaded({ endpointUrl: '', hasGraph: false }))
    const starting = describeViewerGraphStatus(loaded({ endpointUrl: '', hasGraph: false, isDemoStarting: true }))

    assert.equal(none.state, 'none')
    assert.equal(none.busy, false)
    assert.equal(none.title, 'No graph selected')
    assert.equal(none.host, undefined)
    assert.equal(starting.state, 'starting-demo')
    assert.equal(starting.busy, true)
    assert.equal(starting.title, 'In-browser demo')
  })

  test('only work under way turns the icon', () => {
    const busyStates = new Set<ViewerGraphState>(['loading', 'starting-demo'])
    const inputs: ViewerGraphStatusInput[] = [
      loaded(),
      loaded({ hasGraph: false }),
      loaded({ graphVersion: '2' }),
      loaded({ isLoading: true }),
      loaded({ requiresAccessToken: true }),
      loaded({ isUnreachable: true }),
      loaded({ hasLoadError: true }),
      loaded({ endpointUrl: '' }),
      loaded({ endpointUrl: '', isDemoStarting: true })
    ]

    for (const input of inputs) {
      const status = describeViewerGraphStatus(input)

      assert.equal(status.busy, busyStates.has(status.state), status.state)
      assert.ok(status.title && status.label && status.description && status.icon, status.state)
    }
  })
})

// Both headers name the endpoint by its title — the compact one on its status
// button, the desktop one under "Graph Viewer" — so the title is all of an
// address either of them ever shows.
describe('the endpoint the header names', () => {
  test('is its host and port alone, however long the address', () => {
    const status = describeViewerGraphStatus(loaded({
      endpointUrl: 'https://graph-inspector.staging.payments-platform.eu-west-1.internal.example.com:53371/api/v2/internal/tools/__graph-inspector'
    }))

    assert.equal(status.title, 'graph-inspector.staging.payments-platform.eu-west-1.internal.example.com:53371')
    assert.equal(status.host, status.title)
    assert.ok(!JSON.stringify(status).includes('/api/v2'), 'the path reached the header')
  })

  test('keeps a default port out, as the URL itself does', () => {
    assert.equal(
      describeViewerGraphStatus(loaded({ endpointUrl: 'https://inspector.example.com/__graph-inspector' })).title,
      'inspector.example.com'
    )
  })

  // Shown as it is, an address the header can read no host from could be
  // anything at all — a credential included.
  test('is a neutral name when the address has no host to read, or does not parse', () => {
    for (const endpointUrl of ['localhost:53371', 'not a url', 'file:///srv/graph/output.json', 'http://']) {
      const status = describeViewerGraphStatus(loaded({ endpointUrl }))

      assert.equal(status.title, 'Graph endpoint', endpointUrl)
      assert.equal(status.host, undefined, endpointUrl)
    }
  })
})

// The header shows what the store hands it, and that is not guaranteed to be
// clean: an address can carry user info, a printed link can spell the token's
// parameter in a way redaction does not recognise, and a URL can fail to parse.
describe('an endpoint carrying a secret', () => {
  const PASSWORD = 'hunter2'

  /** Every state the header can describe an endpoint in. */
  const STATES: Partial<ViewerGraphStatusInput>[] = [
    {},
    { isStatic: true },
    { graphVersion: '2' },
    { hasGraph: false },
    { isLoading: true },
    { requiresAccessToken: true, hasLoadError: true },
    { isUnreachable: true, hasLoadError: true },
    { hasLoadError: true }
  ]

  for (const [secret, endpointUrl, host] of [
    ['user info', `http://dev:${PASSWORD}@localhost:53371/__graph-inspector`, 'localhost:53371'],
    ['an access token', `${ENDPOINT}?__inspector_token=${TOKEN}`, 'localhost:53371'],
    ['an access token under a percent-encoded name', `${ENDPOINT}?%5F%5Finspector_token=${TOKEN}`, 'localhost:53371'],
    ['an access token under a lower-case percent-encoded name', `${ENDPOINT}?mode=dev&%5f%5finspector%5ftoken=${TOKEN}`, 'localhost:53371'],
    ['an access token in the fragment', `${ENDPOINT}#__inspector_token=${TOKEN}`, 'localhost:53371'],
    ['user info and an access token together', `https://dev:${PASSWORD}@inspector.example.com/__graph-inspector?%5F%5Finspector_token=${TOKEN}`, 'inspector.example.com'],
    ['user info and an access token, with no scheme', `dev:${PASSWORD}@localhost:53371/__graph-inspector?__inspector_token=${TOKEN}`, undefined],
    ['an access token, with no scheme', `localhost:53371/__graph-inspector?%5F%5Finspector_token=${TOKEN}`, undefined],
    ['an access token, scheme-relative', `//dev:${PASSWORD}@localhost:53371/?%5F%5Finspector_token=${TOKEN}`, undefined],
    ['user info and an access token, in a URL that does not parse', `http://dev:${PASSWORD}@local host:53371/?__inspector_token=${TOKEN}`, undefined],
    ['an access token, in no URL at all', `not a url ?__inspector_token=${TOKEN}`, undefined]
  ] as const) {
    test(`with ${secret} names ${host ?? 'no host'}, and nothing else of the address`, () => {
      // All the loading state says of an endpoint, too.
      assert.equal(resolveEndpointHost(endpointUrl), host)

      for (const state of STATES) {
        const status = describeViewerGraphStatus(loaded({ endpointUrl, ...state }))
        const shown = JSON.stringify(status)

        assert.equal(status.title, host ?? 'Graph endpoint', shown)
        assert.equal(status.host, host, shown)
        assert.ok(!shown.includes(endpointUrl), `the address reached the header: ${shown}`)
        assert.ok(!shown.includes(TOKEN), `the access token reached the header: ${shown}`)
        assert.ok(!shown.includes(PASSWORD), `the password reached the header: ${shown}`)
        assert.doesNotMatch(shown, /inspector(?:_|%5f)token/i, 'the token parameter reached the header')
      }
    })
  }
})

describe('the AI chat', () => {
  test('opens on a desktop that has a graph', () => {
    assert.equal(resolveAiChatAvailability({ hasGraphEndpoint: true, isRestricted: false }), 'available')
  })

  test('waits for a graph on a desktop that has none', () => {
    assert.equal(resolveAiChatAvailability({ hasGraphEndpoint: false, isRestricted: false }), 'no-graph')
  })

  test('is refused on a restricted device whatever graph it has', () => {
    assert.equal(resolveAiChatAvailability({ hasGraphEndpoint: true, isRestricted: true }), 'restricted')
    assert.equal(resolveAiChatAvailability({ hasGraphEndpoint: false, isRestricted: true }), 'restricted')
  })

  // The layout asks `isMobileDevice` through `useMobileDevice`; these are the
  // devices the header is laid out for, decided by the same check.
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

  for (const [label, device, available] of [
    ['a 320px phone', { userAgent: IPHONE, viewportWidth: 320 }, false],
    ['a 390px phone', { userAgent: IPHONE, viewportWidth: 390 }, false],
    ['a phone on its side', { userAgent: IPHONE, viewportWidth: 844 }, false],
    ['a 768px tablet', { userAgent: IPAD, viewportWidth: 768 }, false],
    ['a tablet on its side', { userAgent: IPAD, viewportWidth: 1024 }, false],
    ['a desktop window narrower than the breakpoint', { userAgent: DESKTOP, viewportWidth: MOBILE_BREAKPOINT_PX - 1 }, false],
    ['a desktop window at the breakpoint', { userAgent: DESKTOP, viewportWidth: MOBILE_BREAKPOINT_PX }, true],
    ['a desktop', { userAgent: DESKTOP, viewportWidth: 1280 }, true]
  ] as const) {
    test(`${available ? 'opens' : 'never opens'} on ${label}, with a graph loaded`, () => {
      const availability = resolveAiChatAvailability({
        hasGraphEndpoint: true,
        isRestricted: isMobileDevice(device)
      })

      assert.equal(availability === 'available', available, availability)
    })
  }
})
