import type { GraphFileSource } from './graph-file-session.ts'
import { resolveInspectorMountBase } from './nodepod-demo-endpoint.ts'

/**
 * Which graph a tab is on, told apart by who chose it.
 *
 * - `none` — no graph at all.
 * - `example` — the demo's static graph, opened as a graph file: what the site
 *   shows of the demo before anyone has started it.
 * - `file` — a graph file the visitor opened.
 * - `demo` — the in-browser demo's endpoint.
 * - `application` — somebody's own application, reached through the link it
 *   printed.
 */
export type TabGraphSource = 'none' | 'example' | 'file' | 'demo' | 'application'

/**
 * Names the graph a tab is on. A graph file and an endpoint never coexist in
 * the store; were they to, the file is what the viewer draws.
 */
export function resolveTabGraphSource(tab: {
  /** The kind of graph file the tab is on, if it is on one. */
  graphFile?: GraphFileSource['kind'] | null
  /** The endpoint the tab is on, empty when it is on none. */
  endpointUrl: string
}): TabGraphSource {
  if (tab.graphFile) {
    return tab.graphFile
  }

  if (!tab.endpointUrl) {
    return 'none'
  }

  return resolveInspectorMountBase(tab.endpointUrl) ? 'demo' : 'application'
}

/**
 * Whether the demo this document is running, or starting, takes the tab's
 * graph over.
 *
 * TODO(t_f2e5c392): stub reproducing today's behaviour — the running demo takes
 * nothing over.
 */
export function liveDemoTakesOver(_input: {
  source: TabGraphSource
  /** The demo is running in this document, or on its way up. */
  isDemoActive: boolean
}): boolean {
  return false
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
 * TODO(t_f2e5c392): stub reproducing today's behaviour — a viewer page always
 * keeps the tab's own graph.
 */
export function resolveViewerPageTakeover(_input: {
  source: TabGraphSource
  isDemoRunning: boolean
  isDemoStarting: boolean
  /** The navigation only changes the query or hash of the page on screen. */
  isSamePage: boolean
}): ViewerPageTakeover {
  return 'keep'
}
