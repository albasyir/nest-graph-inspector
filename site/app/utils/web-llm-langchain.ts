/**
 * web-llm, dressed as a LangChain chat model.
 *
 * The chat panel talks to a `BaseChatModel`, never to web-llm, so that the
 * question "which model answers this?" is a constructor argument rather than a
 * rewrite. Swapping in `@langchain/openai`, `@langchain/anthropic` or a later
 * web-llm release changes the object handed to the agent and nothing else, and
 * `createAgent` gets the tool-calling surface it needs without knowing that the
 * weights happen to live in this browser.
 *
 * The class deliberately does **not** build an engine. `useWebLlmEngine` owns
 * the worker, the WebGPU device, the model cache and the download progress, and
 * a model class that constructed its own `MLCEngine` would sit on the main
 * thread, freeze the viewer while it decodes, and report none of that progress.
 * What arrives here instead is a `WebLlmStreamer` — two functions, declared in
 * `web-llm-boundary.ts` where both sides can see the same declaration, and
 * narrow enough that a scripted object stands in for the engine in a plain node
 * test with no browser, no GPU and no downloaded weights.
 *
 * ## Tool calling is implemented here, not delegated
 *
 * web-llm has its own function-calling path, and this class never uses it. That
 * path refuses any model outside a five-entry list of Hermes builds, the
 * smallest of which wants 4 GB of VRAM against the 2 GB the recommended model
 * needs. Read what it does when it accepts one, though, and the list stops
 * looking like a capability: it substitutes the tool schemas into a system
 * prompt, sets `response_format` to a JSON schema, and parses the reply back.
 * There is no kernel support and no model support involved — the list is a
 * bet on which models were fine-tuned to answer that prompt well.
 *
 * So this class does the same two things itself, and they work on every model:
 *
 * - the tool schemas go into the system prompt (`buildToolPromptSection`), and
 * - `response_format` constrains the decode (`buildToolCallResponseFormat`),
 *   which has no model list anywhere in web-llm — the check is structural.
 *
 * Constrained decoding is the stronger of the two guarantees: fine-tuning makes
 * well-formed output *likely*, a grammar at the sampler makes it *certain*. The
 * limit worth being honest about is that neither fixes judgement. A 1.7B model
 * still picks the wrong tool sometimes. That is what `toolCallingQuality` in
 * the catalog is for, and it is a hint to show, never a gate to branch on.
 *
 * Import this module dynamically. It statically imports `@langchain/core`
 * because a class cannot extend something fetched at call time, so the module
 * that reaches for it — the composable or the panel — is the one that has to
 * keep it out of the prerendered server bundle.
 */

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import type { BaseLanguageModelInput, ToolDefinition } from '@langchain/core/language_models/base'
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
  type LangSmithParams,
  type ToolChoice
} from '@langchain/core/language_models/chat_models'
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  isAIMessage,
  isAIMessageChunk,
  isToolMessage,
  type ToolCallChunk
} from '@langchain/core/messages'
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs'
import type { Runnable } from '@langchain/core/runnables'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { TOOL_CALL_CLOSE_TAG, TOOL_CALL_OPEN_TAG } from './web-llm-boundary.ts'
import type {
  WebLlmChatMessage,
  WebLlmResponseFormat,
  WebLlmStreamDelta,
  WebLlmStreamOptions,
  WebLlmStreamer,
  WebLlmToolCallDelta
} from './web-llm-boundary.ts'

export type ChatWebLlmCallOptions = BaseChatModelCallOptions & {
  /** OpenAI-shaped tool definitions, as `bindTools` leaves them. */
  tools?: ToolDefinition[]
  /** Overrides the constructor's setting for a single call. */
  enableThinking?: boolean
  temperature?: number
}

export type ChatWebLlmParams = BaseChatModelParams & {
  /** The already-built engine. This class never constructs one. */
  engine: WebLlmStreamer
  /** web-llm's `model_id` for the weights the engine has resident. */
  model: string
  temperature?: number
  enableThinking?: boolean
}

/**
 * Low, because the answers are about a graph that is in the prompt.
 *
 * A dependency question has a right answer sitting in the context, so
 * creativity here reads as invention. This is the same default the panel used
 * before LangChain sat in front of it.
 */
const DEFAULT_TEMPERATURE = 0.2

/**
 * Neither web-llm's streaming deltas nor a `<tool_call>` block carries an id —
 * web-llm's own type calls the field "Not used in WebLLM" — but the agent loop
 * needs one to pair a result with the call it answers. One is minted per call
 * when none arrives.
 */
const SYNTHETIC_TOOL_CALL_ID_PREFIX = 'webllm_call_'

/** Raised when a message cannot be expressed in web-llm's request shape. */
export class ChatWebLlmMessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatWebLlmMessageError'
  }
}

function describeContent(content: unknown): string {
  return Array.isArray(content)
    ? `${content.length} content block${content.length === 1 ? '' : 's'}`
    : `content of type ${typeof content}`
}

/** The text of a `{ type: 'text', text }` block, or nothing for any other block. */
function readTextBlock(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) {
    return undefined
  }

  const record = block as Record<string, unknown>

  if (record.type !== 'text' || typeof record.text !== 'string') {
    return undefined
  }

  return record.text
}

function readTextContent(message: BaseMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  // A list of text blocks is not an exception to handle but the shape LangChain
  // v1 hands over as a matter of course — `createAgent` builds its system
  // message that way — so refusing it would make the agent unreachable rather
  // than protect anything. Joined with newlines because separate blocks are
  // separate paragraphs of one message.
  if (Array.isArray(message.content)) {
    const texts = message.content.map(readTextBlock)

    if (texts.every(text => text !== undefined)) {
      return texts.join('\n')
    }
  }

  // Anything else is still refused rather than flattened: an image or an audio
  // block dropped here would change the question the model is answering without
  // saying so, and web-llm's chat templates take text only.
  throw new ChatWebLlmMessageError(
    `A ${message.getType()} message carries ${describeContent(message.content)} rather than text. A model running in this browser can only be sent text.`
  )
}

function toAssistantMessage(message: BaseMessage, content: string): WebLlmChatMessage {
  if (!isAIMessage(message) || !message.tool_calls?.length) {
    return { role: 'assistant', content }
  }

  return {
    role: 'assistant',
    content,
    // Replaying the calls the model made is what lets the next turn read its
    // own tool results as answers to something. Without them the transcript
    // has results that respond to nothing.
    tool_calls: message.tool_calls.map((toolCall, position) => ({
      id: toolCall.id ?? `${SYNTHETIC_TOOL_CALL_ID_PREFIX}${position}`,
      type: 'function' as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.args ?? {})
      }
    }))
  }
}

function toToolResultMessage(message: BaseMessage, content: string): WebLlmChatMessage {
  if (!isToolMessage(message)) {
    throw new ChatWebLlmMessageError(
      'A message claims to be a tool result but carries no tool call id, so there is no call for it to answer.'
    )
  }

  return { role: 'tool', content, tool_call_id: message.tool_call_id }
}

/**
 * LangChain messages as web-llm request messages.
 *
 * Exported because it is the whole of the translation between the two worlds
 * and is worth testing on its own, without an engine anywhere near it.
 */
export function toWebLlmChatMessages(messages: readonly BaseMessage[]): WebLlmChatMessage[] {
  return messages.map((message) => {
    const content = readTextContent(message)

    switch (message.getType()) {
      case 'system':
        return { role: 'system', content }
      case 'human':
        return { role: 'user', content }
      case 'ai':
        return toAssistantMessage(message, content)
      case 'tool':
        return toToolResultMessage(message, content)
      default:
        // Dropping it would quietly change the conversation, and guessing a
        // role for it would put words in someone's mouth.
        throw new ChatWebLlmMessageError(
          `A message of type "${message.getType()}" has no web-llm equivalent, so it cannot be sent to a model running in this browser.`
        )
    }
  })
}

/**
 * The request messages with the tool instructions in the system turn.
 *
 * Two things force the shape. web-llm rejects a system message anywhere but
 * first, so a transcript that grew one in the middle — which `createAgent` can
 * do — has to be folded forward rather than sent and refused. And the tool
 * section has to sit with the rest of the system prompt rather than in a turn
 * of its own, for the same reason.
 *
 * Folding is not dropping: the text of every system message survives, in order,
 * in the one that is sent. What is lost is only its position, which web-llm was
 * never going to honour.
 */
export function withToolInstructions(
  messages: readonly WebLlmChatMessage[],
  toolPrompt: string
): WebLlmChatMessage[] {
  const systemParts = messages.filter(message => message.role === 'system').map(message => message.content)
  const rest = messages.filter(message => message.role !== 'system')
  const sections = [...(toolPrompt ? [toolPrompt] : []), ...systemParts].filter(Boolean)

  if (sections.length === 0) {
    return [...rest]
  }

  return [{ role: 'system', content: sections.join('\n\n') }, ...rest]
}

/**
 * The JSON shape one tool call has to have.
 *
 * The name is an enum of the bound tools rather than a free string, which is
 * the single most valuable thing constrained decoding buys here: a model cannot
 * invent a tool that does not exist, because the sampler will not let it spell
 * one. Arguments stay an open object — narrowing them per tool would mean one
 * grammar branch per tool and a much larger compile, and the tools this serves
 * already treat a missing or wrong field as a question to answer rather than an
 * exception to throw.
 */
export function buildToolCallJsonSchema(tools: readonly ToolDefinition[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', enum: tools.map(tool => tool.function.name) },
      arguments: { type: 'object' }
    },
    required: ['name', 'arguments'],
    additionalProperties: false
  }
}

/**
 * The system-prompt section that teaches a model to call these tools.
 *
 * Modelled on the prompt web-llm ships for the Hermes builds — tool signatures,
 * then the exact JSON shape of a call — but written short, because every
 * curated model holds 4096 tokens and the graph answer has to fit in there too.
 * The schemas go in as JSON rather than as prose signatures so that argument
 * names and types arrive exactly, which is the part a small model gets wrong.
 */
export function buildToolPromptSection(tools: readonly ToolDefinition[]): string {
  if (tools.length === 0) {
    return ''
  }

  const signatures = tools.map(tool => JSON.stringify({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }))

  return [
    'You can look things up with these tools:',
    ...signatures,
    `To use one, reply with ${TOOL_CALL_OPEN_TAG}{"name": "<tool>", "arguments": {...}}${TOOL_CALL_CLOSE_TAG} and stop.`,
    'The result comes back as a tool message; answer from it. Call one tool at a time, and answer in plain prose when no tool is needed.'
  ].join('\n')
}

/**
 * What a `tool_choice` asks of a turn, once the provider-specific spellings are
 * gone.
 *
 * - `none` offers nothing: neither the prompt section nor the grammar is built.
 * - `auto` offers the tools and leaves the model to decide, so prose stays
 *   reachable.
 * - `required` demands a call, and `only` narrows it to a single tool.
 */
export type ToolCallMode
  = | { kind: 'none' }
    | { kind: 'auto' }
    | { kind: 'required', only?: string }

/**
 * LangChain's `tool_choice`, which every provider spells differently, as the
 * one question this class asks of it.
 *
 * `'any'` and `'required'` mean the same thing across providers, a bare string
 * that is none of the keywords names a tool, and OpenAI's
 * `{ type: 'function', function: { name } }` object says the same in longhand.
 */
export function readToolCallMode(toolChoice: ToolChoice | undefined, hasTools: boolean): ToolCallMode {
  if (!hasTools || toolChoice === 'none') {
    return { kind: 'none' }
  }

  if (toolChoice === undefined || toolChoice === 'auto') {
    return { kind: 'auto' }
  }

  if (typeof toolChoice === 'string') {
    return toolChoice === 'any' || toolChoice === 'required'
      ? { kind: 'required' }
      : { kind: 'required', only: toolChoice }
  }

  // Taken as `unknown` before it is read: LangChain types the object arm as
  // `Record<string, any>`, and reading a field off it would spread that `any`
  // through everything downstream.
  const choice: unknown = toolChoice
  const only = readToolChoiceName(choice)

  return only ? { kind: 'required', only } : { kind: 'required' }
}

/** The tool name out of `{ function: { name } }` or `{ name }`, if there is one. */
function readToolChoiceName(choice: unknown): string | undefined {
  if (typeof choice !== 'object' || choice === null) {
    return undefined
  }

  const record = choice as Record<string, unknown>
  const nested = record.function

  if (typeof nested === 'object' && nested !== null) {
    const name = (nested as Record<string, unknown>).name

    if (typeof name === 'string' && name) {
      return name
    }
  }

  return typeof record.name === 'string' && record.name ? record.name : undefined
}

/**
 * The grammar the sampler decodes inside, for a turn that offers tools.
 *
 * This is the subtle decision in the class, so it is worth stating the trade in
 * full. A JSON schema on `response_format` constrains *everything* the model
 * writes, which guarantees a well-formed tool call and simultaneously makes an
 * ordinary sentence unreachable — web-llm's own Hermes path has exactly that
 * flaw, and on a tools turn it cannot answer a question at all. A structural
 * tag instead leaves the reply free until the model writes `<tool_call>`, and
 * constrains only from there. So the model chooses: prose or a call, and only
 * the call is forced into shape. That also leaves `<think>` blocks reachable,
 * which a whole-reply JSON grammar would silently forbid on the reasoning
 * models this panel recommends.
 *
 * The one turn that does want the whole reply constrained is a `tool_choice`
 * that demands a call, and there `json_object` is the right instrument: prose
 * is not an allowed answer, so forbidding it is the point. web-llm requires
 * `type: 'json_object'` whenever `schema` is present, which is why the arms
 * differ in more than the field name.
 */
export function buildToolCallResponseFormat(
  tools: readonly ToolDefinition[],
  mode: ToolCallMode
): WebLlmResponseFormat | undefined {
  if (mode.kind === 'none' || tools.length === 0) {
    return undefined
  }

  if (mode.kind === 'required') {
    const narrowed = mode.only ? tools.filter(tool => tool.function.name === mode.only) : tools

    return {
      type: 'json_object',
      // A `tool_choice` naming a tool nothing was bound for would narrow the
      // enum to nothing and compile to a grammar that accepts no name at all,
      // so the full set stands in and the agent's own tool node reports the
      // mismatch — a sentence the model can act on beats a dead sampler.
      schema: JSON.stringify(buildToolCallJsonSchema(narrowed.length ? narrowed : tools))
    }
  }

  return {
    type: 'structural_tag',
    structural_tag: {
      type: 'structural_tag',
      format: {
        type: 'triggered_tags',
        triggers: [TOOL_CALL_OPEN_TAG],
        tags: [{
          type: 'tag',
          begin: TOOL_CALL_OPEN_TAG,
          end: TOOL_CALL_CLOSE_TAG,
          content: { type: 'json_schema', json_schema: buildToolCallJsonSchema(tools) }
        }]
      }
    }
  }
}

/** A tool call read out of the model's text, before LangChain sees it. */
export type ParsedToolCall = { name: string, args: string }

function readString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

/**
 * A decoded `{"name": ..., "arguments": ...}` payload, or nothing.
 *
 * Tolerant about the spelling because the constraint only holds when the engine
 * applied it: a streamer that ignores `responseFormat`, or a model answering
 * from memory of some other prompt format, reaches for `tool`/`function` and
 * `args`/`parameters` about as often as for the names asked for. Tolerant about
 * nothing else — a payload without a usable name is not a call, and saying so
 * is what keeps a phantom invocation out of the agent loop.
 */
export function parseToolCallPayload(payload: string): ParsedToolCall | undefined {
  let decoded: unknown

  try {
    decoded = JSON.parse(payload)
  } catch {
    return undefined
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return undefined
  }

  // `{"type": "function", "function": {"name": …}}` is the shape OpenAI puts on
  // the wire, so it is the shape a model that has read a lot of traces reaches
  // for. Unwrapped rather than refused: the fields inside it are the right ones.
  const outer = decoded as Record<string, unknown>
  const nested = outer.function
  const source = typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : outer

  const name = readString(source, 'name', 'tool', 'function', 'tool_name')

  if (!name) {
    return undefined
  }

  const args = source.arguments ?? source.args ?? source.parameters ?? source.input

  // Arguments are re-serialized rather than passed through, because LangChain
  // folds `args` by string concatenation and only a whole JSON document
  // survives that. A model that wrote its arguments as a JSON *string* — which
  // the OpenAI wire format does, and small models copy — is unwrapped here.
  if (typeof args === 'string') {
    return { name, args: args.trim() || '{}' }
  }

  return { name, args: JSON.stringify(args ?? {}) }
}

/** How much of `tag` the end of `text` could still be the start of. */
function danglingPrefixLength(text: string, tag: string): number {
  const most = Math.min(text.length, tag.length - 1)

  for (let length = most; length > 0; length -= 1) {
    if (text.endsWith(tag.slice(0, length))) {
      return length
    }
  }

  return 0
}

/** Where a balanced JSON object starting at index 0 ends, or -1 while it is unfinished. */
function findJsonObjectEnd(text: string): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let position = 0; position < text.length; position += 1) {
    const character = text[position]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }

      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1

      if (depth === 0) {
        return position
      }
    }
  }

  return -1
}

/** One step of reading: text the panel may show, and any calls that completed. */
export type ToolCallReaderStep = {
  text: string
  toolCallChunks: ToolCallChunk[]
}

type ReaderMode = 'preamble' | 'preamble-think' | 'text' | 'tagged' | 'bare'

const THINK_OPEN_TAG = '<think>'
const THINK_CLOSE_TAG = '</think>'

/**
 * Reads tool calls out of the content stream as it decodes.
 *
 * The calls arrive as text because that is how this class asks for them, so
 * something has to separate "the model is answering" from "the model is calling
 * something" without waiting for the generation to end — the panel streams the
 * answer, and a reader that buffered everything would hold it back.
 *
 * Three shapes are recognised, which is two more than the happy path needs:
 *
 * - a `<tool_call>…</tool_call>` block, which is what the grammar produces and
 *   what the prompt asks for;
 * - a bare JSON object at the very start of the reply, which is what a
 *   `tool_choice` that demanded a call produces, since `json_object` leaves no
 *   room for the tags;
 * - and neither, which is an ordinary answer.
 *
 * Anything that opens like a call and then does not parse comes back as text
 * rather than as a call or as a throw. A phantom invocation is the worst
 * outcome available here: the agent would run a tool the model never asked for,
 * and the model would then have to explain a result it did not request.
 *
 * That is also why `toolNames` is required rather than convenient. The grammar
 * already refuses to spell a name outside the bound set — `buildToolCallJsonSchema`
 * makes it an enum — so a name that is not in it can only come from a reply the
 * constraint never touched, and the bare arm is exactly that reply. Without the
 * check, an answer opening `{"name": "UserService", …}` is read as a call to a
 * tool named `UserService`: the object vanishes from the visible reply, the
 * agent burns a round trip on a tool that does not exist, and the user is shown
 * the sentence that was wrapped around the JSON they asked to see.
 *
 * The name check rather than switching the bare arm off outside a forced call,
 * which would fix the same reply: an engine that does not apply `responseFormat`
 * — the reason this class takes a streamer rather than an `MLCEngine` — never
 * writes the tags on an `auto` turn either, and a reader that only understood
 * them would leave such a provider unable to call a tool at all. The names are
 * what the grammar would have enforced, so checking them costs nothing that was
 * ever legitimate.
 *
 * A `<tool_call>` written inside a `<think>` block still counts, including the
 * one a reasoning model opens its reply with. That reads wrong until you notice
 * the grammar cannot tell either — the trigger arms the sampler wherever it
 * appears — so a reader that disagreed would be describing a different
 * generation from the one that happened.
 */
export function createToolCallReader(toolNames: readonly string[]): {
  push(text: string): ToolCallReaderStep
  end(): ToolCallReaderStep
} {
  let mode: ReaderMode = 'preamble'
  // Where a `<tool_call>` block hands control back. Reasoning is the reason it
  // is a variable: a call written inside the opening `<think>` block has to
  // return to the block, or the `</think>` that closes it is read as ordinary
  // text and a second call after it is missed.
  let afterTagged: ReaderMode = 'text'
  let buffer = ''
  let nextIndex = 0

  const known = new Set(toolNames)

  function toChunks(payload: string, raw: string): ToolCallReaderStep {
    const call = parseToolCallPayload(payload.trim())

    if (!call || !known.has(call.name)) {
      return { text: raw, toolCallChunks: [] }
    }

    const index = nextIndex
    nextIndex += 1

    return {
      text: '',
      toolCallChunks: [{
        index,
        id: `${SYNTHETIC_TOOL_CALL_ID_PREFIX}${index}`,
        name: call.name,
        args: call.args,
        type: 'tool_call_chunk'
      }]
    }
  }

  /** True when the reader consumed something and the caller should look again. */
  function step(out: { text: string, toolCallChunks: ToolCallChunk[] }): boolean {
    if (mode === 'preamble') {
      const leading = buffer.length - buffer.trimStart().length
      const rest = buffer.slice(leading)

      if (!rest) {
        return false
      }

      if (rest.startsWith('{')) {
        out.text += buffer.slice(0, leading)
        buffer = rest
        mode = 'bare'

        return true
      }

      if (rest.startsWith(THINK_OPEN_TAG)) {
        // Handed straight out rather than held until the block closes: the
        // panel renders reasoning as it arrives, and a reader that waited for
        // `</think>` would make a thinking model look frozen for its whole
        // first paragraph.
        const through = leading + THINK_OPEN_TAG.length
        out.text += buffer.slice(0, through)
        buffer = buffer.slice(through)
        mode = 'preamble-think'

        return true
      }

      // Still ambiguous while the buffer could grow into either tag — `<t` is
      // the start of both `<think>` and `<tool_call>`.
      if (danglingPrefixLength(rest, THINK_OPEN_TAG) === rest.length
        || danglingPrefixLength(rest, TOOL_CALL_OPEN_TAG) === rest.length) {
        return false
      }

      mode = 'text'

      return true
    }

    if (mode === 'preamble-think') {
      const close = buffer.indexOf(THINK_CLOSE_TAG)
      const open = buffer.indexOf(TOOL_CALL_OPEN_TAG)

      // Whichever tag comes first wins. A reasoning model rehearses the call
      // format it was just shown, and the sampler arms on `<tool_call>` inside
      // the reasoning as readily as after it — so a branch that only looked for
      // `</think>` would flush a well-formed, grammar-constrained call out as
      // markup and end the agent's turn with nothing to run.
      if (open !== -1 && (close === -1 || open < close)) {
        out.text += buffer.slice(0, open)
        buffer = buffer.slice(open + TOOL_CALL_OPEN_TAG.length)
        afterTagged = 'preamble-think'
        mode = 'tagged'

        return true
      }

      if (close !== -1) {
        // The thinking is over, and what follows may still be the bare JSON of
        // a forced call, so the preamble picks up where it left off.
        const through = close + THINK_CLOSE_TAG.length
        out.text += buffer.slice(0, through)
        buffer = buffer.slice(through)
        mode = 'preamble'

        return true
      }

      const held = Math.max(
        danglingPrefixLength(buffer, THINK_CLOSE_TAG),
        danglingPrefixLength(buffer, TOOL_CALL_OPEN_TAG)
      )
      out.text += buffer.slice(0, buffer.length - held)
      buffer = buffer.slice(buffer.length - held)

      return false
    }

    if (mode === 'bare') {
      const end = findJsonObjectEnd(buffer)

      if (end === -1) {
        return false
      }

      const raw = buffer.slice(0, end + 1)
      buffer = buffer.slice(end + 1)
      mode = 'text'

      const read = toChunks(raw, raw)
      out.text += read.text
      out.toolCallChunks.push(...read.toolCallChunks)

      return true
    }

    if (mode === 'text') {
      const open = buffer.indexOf(TOOL_CALL_OPEN_TAG)

      if (open !== -1) {
        out.text += buffer.slice(0, open)
        buffer = buffer.slice(open + TOOL_CALL_OPEN_TAG.length)
        afterTagged = 'text'
        mode = 'tagged'

        return true
      }

      const held = danglingPrefixLength(buffer, TOOL_CALL_OPEN_TAG)
      out.text += buffer.slice(0, buffer.length - held)
      buffer = buffer.slice(buffer.length - held)

      return false
    }

    const close = buffer.indexOf(TOOL_CALL_CLOSE_TAG)

    if (close === -1) {
      return false
    }

    const payload = buffer.slice(0, close)
    buffer = buffer.slice(close + TOOL_CALL_CLOSE_TAG.length)
    mode = afterTagged
    afterTagged = 'text'

    const read = toChunks(payload, `${TOOL_CALL_OPEN_TAG}${payload}${TOOL_CALL_CLOSE_TAG}`)
    out.text += read.text
    out.toolCallChunks.push(...read.toolCallChunks)

    return true
  }

  return {
    push(text) {
      buffer += text

      const out: ToolCallReaderStep = { text: '', toolCallChunks: [] }

      while (step(out)) {
        // `step` consumed something; there may be another call behind it.
      }

      return out
    },
    end() {
      // Whatever is still held back is the model's own text, and it goes back
      // out verbatim. A tool call that was cut off mid-decode is a stopped
      // answer, not a call to make: LangChain would happily repair `{"module":`
      // into `{}` and invoke the tool with nothing in it, which is the phantom
      // invocation this reader exists to avoid.
      const trailing = mode === 'tagged' ? `${TOOL_CALL_OPEN_TAG}${buffer}` : buffer

      buffer = ''
      mode = 'text'
      afterTagged = 'text'

      return { text: trailing, toolCallChunks: [] }
    }
  }
}

/**
 * Reads web-llm tool-call deltas as LangChain tool-call chunks, across one
 * stream.
 *
 * This is the other path: an engine that reports structured tool calls itself
 * rather than writing them into the content stream. web-llm does that only on
 * the Hermes route this class deliberately avoids, so nothing reaches it today
 * — it is here because the streamer boundary exists to accept a provider that
 * is not web-llm, and every hosted one streams calls this way.
 *
 * Stateful, because LangChain folds chunks that share an `index` with three
 * different rules and only one of them accumulates:
 *
 * - `args` are concatenated, so argument fragments reassemble on their own and
 *   are passed straight through.
 * - `name` and `id` are *replaced* by the last non-empty value seen, not
 *   concatenated. A name arriving in pieces would therefore lose everything but
 *   its last piece, so the name is accumulated here and re-sent whole each
 *   time — the replacement then lands on the complete name.
 * - a minted id is emitted only on the first fragment of a call. Repeating it
 *   is harmless while it is the only id, but an engine that starts emitting
 *   real ids partway through a call would leave two different ids on one index,
 *   which is what LangChain's grouping splits calls on.
 */
export function createToolCallChunkReader(): (deltas: readonly WebLlmToolCallDelta[]) => ToolCallChunk[] {
  const startedIndexes = new Set<number>()
  const namesByIndex = new Map<number, string>()

  return function readToolCallChunks(deltas) {
    return deltas.flatMap<ToolCallChunk>((delta, position) => {
      // A provider that omits the index leaves position in the array as the
      // only thing distinguishing two parallel calls.
      const index = Number.isInteger(delta.index) ? delta.index : position
      const hasStarted = startedIndexes.has(index)
      startedIndexes.add(index)

      const id = delta.id || (hasStarted ? undefined : `${SYNTHETIC_TOOL_CALL_ID_PREFIX}${index}`)
      const nameFragment = delta.function?.name
      const name = nameFragment ? `${namesByIndex.get(index) ?? ''}${nameFragment}` : undefined
      const args = delta.function?.arguments

      if (name !== undefined) {
        namesByIndex.set(index, name)
      }

      if (id === undefined && name === undefined && args === undefined) {
        return []
      }

      return [{
        index,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        ...(args === undefined ? {} : { args }),
        type: 'tool_call_chunk' as const
      }]
    })
  }
}

/**
 * A LangChain chat model backed by a model running on this machine's GPU.
 *
 * Extends `BaseChatModel` rather than `SimpleChatModel`: the simple base can
 * only ever return a string, which rules out tool calls and so rules out the
 * agent loop this exists to serve.
 */
export class ChatWebLlm extends BaseChatModel<ChatWebLlmCallOptions> {
  static override lc_name(): string {
    return 'ChatWebLlm'
  }

  /** web-llm's `model_id` for the weights the engine has resident. */
  readonly model: string
  readonly temperature: number
  readonly enableThinking: boolean

  // Not a field the base class serializes, and not reactive: this is a live
  // handle on a worker, and it belongs to the composable that built it.
  private readonly engine: WebLlmStreamer

  constructor(fields: ChatWebLlmParams) {
    super(fields)

    this.engine = fields.engine
    this.model = fields.model
    this.temperature = fields.temperature ?? DEFAULT_TEMPERATURE
    this.enableThinking = fields.enableThinking ?? true
  }

  _llmType(): string {
    return 'web-llm'
  }

  /**
   * `_generateUncached` folds several generations' `llmOutput` together with
   * this. Nothing survives the fold: token usage would be worth carrying, but
   * web-llm only reports it on a final chunk the streamer boundary does not
   * forward, so this answers the base class rather than carrying anything.
   */
  override _combineLLMOutput(): Record<string, never> {
    return {}
  }

  override getLsParams(options: this['ParsedCallOptions']): LangSmithParams {
    return {
      ...super.getLsParams(options),
      ls_provider: 'web-llm',
      ls_model_name: this.model,
      ls_model_type: 'chat',
      ls_temperature: options.temperature ?? this.temperature
    }
  }

  override invocationParams(options?: this['ParsedCallOptions']): WebLlmStreamOptions {
    const tools = options?.tools ?? []
    const mode = readToolCallMode(options?.tool_choice, tools.length > 0)
    const responseFormat = buildToolCallResponseFormat(tools, mode)

    return {
      enableThinking: options?.enableThinking ?? this.enableThinking,
      temperature: options?.temperature ?? this.temperature,
      ...(responseFormat ? { responseFormat } : {})
    }
  }

  /**
   * Binds tools to any model at all.
   *
   * There is deliberately no capability check here, and the absence is the
   * point of the class. web-llm refuses `tools` for anything outside its Hermes
   * list, so an earlier version of this method refused too — and that made the
   * agent unreachable on the 2 GB model the panel recommends, for a limit that
   * turns out to be about a prompt rather than about the model. Nothing is
   * handed to web-llm's tools path any more, so nothing needs its permission.
   */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatWebLlmCallOptions>
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatWebLlmCallOptions> {
    // `withConfig` rather than the `bind` LangChain used to have: v1 removed
    // `bind`, and unrecognised keys on a config still arrive as call options.
    return this.withConfig({
      tools: tools.map(tool => convertToOpenAITool(tool)),
      ...kwargs
    })
  }

  override async* _streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const streamOptions = this.invocationParams(options)
    const tools = options.tools ?? []
    const mode = readToolCallMode(options.tool_choice, tools.length > 0)
    const toolPrompt = mode.kind === 'none' ? '' : buildToolPromptSection(tools)

    const requestMessages = toolPrompt
      ? withToolInstructions(toWebLlmChatMessages(messages), toolPrompt)
      : toWebLlmChatMessages(messages)

    const { signal } = options

    // The engine pushes deltas at a callback and resolves when the generation
    // is over; a LangChain model has to pull them out of a generator. This
    // buffer is the join: deltas queue up as they arrive, and the generator
    // parks on a promise whenever it has drained them.
    const buffered: WebLlmStreamDelta[] = []
    let wake: (() => void) | undefined
    let finished = false
    let hasFailed = false
    let failure: unknown

    function wakeUp(): void {
      const resume = wake
      wake = undefined
      resume?.()
    }

    // Settled with `then`'s two arms rather than left to reject, so that a
    // failure arriving while the generator is parked cannot become an
    // unhandled rejection before anyone is there to read it.
    const streaming = this.engine
      .streamChat(this.model, requestMessages, streamOptions, (delta) => {
        buffered.push(delta)
        wakeUp()
      })
      .then(
        () => {
          finished = true
        },
        (cause: unknown) => {
          finished = true
          hasFailed = true
          failure = cause
        }
      )
      .finally(wakeUp)

    // An abort has to reach the worker, which is the only thing that can stop a
    // decode already in flight. Interrupting ends the stream, which is what
    // lets the loop below finish rather than hang on a signal nobody read.
    const handleAbort = (): void => {
      this.engine.interrupt()
    }

    signal?.addEventListener('abort', handleAbort, { once: true })

    const readToolCallChunks = createToolCallChunkReader()
    // Only when tools are on the table. A plain chat has no reason to hold text
    // back looking for a tag the model was never told about, and a question
    // about `<tool_call>` itself should read back as what the model typed. The
    // names go in because they are what separates a call from a JSON answer —
    // the same enum the grammar constrains the decode with.
    const readToolCalls = toolPrompt
      ? createToolCallReader(tools.map(tool => tool.function.name))
      : undefined

    function emit(text: string, toolCallChunks: ToolCallChunk[]): ChatGenerationChunk | undefined {
      if (!text && toolCallChunks.length === 0) {
        return undefined
      }

      return new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({
          content: text,
          ...(toolCallChunks.length > 0 ? { tool_call_chunks: toolCallChunks } : {})
        })
      })
    }

    try {
      for (;;) {
        while (buffered.length > 0) {
          const delta = buffered.shift()

          if (!delta) {
            continue
          }

          const read = readToolCalls?.push(delta.content ?? '')
          const text = read ? read.text : (delta.content ?? '')
          const toolCallChunks = [
            ...(read?.toolCallChunks ?? []),
            ...(delta.toolCalls?.length ? readToolCallChunks(delta.toolCalls) : [])
          ]

          const chunk = emit(text, toolCallChunks)

          if (!chunk) {
            continue
          }

          if (text) {
            await runManager?.handleLLMNewToken(text)
          }

          yield chunk
        }

        if (finished) {
          break
        }

        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }

      // Whatever the reader was still holding back — a half-written tag, or
      // text that only looked like the start of one — is the model's and has
      // to come out before the generation is called finished.
      const trailing = readToolCalls?.end()
      const lastChunk = trailing ? emit(trailing.text, trailing.toolCallChunks) : undefined

      if (trailing && lastChunk) {
        if (trailing.text) {
          await runManager?.handleLLMNewToken(trailing.text)
        }

        yield lastChunk
      }
    } finally {
      signal?.removeEventListener('abort', handleAbort)

      // Whoever abandoned the generator — a `break` in the caller's loop, or a
      // thrown error — left a decode running on the worker. Interrupting and
      // then waiting for the engine to acknowledge it is what releases the
      // per-model lock web-llm holds for the length of a generation; walking
      // away instead leaves the next request waiting on a lock nobody frees.
      if (!finished) {
        this.engine.interrupt()
      }

      await streaming
    }

    signal?.throwIfAborted()

    if (hasFailed) {
      throw failure
    }
  }

  /**
   * Built on the stream rather than beside it, so there is one code path to
   * get right. web-llm decodes token by token either way.
   */
  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    let aggregate: ChatGenerationChunk | undefined

    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) {
      aggregate = aggregate === undefined ? chunk : aggregate.concat(chunk)
    }

    if (aggregate === undefined) {
      // A model that was interrupted before its first token, or that answered
      // nothing. An empty answer is still an answer, and throwing here would
      // turn a stop button into an error.
      return { generations: [{ text: '', message: new AIMessage({ content: '' }) }] }
    }

    const merged = aggregate.message

    return {
      generations: [{
        text: aggregate.text,
        // A settled `AIMessage` rather than the chunk it was assembled from:
        // the tool-call fragments have been folded into whole calls by now, and
        // handing the caller a chunk invites it to keep concatenating.
        message: new AIMessage({
          content: merged.content,
          additional_kwargs: merged.additional_kwargs,
          response_metadata: merged.response_metadata,
          ...(isAIMessageChunk(merged)
            ? {
                tool_calls: merged.tool_calls,
                invalid_tool_calls: merged.invalid_tool_calls
              }
            : {})
        })
      }]
    }
  }
}
