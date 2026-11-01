import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { NodepodDemoStatus } from '../stores/nodepod-demo.ts'
import {
  EXAMPLE_GRAPH_SOURCE,
  describePreviewDirectRun,
  resolveDemoPreviewMountAction,
  resolveDemoPreviewView,
  resolveExampleGraphUrl,
  type ExampleGraphStatus
} from './demo-graph-preview.ts'

const EXAMPLE_STATUSES: ExampleGraphStatus[] = ['idle', 'loading', 'ready', 'error']
const DEMO_STATUSES: NodepodDemoStatus[] = ['idle', 'downloading', 'booting', 'starting', 'ready', 'error']

describe('the static graph', () => {
  test('is fetched from the site, under the base path it is served from', () => {
    const origin = 'https://albasyir.github.io'

    assert.equal(resolveExampleGraphUrl('/', origin), 'https://albasyir.github.io/nodepod-demo/graph.json')
    assert.equal(
      resolveExampleGraphUrl('/nest-graph-inspector/', origin),
      'https://albasyir.github.io/nest-graph-inspector/nodepod-demo/graph.json'
    )
    assert.equal(
      resolveExampleGraphUrl('/nest-graph-inspector', origin),
      'https://albasyir.github.io/nest-graph-inspector/nodepod-demo/graph.json'
    )
  })

  test('opens in the viewer as the example, not as a file the visitor chose', () => {
    assert.deepEqual(EXAMPLE_GRAPH_SOURCE, { name: 'graph.json', kind: 'example' })
  })
})

// The landing page boots nothing: a preview mounting fetches one static file,
// once, and starting the demo is left to "Load Example".
describe('a preview mounting', () => {
  test('fetches the static graph only when nothing has yet', () => {
    assert.equal(resolveDemoPreviewMountAction('idle'), 'load-example-graph')

    for (const status of ['loading', 'ready', 'error'] as const) {
      assert.equal(resolveDemoPreviewMountAction(status), 'none', status)
    }
  })

  test('never starts the demo, whatever state the static graph is in', () => {
    for (const status of EXAMPLE_STATUSES) {
      assert.ok(
        ['load-example-graph', 'none'].includes(resolveDemoPreviewMountAction(status)),
        status
      )
    }
  })
})

describe('what a preview shows', () => {
  test('is the static graph until the example is loaded', () => {
    assert.deepEqual(
      resolveDemoPreviewView({ hasLiveGraph: false, hasExampleGraph: true, exampleStatus: 'ready', demoStatus: 'idle' }),
      { source: 'static', placeholder: null, liveDemo: 'off' }
    )
  })

  test('keeps the static graph on screen while the example starts', () => {
    for (const demoStatus of ['downloading', 'booting', 'starting', 'ready'] as const) {
      assert.deepEqual(
        resolveDemoPreviewView({ hasLiveGraph: false, hasExampleGraph: true, exampleStatus: 'ready', demoStatus }),
        { source: 'static', placeholder: null, liveDemo: 'starting' },
        demoStatus
      )
    }
  })

  test('is the live graph once the demo reports one', () => {
    for (const exampleStatus of EXAMPLE_STATUSES) {
      assert.deepEqual(
        resolveDemoPreviewView({ hasLiveGraph: true, hasExampleGraph: exampleStatus === 'ready', exampleStatus, demoStatus: 'ready' }),
        { source: 'live', placeholder: null, liveDemo: 'running' },
        exampleStatus
      )
    }
  })

  test('offers the example again when it failed to start', () => {
    assert.deepEqual(
      resolveDemoPreviewView({ hasLiveGraph: false, hasExampleGraph: true, exampleStatus: 'ready', demoStatus: 'error' }),
      { source: 'static', placeholder: null, liveDemo: 'failed' }
    )
  })

  test('is loading while the static graph is on its way', () => {
    for (const exampleStatus of ['idle', 'loading'] as const) {
      assert.deepEqual(
        resolveDemoPreviewView({ hasLiveGraph: false, hasExampleGraph: false, exampleStatus, demoStatus: 'idle' }),
        { source: null, placeholder: 'loading', liveDemo: 'off' }
      )
    }
  })

  // `graph.json` missing from the deployment: say so, and keep Load Example.
  test('is an error when the static graph failed, with the example still on offer', () => {
    for (const demoStatus of ['idle', 'error'] as const) {
      const view = resolveDemoPreviewView({ hasLiveGraph: false, hasExampleGraph: false, exampleStatus: 'error', demoStatus })

      assert.equal(view.source, null)
      assert.equal(view.placeholder, 'error')
      assert.ok(['off', 'failed'].includes(view.liveDemo), demoStatus)
    }
  })

  test('is loading, not an error, while the example starts in place of a static graph that failed', () => {
    assert.deepEqual(
      resolveDemoPreviewView({ hasLiveGraph: false, hasExampleGraph: false, exampleStatus: 'error', demoStatus: 'booting' }),
      { source: null, placeholder: 'loading', liveDemo: 'starting' }
    )
  })

  test('always has a graph or a placeholder, never both', () => {
    for (const exampleStatus of EXAMPLE_STATUSES) {
      for (const demoStatus of DEMO_STATUSES) {
        for (const hasLiveGraph of [false, true]) {
          for (const hasExampleGraph of [false, true]) {
            const view = resolveDemoPreviewView({ hasLiveGraph, hasExampleGraph, exampleStatus, demoStatus })

            assert.equal(view.source === null, view.placeholder !== null, JSON.stringify({ exampleStatus, demoStatus, hasLiveGraph, hasExampleGraph }))
          }
        }
      }
    }
  })
})

describe('Direct Run in a preview', () => {
  test('runs only against the live demo, and says what would start it', () => {
    assert.equal(describePreviewDirectRun('running'), undefined)
    assert.match(describePreviewDirectRun('off') ?? '', /Load Example/)
    assert.match(describePreviewDirectRun('failed') ?? '', /Load Example/)
    assert.match(describePreviewDirectRun('starting') ?? '', /starting/)
  })
})
