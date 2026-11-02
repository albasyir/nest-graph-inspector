import type { NodepodDemoStatus } from '../stores/nodepod-demo.ts'
import type { GraphFileSource } from './graph-file-session.ts'

/**
 * The demo application's graph, as the site shows it before anyone asks for
 * the live demo.
 *
 * The demo's `build:nodepod` script ends by running `nest-graph-inspector
 * export` against the demo's build, writing `graph.json` beside the nodepod
 * payload: the graph the demo serves when Node runs it. The landing page draws
 * that file and boots nothing until the visitor presses "Load Example", which
 * starts the live demo exactly as before. The live graph is not quite the same:
 * the payload build keeps the in-browser demo to what its own `src/` declares
 * (`DISCOVERY_PATCHES` in `demo/scripts/build-nodepod-payload.ts`), so the
 * third-party modules in the static graph are not in the live one.
 */

/** Where the static graph is published, relative to the site's base URL. */
export const EXAMPLE_GRAPH_FILE = 'nodepod-demo/graph.json'

/** The static graph, opened in the viewer as a file source. */
export const EXAMPLE_GRAPH_SOURCE: GraphFileSource = {
  name: 'graph.json',
  kind: 'example'
}

/** The static graph's absolute URL, under the base path the site is served from. */
export function resolveExampleGraphUrl(baseURL: string, origin: string): string {
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`

  return new URL(EXAMPLE_GRAPH_FILE, new URL(base, origin)).toString()
}

export type ExampleGraphStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * What a preview does as it mounts: fetch the static graph if nothing has yet.
 * Never start the live demo — downloading an application and booting a
 * runtime is for the visitor to ask for.
 */
export function resolveDemoPreviewMountAction(
  exampleStatus: ExampleGraphStatus
): 'load-example-graph' | 'none' {
  return exampleStatus === 'idle' ? 'load-example-graph' : 'none'
}

export type DemoPreviewView = {
  /**
   * The graph a preview draws: the live demo's once it is running, else the
   * static export, else none yet.
   */
  source: 'live' | 'static' | null
  /** What shows in place of a graph, while there is none to draw. */
  placeholder: 'loading' | 'error' | null
  /**
   * Where the live demo is: not asked for, on its way up, running, or failed
   * to start. A preview offers "Load Example" when it is off or failed.
   */
  liveDemo: 'off' | 'starting' | 'running' | 'failed'
}

/** What a preview shows, given the static graph's state and the live demo's. */
export function resolveDemoPreviewView(input: {
  hasLiveGraph: boolean
  hasExampleGraph: boolean
  exampleStatus: ExampleGraphStatus
  /** The live demo's status; `ready` without a graph is its graph on the way. */
  demoStatus: NodepodDemoStatus
}): DemoPreviewView {
  const liveDemo = input.hasLiveGraph
    ? 'running'
    : input.demoStatus === 'error'
      ? 'failed'
      : input.demoStatus === 'idle'
        ? 'off'
        : 'starting'
  const source = input.hasLiveGraph
    ? 'live'
    : input.hasExampleGraph
      ? 'static'
      : null

  if (source) {
    return { source, placeholder: null, liveDemo }
  }

  // Nothing to draw yet. A static graph that failed is an error only while
  // the live demo is not on its way to replacing it.
  const placeholder = input.exampleStatus === 'error' && liveDemo !== 'starting'
    ? 'error'
    : 'loading'

  return { source, placeholder, liveDemo }
}

/**
 * Why a preview's Direct Run cannot run yet, or nothing once it can: only the
 * running demo has methods to call, and a preview starts it only when the
 * visitor presses "Load Example".
 */
export function describePreviewDirectRun(liveDemo: DemoPreviewView['liveDemo']): string | undefined {
  switch (liveDemo) {
    case 'running':
      return undefined
    case 'starting':
      return 'The demo application is starting in this tab. Its methods can run as soon as it is up.'
    case 'failed':
      return 'Direct Run calls the demo application, which did not start. Press Try Again below the graph to start it in this tab, then run this method.'
    default:
      return 'Direct Run calls the demo application, which is not running. Press Load Example below the graph to start it in this tab, then run this method.'
  }
}
