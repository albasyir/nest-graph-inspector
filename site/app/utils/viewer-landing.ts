import { resolveInspectorMountBase } from './nodepod-demo-endpoint.ts'

/** The viewer page `/view` sends a visitor on to. */
export type ViewerLandingPath = '/view/navigator' | '/view/trace'

/**
 * What `/view` does when it is opened.
 *
 * - `start-demo` — boot the in-browser demo and open the viewer on it.
 * - `open-session` — the tab is already on a graph; go back to it.
 * - `manual` — show the landing card and watch for a local inspector.
 */
export type ViewerLandingAction
  = | { kind: 'start-demo' }
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
 * Opening the viewer is asking to see a graph, so by default the page starts
 * the demo rather than waiting for a click. Three things come first:
 *
 * 1. `?preview=true` is a docs preview asking for the demo by name, so it gets
 *    the demo even when the tab is on another graph.
 * 2. `?autoload=false` opts out, keeping the landing card — what "Try Another
 *    URL" links to, since bouncing back to the graph that just failed would
 *    leave no way out.
 * 3. A restored session for somebody's own application goes straight back to
 *    the viewer, but only when the viewer would accept it: the bootstrap
 *    middleware sends a session without a usable token back here, and
 *    redirecting it again would loop. A restored *demo* session is not
 *    redirected — the pod behind it may be gone, and starting the demo from
 *    here recovers it with the landing card to fall back on, where the viewer
 *    page would send a failed restart straight back to `/view`.
 *
 * A demo that already failed in this tab is not started again on its own: the
 * error dialog is the visitor's to answer, and its retry is what boots another.
 */
export function resolveViewerLandingAction(input: {
  query: Record<string, unknown>
  restoredEndpointUrl: string
  canOpenRestoredSession: boolean
  demoFailed: boolean
}): ViewerLandingAction {
  if (input.query.preview === 'true') {
    return { kind: 'start-demo' }
  }

  if (input.query.autoload === 'false') {
    return { kind: 'manual' }
  }

  if (
    input.restoredEndpointUrl
    && input.canOpenRestoredSession
    && !resolveInspectorMountBase(input.restoredEndpointUrl)
  ) {
    return {
      kind: 'open-session',
      path: resolveViewerLandingPath(input.query)
    }
  }

  if (input.demoFailed) {
    return { kind: 'manual' }
  }

  return { kind: 'start-demo' }
}
