import type { GraphOutput } from 'nest-graph-inspector'
import {
  resolveDemoPreviewMountAction,
  resolveDemoPreviewView
} from '~/utils/demo-graph-preview'

/**
 * The demo application's graph, as the site's previews draw it.
 *
 * A preview draws the demo's static graph — `nodepod-demo/graph.json`, which
 * the demo's build exports with `nest-graph-inspector export` — and boots
 * nothing to do it: opening a page downloads no application and starts no
 * runtime. "Load Example" starts the demo itself in this tab, exactly as it
 * always started, and from then on every preview draws the live graph the
 * running demo reports about itself. One pod serves every preview on the page.
 */
export function useNodepodDemoGraph() {
  const demo = useNodepodDemoStore()
  const example = useExampleGraphStore()

  /** What the preview shows: which graph, or what stands in for one. */
  const view = computed(() => resolveDemoPreviewView({
    hasLiveGraph: Boolean(demo.graphOutput),
    hasExampleGraph: Boolean(example.graph),
    exampleStatus: example.status,
    demoStatus: demo.status
  }))

  const graph = computed<GraphOutput | null>(() => {
    switch (view.value.source) {
      case 'live':
        return demo.graphOutput
      case 'static':
        return example.graph
      default:
        return null
    }
  })

  /** Starts the demo in this tab — the visitor's "Load Example". */
  function loadExample() {
    void demo.loadGraphOutput()
  }

  /** Boots the demo again from nothing after a failure. */
  function retryExample() {
    demo.stop()
    loadExample()
  }

  /** Fetches the static graph again, after it failed to load. */
  function reloadStaticGraph() {
    void example.load()
  }

  // Only the mount fetches anything — never server rendering — so the
  // surrounding text renders without waiting on it.
  if (import.meta.client) {
    onMounted(() => {
      if (resolveDemoPreviewMountAction(example.status) === 'load-example-graph') {
        void example.load()
      }

      // A demo this tab is already running — loaded from `/view`, or by
      // another preview — is drawn live. Reading its graph boots nothing.
      watch(
        () => demo.isRunning && !demo.graphOutput,
        (needsLiveGraph) => {
          if (needsLiveGraph) {
            void demo.loadGraphOutput()
          }
        },
        { immediate: true }
      )
    })
  }

  return {
    demo,
    view,
    graph,
    /** Why the static graph could not be loaded. */
    staticGraphError: computed(() => example.errorMessage),
    /** What the live demo is doing, or why it failed. */
    statusLabel: computed(() => demo.statusLabel),
    loadExample,
    retryExample,
    reloadStaticGraph
  }
}
