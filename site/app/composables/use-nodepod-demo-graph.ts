import { useDocumentVisibility, useIntersectionObserver } from '@vueuse/core'
import type { GraphOutput } from 'nest-graph-inspector'

/**
 * How long to wait for the intersection observer to report anything at all.
 *
 * An observer reports its target as soon as it is observed, visible or not, so
 * silence means the environment never ran it, and waiting on it would leave a
 * skeleton in place forever.
 */
const OBSERVER_GRACE_MS = 2500

/**
 * Whether the visitor asked the browser to spend less data. Downloading and
 * booting an application is exactly what they are asking to avoid, so the demo
 * waits to be asked for instead.
 */
function prefersReducedData() {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean }
  }).connection

  return connection?.saveData === true
}

/**
 * Runs the demo application inside the browser and hands back the graph it
 * reports about itself.
 *
 * The application is started the first time the element this returns comes
 * into view, so a page full of previews pays for one boot, and only once
 * someone looks at it.
 */
export function useNodepodDemoGraph() {
  const demo = useNodepodDemoStore()
  const previewRef = ref<HTMLElement | null>(null)
  const needsManualStart = ref(false)
  const observerReported = ref(false)
  const graceElapsed = ref(false)
  const documentVisibility = useDocumentVisibility()

  function load() {
    if (prefersReducedData() && demo.status === 'idle') {
      needsManualStart.value = true
      return
    }

    needsManualStart.value = false
    void demo.loadGraphOutput()
  }

  const { stop } = useIntersectionObserver(previewRef, (entries) => {
    observerReported.value = true

    if (entries.some(entry => entry.isIntersecting)) {
      stop()
      load()
    }
  })

  onMounted(() => {
    setTimeout(() => {
      graceElapsed.value = true
    }, OBSERVER_GRACE_MS)
  })

  /**
   * Falls back to starting without an observer, but not in a document nobody
   * is looking at — a page opened in a background tab should not spend the
   * visitor's data before they get to it. A document with no layout at all is
   * the exception: it can never report visibility or intersection, and it is
   * the reason this fallback exists.
   */
  watch([graceElapsed, documentVisibility], () => {
    if (observerReported.value || !graceElapsed.value) {
      return
    }

    if (documentVisibility.value === 'visible' || window.innerHeight === 0) {
      stop()
      load()
    }
  })

  const graph = computed<GraphOutput | null>(() => demo.graphOutput)
  const isReady = computed(() => Boolean(graph.value))
  const isFailed = computed(() => demo.status === 'error')

  function start() {
    needsManualStart.value = false
    void demo.loadGraphOutput()
  }

  function retry() {
    demo.stop()
    start()
  }

  return {
    demo,
    previewRef,
    graph,
    isReady,
    isFailed,
    needsManualStart,
    statusLabel: computed(() => demo.statusLabel),
    start,
    retry
  }
}
