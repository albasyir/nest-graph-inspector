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
  const snapshotByNodeId = ref<Record<string, DirectRunExecutionSnapshot>>({})
  const pendingByNodeId = ref<Record<string, DirectRunPendingCall>>({})
  const runErrorByNodeId = ref<Record<string, string>>({})
  const argsInputByKey = ref<Record<string, string>>({})
  const argsErrorByKey = ref<Record<string, string>>({})
  const argsInvalidByKey = ref<Record<string, boolean>>({})
  const generation = ref(0)

  /**
   * Forgets every record, for an owner whose tab moved to another graph: a
   * node id there can name another class, which must not show the last run of
   * this one. A call still on its way is forgotten with them.
   */
  function clear(): void {
    generation.value += 1
    snapshotByNodeId.value = {}
    pendingByNodeId.value = {}
    runErrorByNodeId.value = {}
    argsInputByKey.value = {}
    argsErrorByKey.value = {}
    argsInvalidByKey.value = {}
  }

  return {
    snapshotByNodeId,
    pendingByNodeId,
    runErrorByNodeId,
    argsInputByKey,
    argsErrorByKey,
    argsInvalidByKey,
    /**
     * How many times the records were cleared. A call notes it as it starts
     * and records what it brings back only if it has not moved since.
     */
    generation: readonly(generation),
    clear
  }
}

export type DirectRunRecords = ReturnType<typeof useDirectRunRecords>
