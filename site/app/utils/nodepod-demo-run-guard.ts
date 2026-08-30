/**
 * Tells a startup of the in-browser demo whether it is still the one being
 * waited on.
 *
 * Starting the demo is a chain of awaits — a manifest, a bundle, a runtime
 * boot, a spawn, a wait for the printed viewer link — and any of them can be
 * outlived by the visitor stopping or restarting the demo. The store behind
 * that startup is shared, so a run that resumes after being superseded would
 * otherwise publish its pod, its endpoint and its access token over the ones
 * that replaced them, and leave the newer pod running with nothing pointing
 * at it.
 *
 * A run claims a checker before its first await and consults it after every
 * one; whatever supersedes the run makes that checker report `false` for good.
 */
export type NodepodDemoRunGuard = {
  /**
   * Retires every checker handed out so far. Called wherever the running
   * application is torn down, which is what makes the runs before it stale.
   */
  supersede: () => void
  /**
   * Hands out a checker for the run that is current now. It answers `true`
   * until the next {@link NodepodDemoRunGuard.supersede}, and `false` from
   * then on — including for a run that never got as far as booting.
   */
  claim: () => () => boolean
}

/**
 * Creates a guard whose first claim is already current: a store that has never
 * started the demo has nothing to supersede.
 */
export function createNodepodDemoRunGuard(): NodepodDemoRunGuard {
  let generation = 0

  return {
    supersede() {
      generation += 1
    },
    claim() {
      const claimed = generation

      return () => claimed === generation
    }
  }
}
