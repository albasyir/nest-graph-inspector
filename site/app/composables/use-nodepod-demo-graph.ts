import type { GraphOutput } from 'nest-graph-inspector'

/**
 * Runs the demo application inside the browser and hands back the graph it
 * reports about itself.
 *
 * Nothing here starts on its own. Starting the demo means downloading an
 * application and booting a Node runtime in the visitor's tab, which is not
 * something a page should decide to do because it was scrolled past — so it
 * waits to be asked, and one pod then serves every preview on the page.
 */
export function useNodepodDemoGraph() {
  const demo = useNodepodDemoStore()

  const graph = computed<GraphOutput | null>(() => demo.graphOutput)
  const isReady = computed(() => Boolean(graph.value))
  /** Waiting to be asked: never started, or stopped by a failure. */
  const isIdle = computed(() => !isReady.value && !demo.isBusy)

  function start() {
    void demo.loadGraphOutput()
  }

  return {
    demo,
    graph,
    isReady,
    isIdle,
    statusLabel: computed(() => demo.statusLabel),
    start
  }
}
