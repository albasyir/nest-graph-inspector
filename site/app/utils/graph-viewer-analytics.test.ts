import { Buffer } from 'node:buffer'
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  createGraphViewerEventProperties,
  describeGraphEndpoint,
  type GraphLoadFailure
} from './graph-viewer-analytics.ts'

const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'
const PASSWORD = 'hunter2'
const PATH_SECRET = 'p4th-s3cret'
const ENDPOINT = 'http://localhost:53371/__graph-inspector'

/** Everything that would be a leak on its own, the token's fragments included. */
const SECRETS = [
  TOKEN,
  ...TOKEN.split(/[.\-_]/).filter(part => part.length > 3),
  PASSWORD,
  PATH_SECRET
]

function assertNothingSecret(value: unknown) {
  const shipped = JSON.stringify(value)

  for (const secret of SECRETS) {
    assert.ok(!shipped.includes(secret), `analytics leaked ${secret}: ${shipped}`)
  }

  assert.doesNotMatch(shipped, /inspector(?:_|%5f)token/i, `analytics leaked the token parameter: ${shipped}`)
}

function eventProperties(
  overrides: Partial<Parameters<typeof createGraphViewerEventProperties>[0]> = {}
) {
  return createGraphViewerEventProperties({
    graphUrl: ENDPOINT,
    viewerRoute: '/view/navigator',
    loadSource: 'initial_mount',
    ...overrides
  })
}

describe('the graph endpoint an event names', () => {
  test('is an ordinary endpoint in full', () => {
    for (const [graphUrl, host, path] of [
      ['http://0.0.0.0:53371/__graph-inspector', '0.0.0.0:53371', '/__graph-inspector'],
      ['http://localhost:53372/__nest-graph-inspector', 'localhost:53372', '/__nest-graph-inspector'],
      [
        'https://albasyir.github.io/nest-graph-inspector/__nodepod__/53371/__graph-inspector',
        'albasyir.github.io',
        '/nest-graph-inspector/__nodepod__/53371/__graph-inspector'
      ],
      ['http://127.0.0.1:3000/__nodepod__/53371/__graph-inspector', '127.0.0.1:3000', '/__nodepod__/53371/__graph-inspector']
    ] as const) {
      assert.deepEqual(describeGraphEndpoint(graphUrl), {
        graph_url: graphUrl,
        graph_url_host: host,
        graph_url_path: path
      })
    }
  })

  // A path can be configured to anything, so only the library's own are named.
  test('leaves out a path that is not the library\'s own', () => {
    assert.deepEqual(describeGraphEndpoint('http://localhost:53372/graph'), {
      graph_url: 'http://localhost:53372',
      graph_url_host: 'localhost:53372',
      graph_url_path: ''
    })
  })

  test('is nothing at all when there is no endpoint', () => {
    assert.deepEqual(describeGraphEndpoint(''), {
      graph_url: '',
      graph_url_host: '',
      graph_url_path: ''
    })
  })
})

// The endpoint an event is handed is not guaranteed to be clean: it can carry
// user info, a token under a spelling redaction does not know, a fragment, a
// configured path — or fail to parse at all.
describe('an endpoint carrying a secret', () => {
  for (const [secret, graphUrl, host, path] of [
    ['user info', `http://dev:${PASSWORD}@localhost:53371/__graph-inspector`, 'localhost:53371', '/__graph-inspector'],
    ['an access token', `${ENDPOINT}?__inspector_token=${TOKEN}`, 'localhost:53371', '/__graph-inspector'],
    ['an access token under a percent-encoded name', `${ENDPOINT}?%5F%5Finspector_token=${TOKEN}`, 'localhost:53371', '/__graph-inspector'],
    [
      'access tokens among other parameters',
      `${ENDPOINT}?mode=dev&%5f%5finspector%5ftoken=${TOKEN}&__inspector_token=${TOKEN}`,
      'localhost:53371',
      '/__graph-inspector'
    ],
    ['an access token under another name', `${ENDPOINT}?key=${TOKEN}`, 'localhost:53371', '/__graph-inspector'],
    ['an access token in the fragment', `${ENDPOINT}#__inspector_token=${TOKEN}`, 'localhost:53371', '/__graph-inspector'],
    ['a secret in the path', `http://localhost:53371/${PATH_SECRET}/__graph-inspector`, 'localhost:53371', ''],
    ['an access token in an encoded path', `http://localhost:53371/__graph-inspector%2F${TOKEN}`, 'localhost:53371', ''],
    [
      'user info and an access token over https',
      `https://dev:${PASSWORD}@inspector.example.com/__graph-inspector?%5F%5Finspector_token=${TOKEN}`,
      'inspector.example.com',
      '/__graph-inspector'
    ],
    ['an access token, with no scheme', `localhost:53371/__graph-inspector?__inspector_token=${TOKEN}`, '', ''],
    ['user info, on a scheme that is not http', `ftp://dev:${PASSWORD}@localhost/__graph-inspector?__inspector_token=${TOKEN}`, '', ''],
    [
      'user info and an access token, in a URL that does not parse',
      `http://dev:${PASSWORD}@local host:53371/?__inspector_token=${TOKEN}`,
      '',
      ''
    ],
    ['an access token, in no URL at all', `not a url ?%5F%5Finspector_token=${TOKEN}`, '', '']
  ] as const) {
    test(`with ${secret} names ${host || 'nothing'}${path}`, () => {
      const described = describeGraphEndpoint(graphUrl)

      assert.equal(described.graph_url_host, host)
      assert.equal(described.graph_url_path, path)
      assert.equal(
        described.graph_url,
        host ? `${new URL(graphUrl).protocol}//${host}${path}` : ''
      )
      assertNothingSecret(described)
      assertNothingSecret(eventProperties({
        graphUrl,
        failure: { status: 401, unreachable: false, unsupported: false }
      }))
    })
  }
})

describe('the viewer route an event names', () => {
  const routeOf = (viewerRoute: string) => eventProperties({ viewerRoute }).viewer_route

  test('is one of the viewer\'s own pages, as it is', () => {
    for (const page of ['/view', '/view/navigator', '/view/issues', '/view/trace']) {
      assert.equal(routeOf(page), page)
      assert.equal(routeOf(`${page}/`), page)
      // A query or a fragment is never part of it.
      assert.equal(routeOf(`${page}?direct-run-on=x&__inspector_token=${TOKEN}#${TOKEN}`), page)
    }
  })

  test('is a module deep dive by its page, never its module', () => {
    for (const moduleId of ['UserModule', encodeURIComponent(`${PATH_SECRET}/${TOKEN}`)]) {
      assert.equal(routeOf(`/view/navigator/modules/${moduleId}`), '/view/navigator/modules/[module]')
    }
  })

  test('is never a printed link, however it is spelled', () => {
    const printed = `${ENDPOINT}?__inspector_token=${TOKEN}`

    for (const segment of [
      Buffer.from(printed).toString('base64url'),
      encodeURIComponent(Buffer.from(printed).toString('base64')),
      // Damaged in copying, so it would not even decode.
      `${Buffer.from(printed).toString('base64url')}.`
    ]) {
      assert.equal(routeOf(`/view/${segment}`), '/view/[url]')
      assert.equal(routeOf(`/view/${segment}/issues`), '/view/[url]/issues')
      assert.equal(routeOf(`/view/${segment}/anything`), '/view/[url]')
    }
  })

  test('is never a path it does not know', () => {
    for (const viewerRoute of [
      '/view/NAVIGATOR',
      `/view/navigator%2F..%2F${PATH_SECRET}`,
      `/view/navigator/${PATH_SECRET}`,
      '/view/execution-sequence',
      `/view/%2E%2E/${TOKEN}`,
      `/getting-started/${PATH_SECRET}`,
      ''
    ]) {
      assert.equal(routeOf(viewerRoute), '/view/[url]', viewerRoute)
    }
  })
})

describe('a failed load', () => {
  const failed = (failure: Partial<GraphLoadFailure>) => eventProperties({
    failure: { status: 0, unreachable: false, unsupported: false, ...failure }
  })

  test('is reported by its status when it got one', () => {
    for (const status of [401, 404, 500]) {
      const properties = failed({ status, unreachable: true, unsupported: true })

      assert.equal(properties.error_status, status)
      assert.equal(properties.error_message, `HTTP ${status}`)
    }
  })

  test('reports no HTTP response only when nothing answered', () => {
    const properties = failed({ unreachable: true })

    assert.equal(properties.error_status, 0)
    assert.equal(properties.error_message, 'No HTTP response')
  })

  // An endpoint that answered — with a graph too old to read, with something
  // that is not an inspector, or before the visitor declined its version — did
  // respond, so it is given a kind, never a status of `0`.
  test('is reported by its kind, without a status, when something answered', () => {
    for (const [failure, label] of [
      [{ unsupported: true }, 'Unsupported graph version'],
      [{}, 'Unknown error']
    ] as const) {
      const properties = failed(failure)

      assert.equal('error_status' in properties, false, label)
      assert.equal(properties.error_message, label)
    }
  })

  test('is not reported for a load that did not fail', () => {
    const properties = eventProperties()

    assert.equal('error_status' in properties, false)
    assert.equal('error_message' in properties, false)
  })
})

test('an event carries no secret, whatever it was handed', () => {
  const printed = Buffer.from(`${ENDPOINT}?__inspector_token=${TOKEN}`).toString('base64url')
  const properties = createGraphViewerEventProperties({
    graphUrl: `https://dev:${PASSWORD}@inspector.example.com/${PATH_SECRET}/__graph-inspector?%5F%5Finspector_token=${TOKEN}#${TOKEN}`,
    viewerRoute: `/view/${printed}/issues?__inspector_token=${TOKEN}#${PATH_SECRET}`,
    loadSource: 'manual_refresh',
    isRetry: true,
    failure: { status: 0, unreachable: true, unsupported: false }
  })

  assertNothingSecret(properties)
  assert.ok(!JSON.stringify(properties).includes(printed), 'analytics leaked the printed link')
  assert.deepEqual(properties, {
    graph_url: 'https://inspector.example.com',
    graph_url_host: 'inspector.example.com',
    graph_url_path: '',
    viewer_route: '/view/[url]/issues',
    load_source: 'manual_refresh',
    is_retry: true,
    error_status: 0,
    error_message: 'No HTTP response'
  })
})
