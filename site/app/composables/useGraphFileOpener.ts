import type { GraphOutput } from 'nest-graph-inspector'
import { EXAMPLE_GRAPH_SOURCE } from '~/utils/demo-graph-preview'
import {
  checkGraphFileSize,
  readGraphFileText,
  type GraphFileFailure,
  type GraphFileResult
} from '~/utils/graph-file'
import type { GraphFileSource } from '~/utils/graph-file-session'

type OpenOptions = {
  /**
   * Runs once the graph is known to be good, just before it replaces the one
   * on screen, and says whether to go ahead: `false` abandons it, because the
   * caller moved on meanwhile. A file that fails never gets this far, so
   * whatever the caller was waiting on — a demo starting, the example
   * loading — carries on.
   */
  beforeOpen?: () => boolean
}

/**
 * Opens a graph file in the viewer: one the visitor picks or drops, or the
 * demo's static graph.
 *
 * A visitor's file is read with `File.text()`, checked by `graph-file.ts`, and
 * handed to the store, and that is all: it is never uploaded, nothing is
 * fetched on its behalf, and the demo is not started. Analytics hear that a
 * file opened, or which kind of problem kept it shut — never its name, and
 * never a word of what it holds.
 */
export function useGraphFileOpener() {
  const graphStore = useGraphInspectorStore()
  const exampleGraph = useExampleGraphStore()
  const posthog = usePostHog()

  /**
   * Why the last file did not open, in words the visitor can act on. Shared by
   * every opener in the document: one the viewer's header starts sends the
   * visitor to `/view`, which shows it under the drop zone.
   */
  const error = useState('graph-file-open-error', () => '')
  /** A file is being read. */
  const isReading = ref(false)

  /**
   * Reads a file the visitor chose and, when it is a graph the viewer can
   * draw, opens it on the navigator. Resolves to whether it opened.
   */
  async function openFile(file: File, options: OpenOptions = {}): Promise<boolean> {
    error.value = ''

    const tooLarge = checkGraphFileSize(file.name, file.size)
    if (tooLarge) {
      return reject(tooLarge)
    }

    isReading.value = true

    let result: GraphFileResult
    try {
      result = readGraphFileText(await file.text(), file.name)
    } catch {
      result = {
        ok: false,
        problem: 'unreadable',
        message: `${file.name} could not be read. Check that the file is still there, and open it again.`
      }
    } finally {
      isReading.value = false
    }

    if (!result.ok) {
      return reject(result)
    }

    return await open(result.graph, {
      name: file.name,
      kind: 'file',
      ...(result.notice ? { notice: result.notice } : {})
    }, options)
  }

  /**
   * Opens the first file a drop carries. A drop with no file in it — text, a
   * link — says so rather than doing nothing.
   */
  async function openDrop(
    transfer: DataTransfer | null,
    options: OpenOptions = {}
  ): Promise<boolean> {
    const file = transfer?.files?.[0]

    if (!file) {
      error.value = 'Drop a graph file, the .json that nest-graph-inspector export writes.'
      return false
    }

    return await openFile(file, options)
  }

  /**
   * Opens the demo's static graph as a graph file: what a preview that has
   * not loaded the example draws. Nothing is booted.
   */
  async function openExample(options: OpenOptions = {}): Promise<boolean> {
    error.value = ''

    const graph = await exampleGraph.load()
    if (!graph) {
      error.value = exampleGraph.errorMessage
      return false
    }

    return await open(graph, EXAMPLE_GRAPH_SOURCE, options)
  }

  async function open(
    graph: GraphOutput,
    source: GraphFileSource,
    options: OpenOptions
  ): Promise<boolean> {
    if (options.beforeOpen && !options.beforeOpen()) {
      return false
    }

    if (source.kind === 'file') {
      posthog?.capture('graph_file_opened', { graph_source: 'file' })
    }

    graphStore.openGraphFile(graph, source)
    await navigateTo('/view/navigator', { replace: true })

    return true
  }

  function reject(result: GraphFileFailure): false {
    error.value = result.message
    posthog?.capture('graph_file_rejected', { problem: result.problem })

    return false
  }

  /** Forgets the last error: the visitor is trying something else. */
  function clearError() {
    error.value = ''
  }

  return { error, isReading, openFile, openDrop, openExample, clearError }
}
