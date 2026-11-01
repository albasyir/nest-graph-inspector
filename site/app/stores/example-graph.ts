import type { GraphOutput } from 'nest-graph-inspector'
import { defineStore } from 'pinia'
import {
  EXAMPLE_GRAPH_SOURCE,
  resolveExampleGraphUrl,
  type ExampleGraphStatus
} from '~/utils/demo-graph-preview'
import { readGraphFileText } from '~/utils/graph-file'
import { describeFailedRequest, readStatusCode } from '~/utils/http-error'

/**
 * The demo application's static graph: `nodepod-demo/graph.json`, which the
 * demo's build exports with `nest-graph-inspector export` and the site
 * publishes beside the demo's payload.
 *
 * The landing page's previews draw it without booting anything, and
 * `/view?preview=true` opens it in the viewer as a graph file. It is fetched
 * from the site itself, at most once per document, and checked like any graph
 * file a visitor opens.
 */
export const useExampleGraphStore = defineStore('example-graph', () => {
  const config = useRuntimeConfig()

  const status = ref<ExampleGraphStatus>('idle')
  const graph = shallowRef<GraphOutput | null>(null)
  /** Why the graph could not be loaded, in a sentence. */
  const errorMessage = ref('')
  let loading: Promise<GraphOutput | null> | undefined

  /**
   * The static graph, fetched on first use. Every caller in the document
   * shares one request, and one that failed is tried again on the next call.
   */
  function load(): Promise<GraphOutput | null> {
    if (graph.value) {
      return Promise.resolve(graph.value)
    }

    loading ??= fetchGraph().finally(() => {
      loading = undefined
    })

    return loading
  }

  async function fetchGraph(): Promise<GraphOutput | null> {
    status.value = 'loading'
    errorMessage.value = ''

    try {
      const url = resolveExampleGraphUrl(config.app.baseURL || '/', window.location.origin)
      const text = await $fetch<string>(url, { responseType: 'text' })
      const result = readGraphFileText(text, EXAMPLE_GRAPH_SOURCE.name)

      if (!result.ok) {
        status.value = 'error'
        errorMessage.value = result.message
        return null
      }

      graph.value = result.graph
      status.value = 'ready'
      return result.graph
    } catch (error) {
      const statusCode = readStatusCode(error)

      status.value = 'error'
      errorMessage.value = statusCode === 404
        ? 'The example graph is not published on this site (HTTP 404). Build it with "pnpm --filter nest-graph-inspector-demo run build:graph".'
        : describeFailedRequest('The example graph could not be loaded', statusCode)
      return null
    }
  }

  return { status, graph, errorMessage, load }
})
