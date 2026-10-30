import { resolveInspectorMountBase } from './nodepod-demo-endpoint.ts'

/** The viewer page `/view` sends a visitor on to. */
export type ViewerLandingPath = '/view/navigator' | '/view/trace'

/**
 * What `/view` does when it is opened.
 *
 * - `join-demo` — open the viewer on the demo already running, or starting, in
 *   this tab. It never boots one.
 * - `open-session` — the tab is already on a graph; go back to it.
 * - `manual` — show the landing card, where the visitor can start the demo,
 *   and watch for a local inspector.
 */
export type ViewerLandingAction
  = | { kind: 'join-demo' }
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
 * a runtime is for the visitor to ask for, from the landing card, so that is
 * where the page waits by default. Only two things move on without a click:
 *
 * 1. `?preview=true` — a preview's "Open full-screen demo" — joins the demo
 *    that preview is already running or starting in this tab, even when the
 *    tab's session names another graph. With no demo to join it shows the
 *    landing card rather than booting one.
 * 2. A restored session for somebody's own application goes straight back to
 *    the viewer, unless `?autoload=false` holds it back — what "Try Another
 *    URL" links to, since bouncing back to the graph that just failed would
 *    leave no way out. Only a session the viewer would accept goes: the
 *    bootstrap middleware sends one without a usable token back here, and
 *    redirecting it again would loop. A restored *demo* session never does —
 *    nothing in a new document answers it.
 */
export function resolveViewerLandingAction(input: {
  query: Record<string, unknown>
  restoredEndpointUrl: string
  canOpenRestoredSession: boolean
  /** The tab's demo is running, or on its way up. */
  isDemoActive: boolean
}): ViewerLandingAction {
  if (input.query.preview === 'true') {
    return input.isDemoActive ? { kind: 'join-demo' } : { kind: 'manual' }
  }

  if (
    input.query.autoload !== 'false'
    && input.restoredEndpointUrl
    && input.canOpenRestoredSession
    && !resolveInspectorMountBase(input.restoredEndpointUrl)
  ) {
    return {
      kind: 'open-session',
      path: resolveViewerLandingPath(input.query)
    }
  }

  return { kind: 'manual' }
}
