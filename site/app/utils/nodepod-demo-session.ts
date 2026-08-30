import { resolveInspectorMountBase } from './nodepod-demo-endpoint.ts'

/**
 * What a viewer page has to do before it can load the endpoint it was given.
 *
 * - `pass-through` — somebody's own application, reached over the network.
 * - `reuse` — the demo, answered by a pod this document is still running.
 * - `start` — the demo, with no pod behind it: a reload, a restored tab.
 * - `restart` — the demo, with a pod whose token is no longer accepted.
 */
export type DemoSessionAction = 'pass-through' | 'reuse' | 'start' | 'restart'

/**
 * Decides how a restored session can be made usable again.
 *
 * The demo's endpoint is answered by the fetch bridge of the tab that started
 * it, so its address says nothing about whether it can still be reached. The
 * two ways it stops being reachable look alike from the viewer — a document
 * that no longer has a pod, and a pod whose token the endpoint has begun
 * refusing once it expired — but they are not fixed the same way: the second
 * one has a running application that has to be replaced rather than joined,
 * because only a fresh boot mints a token the endpoint will accept.
 */
export function resolveDemoSessionAction(session: {
  endpointUrl: string
  isDemoRunning: boolean
  endpointRefusedToken: boolean
}): DemoSessionAction {
  if (!resolveInspectorMountBase(session.endpointUrl)) {
    return 'pass-through'
  }

  if (!session.isDemoRunning) {
    return 'start'
  }

  return session.endpointRefusedToken ? 'restart' : 'reuse'
}
