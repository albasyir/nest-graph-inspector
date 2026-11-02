import type { GraphFileSource } from './graph-file-session.ts'
import { liveDemoTakesOver, resolveTabGraphSource } from './live-demo-takeover.ts'

/** The viewer page `/view` sends a visitor on to. */
export type ViewerLandingPath = '/view/navigator' | '/view/trace'

/**
 * What `/view` does when it is opened.
 *
 * - `join-demo` — open the viewer on the demo already running, or starting, in
 *   this document. It never boots one.
 * - `open-example` — open the viewer on the demo's static graph, as a graph
 *   file: the one the landing page's previews draw. It boots nothing.
 * - `open-session` — the tab is already on a graph; go back to it.
 * - `manual` — show the landing card, where the visitor can open a graph file
 *   or load the example, and watch for a local inspector.
 */
export type ViewerLandingAction
  = | { kind: 'join-demo' }
    | { kind: 'open-example' }
    | { kind: 'open-session', path: ViewerLandingPath }
    | { kind: 'manual' }

/**
 * Which viewer page `/view` should open.
 *
 * `execution-sequence` is what the trace page was called before it was
 * renamed, and what older docs previews still ask for.
 */
export function resolveViewerLandingPath(
  query: Record<string, unknown>
): ViewerLandingPath {
  const wantsTrace = query.trace === 'true'
    || query['execution-sequence'] === 'true'

  return wantsTrace ? '/view/trace' : '/view/navigator'
}

/**
 * Decides what `/view` does on arrival.
 *
 * Opening `/view` never starts the demo: downloading an application and booting
 * a runtime is for the visitor to ask for, with "Load Example", so the page
 * waits on the landing card by default. Only these move on without a click:
 *
 * 1. `?preview=true` — a preview's "Open full-screen demo" — joins the demo
 *    that preview is already running or starting in this tab, even when the
 *    tab's session names another graph. With no demo to join it opens the
 *    demo's static graph, the one a preview that has not loaded the example
 *    is drawing, rather than booting the demo.
 * 2. Once the visitor has started the demo in this document — from a preview,
 *    or from here — it is joined whenever the tab is on no graph of the
 *    visitor's own choosing: no graph, the demo's static graph, or a demo
 *    session (`liveDemoTakesOver`). Joining waits for a demo still starting.
 * 3. A restored graph file goes back to the navigator — a file has no trace
 *    history.
 * 4. A restored session for somebody's own application goes straight back to
 *    the viewer. Only a session the viewer would accept goes: the bootstrap
 *    middleware sends one without a usable token back here, and redirecting it
 *    again would loop. A restored *demo* session with no demo behind it — a
 *    reload, a restored tab — stays here: nothing in this document answers it,
 *    and the landing card is where the visitor starts the demo again.
 *
 * `?autoload=false` holds back all but the first — it is what "Try Another
 * URL" and Close Graph link to, since bouncing back to the graph that was just
 * left, or into the demo, would leave no way out.
 */
export function resolveViewerLandingAction(input: {
  query: Record<string, unknown>
  restoredEndpointUrl: string
  canOpenRestoredSession: boolean
  /** The tab's session is a graph file, restored with its graph: which kind. */
  restoredGraphFile?: GraphFileSource['kind']
  /** The tab's demo is running, or on its way up. */
  isDemoActive: boolean
  /** The viewer's own origin, which tells the demo's endpoint from others. */
  viewerOrigin: string
}): ViewerLandingAction {
  if (input.query.preview === 'true') {
    return input.isDemoActive ? { kind: 'join-demo' } : { kind: 'open-example' }
  }

  if (input.query.autoload === 'false') {
    return { kind: 'manual' }
  }

  const source = resolveTabGraphSource({
    graphFile: input.restoredGraphFile,
    endpointUrl: input.restoredEndpointUrl,
    viewerOrigin: input.viewerOrigin
  })

  if (liveDemoTakesOver({ source, isDemoActive: input.isDemoActive })) {
    return { kind: 'join-demo' }
  }

  if (source === 'file' || source === 'example') {
    return { kind: 'open-session', path: '/view/navigator' }
  }

  if (source === 'application' && input.canOpenRestoredSession) {
    return {
      kind: 'open-session',
      path: resolveViewerLandingPath(input.query)
    }
  }

  return { kind: 'manual' }
}
