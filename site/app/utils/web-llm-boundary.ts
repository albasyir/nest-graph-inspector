/**
 * The handshake between the engine and whatever chat model sits in front of it.
 *
 * Two modules have to agree on these shapes exactly: `useWebLlmEngine`, which
 * fills them from web-llm, and `ChatWebLlm`, which reads them as a LangChain
 * model. They used to declare their own copies and agree by inspection, which
 * held right up until one side renamed `tool_call_id` and the other kept
 * dropping it in silence. One declaration is what makes a disagreement a
 * compile error.
 *
 * Deliberately free of browser APIs, of `@mlc-ai/web-llm` and of
 * `@langchain/core`, so that either side can import it without dragging the
 * other's dependencies into a test or into the server bundle. Named for the
 * wire rather than for either caller: the field names are OpenAI's, because the
 * whole point of this boundary is that a hosted provider can be fitted behind
 * it later without a translation layer in between.
 */

/** The roles web-llm's chat templates understand. */
export type WebLlmChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** A tool call as it is echoed back on the assistant turn that made it. */
export type WebLlmChatToolCall = {
  id: string
  type: 'function'
  function: { name: string, arguments: string }
}

/**
 * One message in a request.
 *
 * Flat rather than a discriminated union: every implementation of the streamer
 * would otherwise have to narrow the same four arms again before it could read
 * a field that only one role uses.
 */
export type WebLlmChatMessage = {
  role: WebLlmChatRole
  content: string
  /**
   * Set on a `tool` message: which call this is the result of.
   *
   * An agent loop replays its own transcript on every turn, so a tool result
   * has to say what it answers. web-llm itself discards the id — its prompt
   * builder renders a tool message as its content and nothing else — but the
   * field is how every hosted provider pairs a call with its result, and
   * dropping it here would make this boundary the one that cannot be swapped.
   */
  tool_call_id?: string
  /** Set on an `assistant` message that called tools, so the next turn can see them. */
  tool_calls?: WebLlmChatToolCall[]
}

/**
 * A fragment of one tool call, as a streaming provider reports it.
 *
 * Everything but `index` is optional because a call arrives in pieces: the name
 * in one chunk, the arguments a few characters at a time after it, and the
 * index is the only thing that says which call a fragment belongs to. Mirrored
 * field for field from web-llm's `ChatCompletionChunk.Choice.Delta.ToolCall`,
 * and the engine hands web-llm's own array straight into this shape, so a
 * release that changes it stops compiling there.
 */
export type WebLlmToolCallDelta = {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string, arguments?: string }
}

/**
 * One step of an answer as it decodes.
 *
 * A plain string was enough while the only caller was a panel appending text.
 * It is not enough for a chat model: a provider reports tool calls in a field
 * of their own, on a delta that often carries no text at all.
 */
export type WebLlmStreamDelta = {
  content?: string
  toolCalls?: WebLlmToolCallDelta[]
}

/**
 * xgrammar's triggered-tag grammar, as web-llm accepts it.
 *
 * `triggers` are strings that arm a tag: everything the model writes is free
 * text until one of them appears, and from that point the matching tag's
 * `begin`/`content`/`end` is the only thing the sampler will allow. That is
 * what lets a tool call be format-guaranteed without every ordinary answer
 * being forced into JSON.
 */
export type WebLlmStructuralTag = {
  type: 'structural_tag'
  format: {
    type: 'triggered_tags'
    triggers: string[]
    tags: {
      type: 'tag'
      begin: string
      end: string
      content: { type: 'json_schema', json_schema: Record<string, unknown> }
    }[]
  }
}

/**
 * How the sampler is constrained while it decodes, if at all.
 *
 * This is the field that lets a 2 GB model call a tool. web-llm validates it
 * structurally and nothing else — a `schema` requires `json_object`, a tag
 * requires `structural_tag` — with no model list anywhere near it, because the
 * constraint is enforced by a grammar-aware sampler rather than by anything the
 * weights were trained on. Constrained decoding *guarantees* the shape, where a
 * fine-tune only makes it likely.
 *
 * Only the two arms that are actually produced are modelled. `grammar` (raw
 * EBNF) and a bare `text` are left out because nothing emits them, and a type
 * that describes only what is sent is one the engine can forward without
 * narrowing.
 */
export type WebLlmResponseFormat
  = | { type: 'json_object', schema: string }
    | { type: 'structural_tag', structural_tag: WebLlmStructuralTag }

/**
 * What a turn needs beyond the messages.
 *
 * Note what is *not* here: `tools`. web-llm's own tools path is a model
 * allowlist in front of a system prompt, and `ChatWebLlm` writes that system
 * prompt itself, so there is nothing left to hand over. Leaving the field out
 * rather than leaving it unset makes "never send tools to web-llm" a fact the
 * type system holds rather than a rule to remember.
 */
export type WebLlmStreamOptions = {
  enableThinking: boolean
  temperature?: number
  /** Set only when tools are bound; forwarded verbatim as `response_format`. */
  responseFormat?: WebLlmResponseFormat
}

/**
 * The engine as a chat model sees it.
 *
 * Named as a type so a model class depends on these two functions rather than
 * on a Vue composable full of refs and browser APIs. That is what keeps the
 * chat swappable: hand `ChatWebLlm` a streamer backed by something other than
 * web-llm and nothing else about the panel has to move.
 */
export type WebLlmStreamer = {
  streamChat: (
    modelId: string,
    messages: readonly WebLlmChatMessage[],
    options: WebLlmStreamOptions,
    onDelta: (delta: WebLlmStreamDelta) => void
  ) => Promise<void>
  interrupt: () => void
}

/**
 * The tags a tool call is written between.
 *
 * `<tool_call>` rather than a JSON envelope or a bare object because it is what
 * the Hermes fine-tunes were trained on and what nearly every open tool-calling
 * prompt in circulation uses, so a general model has seen the shape too. It is
 * also the string that arms the grammar, which means the model's own decision
 * to open a call is what switches the sampler into constrained mode.
 *
 * Here rather than in the model class because both ends need them: the class
 * writes and reads them, and the engine renders a replayed assistant tool call
 * back into the same shape so a transcript reads to the model the way its own
 * output did.
 */
export const TOOL_CALL_OPEN_TAG = '<tool_call>'
export const TOOL_CALL_CLOSE_TAG = '</tool_call>'

/**
 * The tags a tool result is written between when it is replayed to the model.
 *
 * The counterpart to `<tool_call>`, and from the same Hermes prompt format, so
 * a model that recognises one recognises the other. `renderToolResult` says why
 * a result has to be written into a turn at all rather than sent as one.
 */
export const TOOL_RESPONSE_OPEN_TAG = '<tool_response>'
export const TOOL_RESPONSE_CLOSE_TAG = '</tool_response>'

/**
 * An assistant turn's tool calls, written the way the model wrote them.
 *
 * web-llm's prompt builder renders an assistant message as its `content` and
 * throws `tool_calls` away — verified in the shipped bundle, where the
 * assistant arm of `getConversationFromChatCompletionRequest` appends the
 * content and nothing else. So a replayed agent transcript would show the model
 * an empty assistant turn followed by a tool result answering nothing.
 *
 * Rendering the calls back into `<tool_call>` blocks is what keeps the
 * transcript coherent: it is the exact shape the tool prompt asked for and the
 * exact shape the model emitted, so the conversation it reads on turn two is
 * the one that actually happened. Only for a message that has no text of its
 * own to say it with — a model that narrated its call keeps its narration.
 */
export function renderAssistantToolCalls(message: WebLlmChatMessage): string {
  if (!message.tool_calls?.length) {
    return message.content
  }

  const rendered = message.tool_calls.map((toolCall) => {
    const payload = JSON.stringify({
      name: toolCall.function.name,
      // Re-parsed rather than interpolated: `arguments` is a JSON string, and
      // embedding it as one would show the model an escaped string where it
      // wrote an object. Unparseable arguments are shown as they are, because
      // what the model actually wrote is the honest thing to replay.
      arguments: parseArguments(toolCall.function.arguments)
    })

    return `${TOOL_CALL_OPEN_TAG}${payload}${TOOL_CALL_CLOSE_TAG}`
  })

  return [message.content, ...rendered].filter(Boolean).join('\n')
}

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

/**
 * A tool result, written the way the model can read it.
 *
 * The pair of `renderAssistantToolCalls`, and it exists for a harder reason.
 * web-llm's prompt builder does not merely ignore a `tool` message — it refuses
 * one, unless the loaded model's chat template declares a `tool` role. Four of
 * the eight curated models do not: Qwen3 0.6B, 1.7B and 4B, and Phi-3.5 mini,
 * all list `user` and `assistant` and nothing else, and the recommended model
 * is among them. Sending the role would throw `Role is not supported: tool`
 * from inside the conversation builder, which reaches the panel as a generation
 * failure and takes agent mode down on the model it is tuned for.
 *
 * So the result is written into a user turn instead, in the `<tool_response>`
 * shape the same prompt format pairs with `<tool_call>`. Nothing is lost that
 * web-llm was going to keep: its own `tool` arm renders the content and drops
 * the id.
 */
export function renderToolResult(message: WebLlmChatMessage): string {
  return `${TOOL_RESPONSE_OPEN_TAG}${message.content}${TOOL_RESPONSE_CLOSE_TAG}`
}

/** The roles every web-llm chat template understands. */
export type WebLlmTemplateRole = 'system' | 'user' | 'assistant'

/** A request message with the roles and the text web-llm will actually take. */
export type WebLlmTemplateMessage = {
  role: WebLlmTemplateRole
  content: string
}

/**
 * The OpenAI-shaped transcript as web-llm's chat templates can take it.
 *
 * The two structured fields on the boundary — `tool_calls` on an assistant turn
 * and the `tool` role itself — are what a hosted provider reads and what
 * web-llm either discards or rejects, so this is where they turn back into the
 * text the model wrote and read. Doing it here rather than in the composable
 * keeps it testable, and the narrower return type is what makes "never send
 * role `tool` to web-llm" a fact the compiler holds.
 */
export function toWebLlmTemplateMessages(
  messages: readonly WebLlmChatMessage[]
): WebLlmTemplateMessage[] {
  return messages.map((message) => {
    if (message.role === 'system') {
      return { role: 'system', content: message.content }
    }

    if (message.role === 'assistant') {
      return { role: 'assistant', content: renderAssistantToolCalls(message) }
    }

    if (message.role === 'tool') {
      return { role: 'user', content: renderToolResult(message) }
    }

    return { role: 'user', content: message.content }
  })
}
