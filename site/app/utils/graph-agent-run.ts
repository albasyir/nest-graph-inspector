/**
 * The ReAct loop: a model that looks things up in the graph instead of reading
 * all of it.
 *
 * The plain chat path puts an excerpt of the graph Markdown in the system
 * prompt and hopes the answer is inside it. On anything larger than a demo it
 * is not — every curated model holds 4096 tokens, so a real application's graph
 * arrives truncated and the model answers about the half it was shown. An agent
 * inverts that: the prompt carries almost no graph at all, and the model asks
 * `find_provider` or `trace_dependencies` for the part it actually needs.
 *
 * Everything here is deliberately reachable from a plain node script — the
 * engine arrives as a `WebLlmStreamer`, so a fake one exercises the whole loop
 * without a browser, a GPU or a downloaded model. `useGraphAgent` is the thin
 * Vue layer over this; the reason the split exists is that the site's test
 * runner only picks up `app/utils/*.test.ts`.
 *
 * Both heavy imports are dynamic. `langchain` and `ChatWebLlm` (which statically
 * imports `@langchain/core`) must stay out of the prerendered server bundle,
 * for the same reason `@mlc-ai/web-llm` does.
 */

import type { GraphOutput } from 'nest-graph-inspector'
import { createGraphAgentTools, listModules } from './graph-agent-tools.ts'
import type { WebLlmStreamer } from './web-llm-boundary.ts'
import { WEB_LLM_PROMPT_CHAR_BUDGET } from './web-llm-context.ts'

/**
 * How many times the model may be asked before the loop gives up.
 *
 * Six is two or three lookups plus an answer, with room for one wrong turn. A
 * 1.7B model will sometimes call the same tool over and over — constrained
 * decoding fixes the shape of a call, never the judgement behind it — and
 * without a cap that is a browser tab pinned to the GPU until someone closes
 * it. Low enough to fail fast, high enough that a genuine three-hop question
 * still lands.
 */
export const DEFAULT_GRAPH_AGENT_MAX_STEPS = 6

/**
 * How many module names the system prompt names outright.
 *
 * Enough that the model can call `describe_module` on the right thing without
 * spending its first turn on `list_modules`, small enough that a large
 * application does not eat the window before the conversation starts. Past
 * this, the prompt says to call `list_modules` instead of listing a hundred
 * names badly.
 */
const SYSTEM_PROMPT_MODULE_NAME_LIMIT = 25

/**
 * What the six tool schemas cost in the system prompt, in characters.
 *
 * Measured rather than guessed, and pinned by a test that builds the real
 * schemas and fails if they outgrow it. It cannot be computed where it is
 * needed: the panel budgets its history before the run starts, and the only
 * code that can produce the number statically imports `@langchain/core`, which
 * has to stay out of the prerendered bundle. A constant checked against the
 * real thing is the honest version of that trade.
 */
export const GRAPH_AGENT_TOOL_PROMPT_CHARS = 3400

/**
 * What one round of the loop adds to the prompt on top of the fixed part.
 *
 * A round is the assistant turn that made the call, replayed as a
 * `<tool_call>` block, plus the result that answered it. `describe_module` on a
 * wide module is the expensive case — forty provider names and forty importers
 * — so this is sized for that rather than for the demo graph.
 */
const AGENT_ROUND_RESERVE_CHARS = 1800

/**
 * What the fixed part of an agent prompt costs before any conversation.
 *
 * The panel subtracts this from the window before it decides how much history
 * fits. Reserving for the schemas and the system prompt alone was not enough:
 * the loop's own traffic — a replayed call and a full lookup on every round —
 * is charged to the same 4096 tokens, and unreserved it is what pushes a long
 * run past the window and into a refusal the user cannot act on.
 */
export function estimateGraphAgentPromptChars(graph: GraphOutput | null | undefined): number {
  return GRAPH_AGENT_TOOL_PROMPT_CHARS
    + buildGraphAgentSystemPrompt(graph).length
    + AGENT_ROUND_RESERVE_CHARS
}

/** One turn of the conversation as the panel keeps it. */
export type GraphAgentTurn = {
  role: 'user' | 'assistant'
  content: string
}

/**
 * What the loop reports as it runs.
 *
 * `answer` carries the *whole* text of the current model turn rather than the
 * newest fragment, because a turn's text is re-parsed from the start on every
 * delta — `<think>` blocks are recovered by parsing, not by counting — and
 * because a fresh turn after a tool result has to replace the previous one
 * rather than append to it.
 */
export type GraphAgentEvent
  = | { type: 'answer', text: string }
    | { type: 'tool-call', id: string, name: string, args: string }
    | { type: 'tool-result', id: string, name: string, text: string }
    | { type: 'stopped', text: string }

export type GraphAgentRequest = {
  engine: WebLlmStreamer
  modelId: string
  /** The graph the tools answer about. Tools close over it, so a reload needs a new run. */
  graph: GraphOutput | null | undefined
  /** The conversation so far, ending with the question being asked. */
  messages: readonly GraphAgentTurn[]
  temperature?: number
  enableThinking?: boolean
  maxSteps?: number
  signal?: AbortSignal
}

export type GraphAgentResult = {
  /** The text of the last model turn, which is the answer unless the loop was cut short. */
  text: string
  toolCallCount: number
  /** True when the loop was stopped by the step cap rather than by the model finishing. */
  stoppedAtLimit: boolean
}

/**
 * The system prompt for a turn that has tools.
 *
 * Short on purpose. The tool schemas are injected on top of this by
 * `ChatWebLlm` and already cost around 270 tokens, and every tool result lands
 * in the same 4096-token window — so the graph itself stays out of the prompt
 * entirely. That is the trade the agent exists to make: the model reads less
 * up front and asks for what it needs.
 *
 * The module names are the one exception. Naming them saves the first turn,
 * which on a small model is the turn most likely to go wrong, and they are the
 * vocabulary every other tool takes as an argument.
 */
export function buildGraphAgentSystemPrompt(
  graph: GraphOutput | null | undefined,
  moduleNameLimit = SYSTEM_PROMPT_MODULE_NAME_LIMIT
): string {
  const modules = listModules(graph)
  const lines = [
    'You answer questions about a NestJS dependency graph.',
    '',
    'Look the answer up with the tools before you answer. Never guess a module, provider or controller name, and never describe a relationship no tool reported — say what is missing instead.',
    'Answer in short GitHub-flavored Markdown, naming the exact names the tools returned.',
    'When a tool has already given you the answer, write it out. Do not call the same tool twice with the same arguments.'
  ]

  if (!modules.length) {
    lines.push('', 'No graph has loaded yet, so the tools have nothing to report. Say so rather than answering from memory.')

    return lines.join('\n')
  }

  lines.push(
    '',
    modules.length <= moduleNameLimit
      ? `The ${modules.length} modules in this application are: ${modules.join(', ')}.`
      : `This application has ${modules.length} modules, too many to list here — call list_modules to see them.`
  )

  return lines.join('\n')
}

/**
 * The transcript a round of the loop is allowed to carry.
 *
 * Nothing in LangGraph trims what the agent accumulates: every round appends
 * the assistant turn that made the call and the result that answered it, and
 * `createAgent` sends the whole of `state.messages` every time. On a graph big
 * enough to want agent mode, four rounds of `describe_module` is already more
 * than the 4096-token window holds, and web-llm refuses an over-long prompt
 * rather than trimming it — so the run dies mid-question with an error about a
 * conversation the user did not have.
 *
 * Whole rounds go, oldest first, rather than the newest result being shortened.
 * A result the model has already read and narrated is the cheapest thing to
 * lose; the one it just asked for is the reason the round happened. The last
 * round always stays for that reason, even if it alone is over budget — the
 * model refusing a long prompt is a better failure than the model being asked
 * to answer from a lookup that was deleted.
 */
export function budgetAgentTranscript<TMessage extends TranscriptMessage>(
  messages: readonly TMessage[],
  budgetChars: number
): TMessage[] {
  let kept = [...messages]

  for (;;) {
    if (measureTranscript(kept) <= budgetChars) {
      return kept
    }

    const rounds = findToolRounds(kept)
    const oldest = rounds.length > 1 ? rounds[0] : undefined

    if (!oldest) {
      return kept
    }

    kept = kept.filter((_, index) => !oldest.has(index))
  }
}

/** Roughly what a turn's role markers and separators add on top of its text. */
const TRANSCRIPT_MESSAGE_OVERHEAD_CHARS = 8

function measureTranscript(messages: readonly TranscriptMessage[]): number {
  return messages.reduce((total, message) => {
    // The calls count too: they are replayed to the model as `<tool_call>`
    // blocks, so an assistant turn with no text of its own is not free.
    const calls = message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0

    return total + readContentText(message.content).length + calls + TRANSCRIPT_MESSAGE_OVERHEAD_CHARS
  }, 0)
}

/**
 * The index of each assistant turn that called tools, together with the results
 * that answered it.
 *
 * The results are the `tool` messages immediately after the call, which is how
 * the agent's tool node appends them. Pairing by position rather than by
 * `tool_call_id` is deliberate: `ChatWebLlm` mints its ids per stream, so a
 * loop that calls one tool every round produces `webllm_call_0` every time, and
 * matching on the id would rake in every round at once.
 */
function findToolRounds(messages: readonly TranscriptMessage[]): Set<number>[] {
  const rounds: Set<number>[] = []

  messages.forEach((message, index) => {
    if (message.getType() !== 'ai' || !message.tool_calls?.length) {
      return
    }

    const round = new Set([index])

    for (let after = index + 1; after < messages.length; after += 1) {
      if (messages[after]?.getType() !== 'tool') {
        break
      }

      round.add(after)
    }

    rounds.push(round)
  })

  return rounds
}

/**
 * Runs the loop, reporting each step, and answers with the last thing the model
 * said.
 *
 * `onEvent` is called synchronously as the stream is read, so a caller that
 * throws from it — which is how the panel abandons a model that thinks without
 * ever answering — stops the run. The run is cancelled before the throw
 * reaches the caller, so the graph is not still issuing generations at the same
 * engine when the caller starts its retry.
 */
export async function runGraphAgent(
  request: GraphAgentRequest,
  onEvent: (event: GraphAgentEvent) => void
): Promise<GraphAgentResult> {
  const maxSteps = Math.max(1, request.maxSteps ?? DEFAULT_GRAPH_AGENT_MAX_STEPS)

  const [{ createAgent, createMiddleware }, { ChatWebLlm }, tools] = await Promise.all([
    import('langchain/browser'),
    import('./web-llm-langchain.ts'),
    createGraphAgentTools(request.graph)
  ])

  const model = new ChatWebLlm({
    engine: request.engine,
    model: request.modelId,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.enableThinking === undefined ? {} : { enableThinking: request.enableThinking })
  })

  const systemPrompt = buildGraphAgentSystemPrompt(request.graph)
  // What is left of the window once the fixed part of the prompt is paid for.
  const transcriptBudget = Math.max(
    0,
    WEB_LLM_PROMPT_CHAR_BUDGET - GRAPH_AGENT_TOOL_PROMPT_CHARS - systemPrompt.length
  )

  const agent = createAgent({
    model,
    tools,
    systemPrompt,
    middleware: [createMiddleware({
      name: 'GraphAgentTranscriptBudget',
      wrapModelCall: (modelRequest, handler) => handler({
        ...modelRequest,
        messages: budgetAgentTranscript(modelRequest.messages, transcriptBudget)
      })
    })]
  })

  const seenToolCalls = new Set<string>()
  const seenToolResults = new Set<string>()
  // The key a result is reported under, looked up by the id the model gave the
  // call. Overwritten each round, which is what makes a repeated id pair with
  // the round it belongs to rather than the first one that ever used it.
  const callKeysByToolCallId = new Map<string, string>()
  let toolCallCount = 0
  let turnId = ''
  let turnText = ''

  function readTurn(message: StreamMessage): void {
    // Tool results travel in this mode too, and appending one to the answer
    // would print the raw lookup into the reply. Only what the model itself
    // wrote counts as the answer.
    if (message.getType() !== 'ai') {
      return
    }

    const text = readContentText(message.content)

    if (!text) {
      return
    }

    // A turn is identified by the id LangChain stamps on every chunk of one
    // generation. Without it, the answer written after a tool result would be
    // appended to the answer written before it, and the panel would render one
    // reply that contradicts itself halfway through.
    const id = typeof message.id === 'string' ? message.id : ''

    if (id !== turnId) {
      turnId = id
      turnText = ''
    }

    turnText += text
    onEvent({ type: 'answer', text: turnText })
  }

  /**
   * Both sets are keyed by the message the call or the result arrived on, not by
   * the tool-call id alone.
   *
   * `ChatWebLlm` mints its ids per stream — a model that calls one tool on every
   * turn produces `webllm_call_0` every time — because web-llm's prompt builder
   * discards the id and there is nothing to be unique against. Harmless there,
   * fatal here: keying on the id alone would collapse a loop of six identical
   * calls into one, which is precisely the loop the step cap exists to show.
   */
  function readUpdate(message: StreamMessage): void {
    const messageId = typeof message.id === 'string' ? message.id : ''

    for (const toolCall of message.tool_calls ?? []) {
      const id = toolCall.id ?? toolCall.name
      const key = `${messageId}:${id}`

      if (seenToolCalls.has(key)) {
        continue
      }

      seenToolCalls.add(key)
      callKeysByToolCallId.set(id, key)
      toolCallCount += 1
      onEvent({ type: 'tool-call', id: key, name: toolCall.name, args: describeToolArgs(toolCall.args) })
    }

    if (message.getType() !== 'tool') {
      return
    }

    if (seenToolResults.has(messageId)) {
      return
    }

    seenToolResults.add(messageId)

    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''

    onEvent({
      type: 'tool-result',
      // Reported under the key its call was reported under, so the panel can
      // fill in the step it already drew rather than drawing a second one.
      id: callKeysByToolCallId.get(toolCallId) ?? toolCallId,
      name: typeof message.name === 'string' ? message.name : 'tool',
      text: readContentText(message.content)
    })
  }

  try {
    // Both modes, because they answer different questions. `messages` is the
    // only one that carries tokens as they decode; `updates` is the only one
    // that carries a *settled* message, with its tool-call fragments already
    // folded into whole calls. Reading calls off the streaming chunks instead
    // would mean re-implementing that fold here.
    const stream = await agent.stream(
      { messages: request.messages.map(turn => ({ role: turn.role, content: turn.content })) },
      {
        streamMode: ['updates', 'messages'],
        // One step is one node, and a round trip is two of them — the model and
        // then the tools — with a final model call to write the answer. The
        // second `+ 1` is LangGraph's own: one tick is always spent discovering
        // the graph has nothing left to do, so the usable node budget is one
        // less than the limit. Without it `maxSteps` lookups aborted the run on
        // the very call that would have written the answer, and the panel put a
        // notice saying no answer was reached under the answer it had just
        // finished rendering.
        recursionLimit: maxSteps * 2 + 2,
        ...(request.signal ? { signal: request.signal } : {})
      }
    )

    try {
      for await (const chunk of stream) {
        const event = readStreamChunk(chunk)

        if (event?.mode === 'messages') {
          readTurn(event.message)
        } else if (event?.mode === 'updates') {
          for (const message of event.messages) {
            readUpdate(message)
          }
        }
      }
    } catch (cause) {
      // Leaving the loop by a throw — which is how the panel abandons a model
      // that thinks without answering — only closes the iterator on this side.
      // LangGraph's stream aborts its run from `cancel` and from nowhere else,
      // and the async-iterator return path does not reach it, so the graph
      // would keep issuing generations at the same engine behind the retry that
      // was meant to replace it. Cancelling is what stops the run.
      await stream.cancel().catch(() => {
        // Already finished or already cancelled; either way there is nothing
        // left to stop, and the original failure is the one worth reporting.
      })

      throw cause
    }
  } catch (cause) {
    if (!isRecursionLimit(cause)) {
      throw cause
    }

    // Not an error to report as one: the model was working, it just never
    // stopped. Saying how many lookups it made and what to do differently is
    // more use than a stack trace, and whatever it managed to write is kept.
    const text = `I stopped after ${toolCallCount} tool ${toolCallCount === 1 ? 'call' : 'calls'} without reaching an answer. Small models sometimes loop between lookups — try naming one module or provider in the question, or switch to a larger model.`

    onEvent({ type: 'stopped', text })

    return { text: turnText, toolCallCount, stoppedAtLimit: true }
  }

  return { text: turnText, toolCallCount, stoppedAtLimit: false }
}

/**
 * The shape read off a LangGraph stream.
 *
 * Structural and minimal because this is a boundary: what arrives is whatever
 * the installed LangGraph decided to yield, so it is taken as `unknown` and
 * narrowed down to the four fields that are actually read.
 */
type StreamMessage = TranscriptMessage & {
  id?: unknown
  name?: unknown
  tool_call_id?: unknown
}

/**
 * The part of a LangChain message the transcript budget reads.
 *
 * Structural rather than `BaseMessage`, so the budget can be exercised from a
 * plain assertion script with object literals, and so this module keeps its
 * only `@langchain/core` reference behind the dynamic import.
 */
export type TranscriptMessage = {
  getType: () => string
  content: unknown
  tool_calls?: { id?: string, name: string, args?: unknown }[]
}

type StreamEvent
  = | { mode: 'messages', message: StreamMessage }
    | { mode: 'updates', messages: StreamMessage[] }

function isStreamMessage(value: unknown): value is StreamMessage {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { getType?: unknown }).getType === 'function'
}

/**
 * One chunk of `agent.stream`, as one of the two things it can be.
 *
 * With several stream modes asked for, LangGraph yields `[mode, payload]`
 * tuples. The `updates` payload is keyed by node name — `model_request`,
 * `tools` — but the names are read straight past rather than matched, because a
 * message says what it is and a node name is LangGraph's to rename.
 */
function readStreamChunk(chunk: unknown): StreamEvent | undefined {
  if (!Array.isArray(chunk) || chunk.length < 2) {
    return undefined
  }

  const [mode, payload] = chunk

  if (mode === 'messages') {
    // `[message, metadata]`; the metadata says which node produced it, which
    // nothing here needs.
    const message = Array.isArray(payload) ? payload[0] : undefined

    return isStreamMessage(message) ? { mode: 'messages', message } : undefined
  }

  if (mode !== 'updates' || typeof payload !== 'object' || payload === null) {
    return undefined
  }

  const messages = Object.values(payload as Record<string, unknown>).flatMap((update) => {
    if (typeof update !== 'object' || update === null) {
      return []
    }

    const candidates = (update as { messages?: unknown }).messages

    return Array.isArray(candidates) ? candidates.filter(isStreamMessage) : []
  })

  return { mode: 'updates', messages }
}

/**
 * Message content as text.
 *
 * LangChain v1 hands content over as a string on some paths and as a list of
 * typed blocks on others, and both reach here — the model's own chunks are
 * strings, a tool result can be either.
 */
function readContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) {
        return ''
      }

      const record = block as Record<string, unknown>

      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

/** A call's arguments as one short line, for a transcript that shows the step. */
function describeToolArgs(args: unknown): string {
  if (args === undefined || args === null) {
    return ''
  }

  try {
    const encoded = JSON.stringify(args)

    // `{}` is what a no-argument tool leaves, and rendering it says nothing a
    // reader did not already know from the tool's name.
    return !encoded || encoded === '{}' ? '' : encoded
  } catch {
    return ''
  }
}

/**
 * Whether a rejection is LangGraph refusing to take another step.
 *
 * Matched by name rather than by `instanceof`: `GraphRecursionError` lives in
 * `@langchain/langgraph`, which is a transitive dependency here, and importing
 * it directly would pin a package nothing else in the site names.
 */
function isRecursionLimit(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'GraphRecursionError'
}
