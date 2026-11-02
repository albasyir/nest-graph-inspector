import type { GraphFileSource } from './graph-file-session.ts'
import { canOpenWithoutAccessToken } from './inspector-access-token.ts'
import { resolveTabGraphSource, resolveViewerPageTakeover } from './live-demo-takeover.ts'

/**
 * What a viewer page does as the visitor arrives at it, once the tab's graph
 * has been restored.
 *
 * - `adopt-demo` — put the demo running in this document in the session, in
 *   place of the graph the tab was on; the page loads it.
 * - `join-demo` — go to `/view`, which waits for the demo starting in this
 *   document and opens the viewer on it.
 * - `open` — show the graph the tab is on.
 * - `no-graph` — go to `/view`: the tab is on no graph at all.
 * - `no-credential` — go to `/view`: the tab's endpoint needs a token the tab
 *   does not hold, and only the printed link hands one over.
 */
export type ViewerPageArrival = 'adopt-demo' | 'join-demo' | 'open' | 'no-graph' | 'no-credential'

/** A path without the trailing slashes the router matches it with all the same. */
function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, '')
}

/**
 * Decides what `middleware/graph-viewer-bootstrap.global.ts` does for a viewer
 * page — `/view/<page>`, or a module's deep dive — once the printed link is
 * spent and the tab's graph is restored: everything it reads, passed in, so
 * the decision runs under the site's plain `node --test` runner.
 *
 * First the demo the visitor started in this document
 * (`resolveViewerPageTakeover`): adopted in place of no graph or the static
 * graph while it runs, and waited for on `/view` while it starts. Otherwise
 * the tab's own graph: a graph file opens as it is, no graph at all goes to
 * `/view`, and an endpoint opens only with its credential — a graph served
 * from this site's own origin, the in-browser demo, needs none to be opened.
 */
export function resolveViewerPageArrival(input: {
  /** The path being navigated to. */
  toPath: string
  /** The path navigated from: the same one means only the query or hash changed. */
  fromPath: string
  /** The kind of graph file the tab is on, if it is on one. */
  graphFile?: GraphFileSource['kind'] | null
  /** The endpoint the tab is on, empty when it is on none. */
  endpointUrl: string
  /** The tab holds a token for that endpoint. */
  hasAccessToken: boolean
  /** The viewer's own origin. */
  viewerOrigin: string
  isDemoRunning: boolean
  isDemoStarting: boolean
}): ViewerPageArrival {
  const source = resolveTabGraphSource({
    graphFile: input.graphFile,
    endpointUrl: input.endpointUrl
  })
  const takeover = resolveViewerPageTakeover({
    source,
    isDemoRunning: input.isDemoRunning,
    isDemoStarting: input.isDemoStarting,
    isSamePage: trimTrailingSlashes(input.toPath) === trimTrailingSlashes(input.fromPath)
  })

  if (takeover === 'adopt') {
    return 'adopt-demo'
  }

  if (takeover === 'join') {
    return 'join-demo'
  }

  if (source === 'file' || source === 'example') {
    return 'open'
  }

  if (source === 'none') {
    return 'no-graph'
  }

  return input.hasAccessToken || canOpenWithoutAccessToken(input.endpointUrl, input.viewerOrigin)
    ? 'open'
    : 'no-credential'
}
