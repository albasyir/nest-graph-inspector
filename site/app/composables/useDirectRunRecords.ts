import type { DirectRunExecutionSnapshot } from '~/utils/direct-run-provider'

/** Which of Direct Run's two actions a pending call was made with. */
export type DirectRunMode = 'run' | 'inspect'

/** A call on its way: the method, and which action made it. */
export type DirectRunPendingCall = { method: string, mode: DirectRunMode }

/**
 * What Direct Run remembers about each target while the panel showing it comes
 * and goes: the last run of each provider or controller, a call still on its
 * way, why the last one could not be made, and the arguments typed for each
 * method — with whether the editor finds them invalid, and why a Run was
 * refused.
 *
 * Kept apart from the panel because the panel does not always outlive what it
 * shows: a drawer unmounts its content as it closes, and a page can switch the
 * panel's view away. Whoever owns the panel keeps these, so reopening a target
 * shows its last run and the arguments left in its editor. Every record is
 * keyed by graph node id — or `nodeId:method` for one method's arguments — so
 * a controller and a same-named provider never share one.
 */
export function useDirectRunRecords() {
  return {
    snapshotByNodeId: ref<Record<string, DirectRunExecutionSnapshot>>({}),
    pendingByNodeId: ref<Record<string, DirectRunPendingCall>>({}),
    runErrorByNodeId: ref<Record<string, string>>({}),
    argsInputByKey: ref<Record<string, string>>({}),
    argsErrorByKey: ref<Record<string, string>>({}),
    argsInvalidByKey: ref<Record<string, boolean>>({})
  }
}

export type DirectRunRecords = ReturnType<typeof useDirectRunRecords>
