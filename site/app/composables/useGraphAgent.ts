import type { GraphOutput } from 'nest-graph-inspector'
import type { GraphAgentEvent, GraphAgentResult, GraphAgentTurn } from '~/utils/graph-agent-run'
import type { WebLlmStreamer } from '~/utils/web-llm-boundary'

/**
 * The chat's agent mode, as the panel sees it.
 *
 * The whole of the ReAct loop lives in `~/utils/graph-agent-run`, which is
 * plain TypeScript over a `WebLlmStreamer` and is tested against a scripted
 * engine with no browser in sight. This composable is the Vue layer over it:
 * the `isRunning` flag the panel disables its prompt with, and the one dynamic
 * `import()` that keeps `langchain` and `@langchain/core` out of the
 * prerendered server bundle.
 *
 * Why an agent at all, when the plain path already answers: the plain path puts
 * an excerpt of the graph in the prompt, and every curated model holds 4096
 * tokens. On a real application that excerpt is most of the window and still
 * not most of the graph, so the model answers confidently about the part it
 * happened to be shown. An agent asks instead — `find_provider`,
 * `trace_dependencies`, `find_cycles` — and reads only what the question needs.
 *
 * Why it goes through LangChain rather than calling the engine directly: the
 * model is a `BaseChatModel`, so the question "which model answers this?" is a
 * constructor argument. Swapping `ChatWebLlm` for `@langchain/openai` or
 * `@langchain/anthropic` is a provider change, not a rewrite of the panel.
 */

export type GraphAgentRunOptions = {
  engine: WebLlmStreamer
  modelId: string
  graph: GraphOutput | null | undefined
  messages: readonly GraphAgentTurn[]
  temperature?: number
  enableThinking?: boolean
  maxSteps?: number
  signal?: AbortSignal
}

export function useGraphAgent() {
  const isRunning = ref(false)

  /**
   * Answers one question with tools, reporting every step as it happens.
   *
   * `onEvent` is called synchronously while the stream is read, so throwing from
   * it stops the run — which is how the panel abandons a model that thinks
   * without ever answering. The throw reaches the caller only after the engine
   * has been interrupted and the worker has released its per-model lock.
   */
  async function runAgent(
    options: GraphAgentRunOptions,
    onEvent: (event: GraphAgentEvent) => void
  ): Promise<GraphAgentResult> {
    // Dynamic for the same reason `@mlc-ai/web-llm` is: `/` is prerendered and
    // `/view` is server-rendered, so a static import would evaluate LangChain
    // where none of the browser globals it reaches for exist.
    const { runGraphAgent } = await import('~/utils/graph-agent-run')

    isRunning.value = true

    try {
      return await runGraphAgent(options, onEvent)
    } finally {
      isRunning.value = false
    }
  }

  return {
    /**
     * True for the whole loop, not just the turn that is decoding.
     *
     * A run is several generations with tool calls between them, and the
     * engine's own `isGenerating` drops to false in each of those gaps — long
     * enough for a send button to flicker back to life mid-answer.
     */
    isRunning,
    runAgent
  }
}
