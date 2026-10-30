import type { GraphOutput } from 'nest-graph-inspector'

export interface UseNodepodDemoGraphOptions {
  /**
   * Start the demo as soon as the component using it mounts, rather than
   * waiting for the visitor to ask. Defaults to `true`.
   */
  autoload?: boolean
}

/**
 * Runs the demo application inside the browser and hands back the graph it
 * reports about itself.
 *
 * By default it starts on its own once mounted. The NestJS runtime packages
 * arrive as a prebuilt vendor snapshot (3.05 MB gzipped) restored straight into
 * the pod instead of being installed from npm, so a page can afford to show
 * the real graph without asking first. Only the
 * mount starts it — never server rendering — so the surrounding text renders
 * without waiting on it, and a demo that already failed in this tab is not
 * started again until the visitor retries. Pass `autoload: false` to wait for
 * {@link start} instead. One pod serves every preview on the page either way.
 */
export function useNodepodDemoGraph(options: UseNodepodDemoGraphOptions = {}) {
  const { autoload = true } = options
  const demo = useNodepodDemoStore()

  const graph = computed<GraphOutput | null>(() => demo.graphOutput)
  const isReady = computed(() => Boolean(graph.value))
  /** The startup failed, or the graph could not be read from it. */
  const hasError = computed(() => demo.status === 'error')
  /** Waiting to be asked: never started, stopped, or a failure dismissed. */
  const isIdle = computed(
    () => !isReady.value && !demo.isBusy && !demo.isLoadingGraph && !hasError.value
  )

  /** Asks for the demo, booting it if this is the first preview to ask. */
  function start() {
    void demo.loadGraphOutput()
  }

  /** Boots the demo again from nothing after a failure. */
  function retry() {
    demo.stop()
    start()
  }

  if (import.meta.client && autoload) {
    onMounted(() => {
      if (!isReady.value && !demo.isBusy && demo.status !== 'error') {
        start()
      }
    })
  }

  return {
    demo,
    graph,
    isReady,
    isIdle,
    hasError,
    statusLabel: computed(() => demo.statusLabel),
    start,
    retry
  }
}
