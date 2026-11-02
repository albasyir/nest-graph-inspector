import { isDemoEndpoint } from './nodepod-demo-endpoint.ts'

/**
 * What a viewer page has to do before it can load the endpoint it was given.
 *
 * - `pass-through` — somebody's own application, reached over the network:
 *   any endpoint but the demo's, whatever its path.
 * - `reuse` — the demo, answered by a pod this document is running.
 * - `join` — the demo, answered once the start already in flight in this
 *   document comes up.
 * - `release` — the demo, with no pod behind it: a reload, a restored tab.
 * - `stop` — the demo, with a pod whose token is no longer accepted.
 */
export type DemoSessionAction = 'pass-through' | 'reuse' | 'join' | 'release' | 'stop'

/**
 * Decides whether a restored session can still be shown.
 *
 * The demo's endpoint is answered by the fetch bridge of the tab that started
 * it, so its address says nothing about whether it can still be reached. A
 * viewer page never starts the demo to make it reachable again — only "Load
 * Example" starts it, when the visitor asks — so a session is only kept when
 * this document is running the demo, or starting it, already. The two ways a session dies look alike from the viewer, a document
 * that no longer has a pod and a pod whose token the endpoint has begun
 * refusing once it expired, but the second leaves an application running that
 * has to be stopped: `/view` would otherwise join it and hand back the
 * credential that was just refused, where a fresh start mints one the endpoint
 * accepts.
 */
export function resolveDemoSessionAction(session: {
  endpointUrl: string
  /** The viewer's own origin, the only one the demo is served from. */
  viewerOrigin: string
  isDemoRunning: boolean
  isDemoStarting: boolean
  endpointRefusedToken: boolean
}): DemoSessionAction {
  if (!isDemoEndpoint(session.endpointUrl, session.viewerOrigin)) {
    return 'pass-through'
  }

  // The pod coming up mints its own token, so whatever the old one was told
  // has nothing to do with it.
  if (session.isDemoStarting) {
    return 'join'
  }

  if (!session.isDemoRunning) {
    return 'release'
  }

  return session.endpointRefusedToken ? 'stop' : 'reuse'
}
