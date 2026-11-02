import type { GraphFileSource } from './graph-file-session.ts'
import { isDemoEndpoint } from './nodepod-demo-endpoint.ts'

/**
 * Which graph a tab is on, told apart by who chose it.
 *
 * - `none` — no graph at all.
 * - `example` — the demo's static graph, opened as a graph file: what the site
 *   shows of the demo before anyone has started it.
 * - `file` — a graph file the visitor opened.
 * - `demo` — the in-browser demo's endpoint, which this site serves from its
 *   own origin, under the runtime's segment (`buildDemoEndpointUrl`).
 * - `application` — somebody's own application, reached through the link it
 *   printed.
 */
export type TabGraphSource = 'none' | 'example' | 'file' | 'demo' | 'application'

/**
 * Names the graph a tab is on. A graph file and an endpoint never coexist in
 * the store; were they to, the file is what the viewer draws.
 *
 * An endpoint is the demo only on the viewer's own origin. The runtime's
 * segment in a path proves nothing elsewhere: somebody's own application can
 * be served under a path that happens to hold it, and is still theirs.
 */
export function resolveTabGraphSource(tab: {
  /** The kind of graph file the tab is on, if it is on one. */
  graphFile?: GraphFileSource['kind'] | null
  /** The endpoint the tab is on, empty when it is on none. */
  endpointUrl: string
  /** The viewer's own origin, the only one the demo is served from. */
  viewerOrigin: string
}): TabGraphSource {
  if (tab.graphFile) {
    return tab.graphFile
  }

  if (!tab.endpointUrl) {
    return 'none'
  }

  return isDemoEndpoint(tab.endpointUrl, tab.viewerOrigin) ? 'demo' : 'application'
}

/**
 * Whether the demo this document is running, or starting, takes the tab's
 * graph over.
 *
 * Once the visitor has pressed "Load Example", the application running in this
 * tab is the demo, on every preview and every viewer page alike: the static
 * graph and the landing card only ever stood in for it. So it takes over a tab
 * with no graph, a tab on the demo's static graph, and a tab on a demo session,
 * whichever pod that session was opened on. It never takes over what the
 * visitor chose: a graph file they opened, or their own application, reached
 * through the link it printed. Nothing is taken over before the demo is
 * started, and a reload ends it.
 */
export function liveDemoTakesOver(input: {
  source: TabGraphSource
  /** The demo is running in this document, or on its way up. */
  isDemoActive: boolean
}): boolean {
  return input.isDemoActive
    && (input.source === 'none' || input.source === 'example' || input.source === 'demo')
}

/**
 * What a viewer page does about the demo as it is arrived at.
 *
 * - `adopt` — put the running demo in the session; the page loads it.
 * - `join` — go to `/view`, which waits for the demo starting.
 * - `keep` — carry on with the tab's own graph.
 */
export type ViewerPageTakeover = 'adopt' | 'join' | 'keep'

/**
 * What a viewer page — `/view/<page>`, or a module's deep dive — does about the
 * demo as the visitor arrives at it, where {@link liveDemoTakesOver} says the
 * demo takes the tab over. It never boots the demo: only "Load Example" does.
 *
 * A running demo is adopted on the spot in place of no graph or the static
 * graph, and the page loads it like any other endpoint. One still starting has
 * no endpoint to adopt yet, so such a tab waits for it on `/view`, which shows
 * how far the start has got and opens the viewer once it is up. A demo session
 * is the page's own to settle, running or starting: its session check
 * (`resolveDemoSessionAction`) puts it on the running pod's credential, or
 * waits for a start in flight, on the page the visitor asked for. Adopting it
 * here as well would present the demo afresh on every move between pages,
 * undoing whatever the visitor changed about how it is drawn.
 *
 * A navigation that only changes the query or hash of the page on screen keeps
 * whatever that page shows: the page loaded its graph as it mounted, and would
 * be left with none to draw if the store moved to another graph under it.
 */
export function resolveViewerPageTakeover(input: {
  source: TabGraphSource
  isDemoRunning: boolean
  isDemoStarting: boolean
  /** The navigation only changes the query or hash of the page on screen. */
  isSamePage: boolean
}): ViewerPageTakeover {
  const isDemoActive = input.isDemoRunning || input.isDemoStarting

  if (
    input.isSamePage
    || input.source === 'demo'
    || !liveDemoTakesOver({ source: input.source, isDemoActive })
  ) {
    return 'keep'
  }

  return input.isDemoRunning ? 'adopt' : 'join'
}
