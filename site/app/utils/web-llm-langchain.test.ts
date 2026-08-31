import { strict as assert } from 'node:assert'
import type { ToolDefinition } from '@langchain/core/language_models/base'
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import {
  ChatWebLlm,
  ChatWebLlmMessageError,
  buildToolCallJsonSchema,
  buildToolCallResponseFormat,
  buildToolPromptSection,
  createToolCallChunkReader,
  createToolCallReader,
  parseToolCallPayload,
  readToolCallMode,
  toWebLlmChatMessages,
  withToolInstructions
} from './web-llm-langchain.ts'
import { TOOL_CALL_CLOSE_TAG, TOOL_CALL_OPEN_TAG } from './web-llm-boundary.ts'
import type {
  WebLlmChatMessage,
  WebLlmStreamDelta,
  WebLlmStreamOptions,
  WebLlmStreamer
} from './web-llm-boundary.ts'
import { TOOL_TUNED_WEB_LLM_MODEL_IDS, modelIsToolTuned } from './web-llm-catalog.ts'

/**
 * The model the panel recommends, and a `'general'` one — which is the whole
 * point of the tests below. Everything the agent needs has to work on this id.
 */
const RECOMMENDED_MODEL = 'Qwen3-1.7B-q4f16_1-MLC'
const TOOL_TUNED_MODEL = 'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC'

type StreamCall = {
  modelId: string
  messages: readonly WebLlmChatMessage[]
  options: WebLlmStreamOptions
}

/**
 * An engine that replays a fixed script.
 *
 * The whole reason `ChatWebLlm` takes a `WebLlmStreamer` rather than building
 * an `MLCEngine` is so that this object can stand in for one: no WebGPU, no
 * worker, no 2 GB download, and every argument the model sends is recorded
 * where an assertion can read it.
 */
function fakeStreamer(script: readonly WebLlmStreamDelta[]): WebLlmStreamer & {
  calls: StreamCall[]
  interrupts: number
} {
  const calls: StreamCall[] = []
  const state = { interrupts: 0 }

  return {
    calls,
    get interrupts() {
      return state.interrupts
    },
    async streamChat(modelId, messages, options, onDelta) {
      calls.push({ modelId, messages, options })

      for (const delta of script) {
        // A real engine yields between chunks; so does this, or the generator
        // on the other side would never park and the buffering would go
        // untested.
        await Promise.resolve()
        onDelta(delta)
      }
    },
    interrupt() {
      state.interrupts += 1
    }
  }
}

function textDeltas(...chunks: string[]): WebLlmStreamDelta[] {
  return chunks.map(content => ({ content }))
}

function collect(step: { text: string, toolCallChunks: unknown[] }): string {
  return step.text
}

// --- a plain streamed answer -------------------------------------------------

{
  const engine = fakeStreamer(textDeltas('Nest', ' builds', ' the graph.'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const streamed: string[] = []

  for await (const chunk of await model.stream([new HumanMessage('What does Nest do?')])) {
    streamed.push(chunk.content.toString())
  }

  assert.deepEqual(streamed, ['Nest', ' builds', ' the graph.'])

  const answer = await model.invoke([new HumanMessage('What does Nest do?')])
  assert.equal(answer.content, 'Nest builds the graph.')
  assert.equal(answer.getType(), 'ai')
}

// A model that answered nothing — interrupted before its first token — is a
// stop button working, not an error to throw at the panel.
{
  const model = new ChatWebLlm({ engine: fakeStreamer([]), model: RECOMMENDED_MODEL })
  const answer = await model.invoke([new HumanMessage('...')])

  assert.equal(answer.content, '')
}

// Empty deltas are noise from the decoder, not tokens, and must not reach the
// panel as blank chunks.
{
  const engine = fakeStreamer([{ content: '' }, { content: 'one' }, {}, { content: '' }])
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const streamed: string[] = []

  for await (const chunk of await model.stream([new HumanMessage('hi')])) {
    streamed.push(chunk.content.toString())
  }

  assert.deepEqual(streamed, ['one'])
}

// LangChain's own callback surface has to see the tokens, or `streamEvents`
// and every tracer built on it go quiet.
{
  const engine = fakeStreamer(textDeltas('a', 'b'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const tokens: string[] = []

  await model.invoke([new HumanMessage('hi')], {
    callbacks: [{ handleLLMNewToken: (token: string) => { tokens.push(token) } }]
  })

  assert.deepEqual(tokens, ['a', 'b'])
}

// Without tools bound nothing is held back looking for a tag, so a question
// about `<tool_call>` itself reads back exactly as the model typed it.
{
  const engine = fakeStreamer(textDeltas('Write ', TOOL_CALL_OPEN_TAG, ' to call one.'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })
  const answer = await model.invoke([new HumanMessage('How do I call a tool?')])

  assert.equal(answer.content, `Write ${TOOL_CALL_OPEN_TAG} to call one.`)
  assert.deepEqual(answer.tool_calls, [])
}

// --- the options that reach the engine ---------------------------------------

// The bug the deprecated `ChatWebLLM` had: it took a temperature in its
// constructor and then never read the field again, so every request decoded at
// whatever web-llm's default happened to be.
{
  const engine = fakeStreamer(textDeltas('ok'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL, temperature: 0.7 })

  await model.invoke([new HumanMessage('hi')])

  assert.equal(engine.calls.length, 1)
  assert.equal(engine.calls[0]?.options.temperature, 0.7)
  assert.equal(engine.calls[0]?.modelId, RECOMMENDED_MODEL)
}

// Unspecified means the panel's own default, not web-llm's: a graph question
// has its answer in the prompt, so invention is the failure mode.
{
  const engine = fakeStreamer(textDeltas('ok'))
  await new ChatWebLlm({ engine, model: RECOMMENDED_MODEL }).invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.temperature, 0.2)
}

// A single call may overrule the constructor without building a second model.
{
  const engine = fakeStreamer(textDeltas('ok'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL, temperature: 0.7 })

  await model.invoke([new HumanMessage('hi')], { temperature: 0 })

  assert.equal(engine.calls[0]?.options.temperature, 0)
}

// Zero is a temperature, not an absence — the reason the default is `??` and
// not `||`.
{
  const engine = fakeStreamer(textDeltas('ok'))
  await new ChatWebLlm({ engine, model: RECOMMENDED_MODEL, temperature: 0 }).invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.temperature, 0)
}

// Thinking is on unless it is switched off, and the switch has to survive the
// trip to the engine — it is the whole of `extra_body.enable_thinking`.
{
  const engine = fakeStreamer(textDeltas('ok'))
  await new ChatWebLlm({ engine, model: RECOMMENDED_MODEL }).invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.enableThinking, true)
}

{
  const engine = fakeStreamer(textDeltas('ok'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL, enableThinking: false })

  await model.invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.enableThinking, false)
}

{
  const engine = fakeStreamer(textDeltas('ok'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL, enableThinking: true })

  await model.invoke([new HumanMessage('hi')], { enableThinking: false })

  assert.equal(engine.calls[0]?.options.enableThinking, false)
}

// --- message conversion ------------------------------------------------------

{
  const converted = toWebLlmChatMessages([
    new SystemMessage('You read dependency graphs.'),
    new HumanMessage('Which modules import AuthModule?'),
    new AIMessage('Let me look.'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_7', name: 'find_importers', args: { module: 'AuthModule' } }]
    }),
    new ToolMessage({ content: 'BillingModule', tool_call_id: 'call_7' })
  ])

  assert.deepEqual(converted, [
    { role: 'system', content: 'You read dependency graphs.' },
    { role: 'user', content: 'Which modules import AuthModule?' },
    { role: 'assistant', content: 'Let me look.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_7',
        type: 'function',
        function: { name: 'find_importers', arguments: '{"module":"AuthModule"}' }
      }]
    },
    { role: 'tool', content: 'BillingModule', tool_call_id: 'call_7' }
  ])
}

// The agent loop hands back a call the model made without an id, because
// web-llm's streaming deltas do not carry one. It still has to be paired with
// its result rather than dropped.
{
  const converted = toWebLlmChatMessages([
    new AIMessage({ content: '', tool_calls: [{ name: 'count_modules', args: {} }] })
  ])

  assert.deepEqual(converted, [{
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'webllm_call_0',
      type: 'function',
      function: { name: 'count_modules', arguments: '{}' }
    }]
  }])
}

// Text blocks are the shape LangChain v1 hands over as a matter of course —
// `createAgent` builds its own system message that way — so they flatten rather
// than being refused. Refusing them made agent mode unreachable on the first turn.
{
  assert.deepEqual(
    toWebLlmChatMessages([
      new HumanMessage({ content: [{ type: 'text', text: 'look at this' }] })
    ]),
    [{ role: 'user', content: 'look at this' }]
  )

  assert.deepEqual(
    toWebLlmChatMessages([
      new SystemMessage({
        content: [
          { type: 'text', text: 'first paragraph' },
          { type: 'text', text: 'second paragraph' }
        ]
      })
    ]),
    [{ role: 'system', content: 'first paragraph\nsecond paragraph' }]
  )
}

// Conversion is still one-to-one for anything that is not text. A message that
// cannot be expressed has to say so, because a dropped one changes the question
// silently.
{
  assert.throws(
    () => toWebLlmChatMessages([
      new HumanMessage({
        content: [{ type: 'image_url', image_url: { url: 'https://example.test/graph.png' } }]
      })
    ]),
    (error: unknown) => {
      assert.ok(error instanceof ChatWebLlmMessageError)
      assert.match(error.message, /1 content block/)
      assert.match(error.message, /only be sent text/)

      return true
    }
  )

  assert.throws(
    () => toWebLlmChatMessages([
      new HumanMessage({
        content: [
          { type: 'text', text: 'and this' },
          { type: 'image_url', image_url: { url: 'https://example.test/graph.png' } }
        ]
      })
    ]),
    /2 content blocks/
  )
}

// --- folding the tool instructions into the system turn ----------------------

// web-llm rejects a system message anywhere but first, so a transcript that
// grew one mid-conversation has to be folded rather than sent and refused.
{
  const folded = withToolInstructions([
    { role: 'system', content: 'You read dependency graphs.' },
    { role: 'user', content: 'Which modules import AuthModule?' },
    { role: 'system', content: 'Prefer short answers.' }
  ], 'TOOLS HERE')

  assert.deepEqual(folded, [
    { role: 'system', content: 'TOOLS HERE\n\nYou read dependency graphs.\n\nPrefer short answers.' },
    { role: 'user', content: 'Which modules import AuthModule?' }
  ])
}

// A transcript with no system message of its own still gets one.
{
  assert.deepEqual(
    withToolInstructions([{ role: 'user', content: 'hi' }], 'TOOLS HERE'),
    [{ role: 'system', content: 'TOOLS HERE' }, { role: 'user', content: 'hi' }]
  )
}

// Nothing to say means no empty system turn is invented.
{
  assert.deepEqual(
    withToolInstructions([{ role: 'user', content: 'hi' }], ''),
    [{ role: 'user', content: 'hi' }]
  )
}

// --- what a bound tool turns into --------------------------------------------

const findImporters = tool(
  ({ module }: { module: string }) => `nothing imports ${module}`,
  {
    name: 'find_importers',
    description: 'Lists the modules that import a given module.',
    schema: z.object({ module: z.string().describe('The module to look up.') })
  }
)

const countModules = tool(
  () => '12 modules',
  {
    name: 'count_modules',
    description: 'Counts the modules in the graph.',
    schema: z.object({})
  }
)

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'find_importers',
      description: 'Lists the modules that import a given module.',
      parameters: { type: 'object', properties: { module: { type: 'string' } }, required: ['module'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'count_modules',
      description: 'Counts the modules in the graph.',
      parameters: { type: 'object', properties: {} }
    }
  }
]

// The name is an enum, which is what stops a small model inventing a tool: the
// sampler will not let it spell one that was not bound.
{
  const schema = buildToolCallJsonSchema(TOOL_DEFINITIONS)

  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      name: { type: 'string', enum: ['find_importers', 'count_modules'] },
      arguments: { type: 'object' }
    },
    required: ['name', 'arguments'],
    additionalProperties: false
  })
}

// The prompt has to name every tool it was given — a tool the model is never
// told about is a tool it can never call.
{
  const section = buildToolPromptSection(TOOL_DEFINITIONS)

  for (const definition of TOOL_DEFINITIONS) {
    assert.ok(section.includes(definition.function.name), `should mention ${definition.function.name}`)
    assert.ok(section.includes(definition.function.description ?? ''), 'should mention the description')
  }

  // The argument names matter more than the prose: they are the part a 1.7B
  // model gets wrong when it is left to guess.
  assert.ok(section.includes('"module"'))
  assert.ok(section.includes(TOOL_CALL_OPEN_TAG))
  assert.ok(section.includes(TOOL_CALL_CLOSE_TAG))

  // Compact, because the window is 4096 tokens and the graph answer has to fit
  // in there too. Two tools should cost a few hundred characters, not a page.
  assert.ok(section.length < 900, `tool prompt is ${section.length} characters`)

  assert.equal(buildToolPromptSection([]), '')
}

// --- the constraint ----------------------------------------------------------

assert.deepEqual(readToolCallMode(undefined, true), { kind: 'auto' })
assert.deepEqual(readToolCallMode('auto', true), { kind: 'auto' })
assert.deepEqual(readToolCallMode(undefined, false), { kind: 'none' })
assert.deepEqual(readToolCallMode('none', true), { kind: 'none' })
assert.deepEqual(readToolCallMode('any', true), { kind: 'required' })
assert.deepEqual(readToolCallMode('required', true), { kind: 'required' })
assert.deepEqual(readToolCallMode('find_importers', true), { kind: 'required', only: 'find_importers' })
assert.deepEqual(
  readToolCallMode({ type: 'function', function: { name: 'find_importers' } }, true),
  { kind: 'required', only: 'find_importers' }
)
assert.deepEqual(readToolCallMode({ name: 'count_modules' }, true), { kind: 'required', only: 'count_modules' })
assert.deepEqual(readToolCallMode({}, true), { kind: 'required' })

// The default is a structural tag, and the reason is the whole design: it
// leaves the reply free until the model writes the opening tag, so a plain
// answer is still reachable on a turn where tools are offered. A JSON schema
// over the whole reply — which is what web-llm's own Hermes path does — would
// make an ordinary sentence impossible to say.
{
  const format = buildToolCallResponseFormat(TOOL_DEFINITIONS, { kind: 'auto' })

  assert.equal(format?.type, 'structural_tag')
  assert.ok(format && 'structural_tag' in format)
  assert.deepEqual(format.structural_tag.format.triggers, [TOOL_CALL_OPEN_TAG])
  assert.equal(format.structural_tag.format.tags.length, 1)

  const tag = format.structural_tag.format.tags[0]
  assert.equal(tag?.begin, TOOL_CALL_OPEN_TAG)
  assert.equal(tag?.end, TOOL_CALL_CLOSE_TAG)
  assert.deepEqual(tag?.content.json_schema, buildToolCallJsonSchema(TOOL_DEFINITIONS))
}

// A turn that must call something is the one turn where forbidding prose is
// the point, and `json_object` is how web-llm spells that.
{
  const format = buildToolCallResponseFormat(TOOL_DEFINITIONS, { kind: 'required' })

  assert.equal(format?.type, 'json_object')
  assert.ok(format && 'schema' in format)
  assert.deepEqual(JSON.parse(format.schema), buildToolCallJsonSchema(TOOL_DEFINITIONS))
}

// A named tool narrows the enum to that one name, so the sampler cannot spell
// any other.
{
  const format = buildToolCallResponseFormat(TOOL_DEFINITIONS, { kind: 'required', only: 'count_modules' })

  assert.ok(format && 'schema' in format)
  assert.deepEqual(
    JSON.parse(format.schema),
    buildToolCallJsonSchema([TOOL_DEFINITIONS[1] as ToolDefinition])
  )
}

// A name nothing was bound for would narrow the enum to nothing, and a grammar
// that accepts no name at all cannot be decoded out of. The full set stands in
// so the agent's tool node can report the mismatch in a sentence instead.
{
  const format = buildToolCallResponseFormat(TOOL_DEFINITIONS, { kind: 'required', only: 'no_such_tool' })

  assert.ok(format && 'schema' in format)
  assert.deepEqual(JSON.parse(format.schema), buildToolCallJsonSchema(TOOL_DEFINITIONS))
}

assert.equal(buildToolCallResponseFormat(TOOL_DEFINITIONS, { kind: 'none' }), undefined)
assert.equal(buildToolCallResponseFormat([], { kind: 'auto' }), undefined)

// --- binding tools to a model nobody fine-tuned ------------------------------

// The regression this whole file exists for. An earlier version threw
// `ChatWebLlmToolsUnsupportedError` for every model outside web-llm's Hermes
// list, which put the agent behind a 4 GB download. Tool calling here is a
// system prompt and a grammar, and neither is looked up against a model list,
// so the recommended 2 GB model has to bind tools like any other.
{
  assert.equal(modelIsToolTuned(RECOMMENDED_MODEL), false, 'the recommended model is deliberately not tool-tuned')

  const engine = fakeStreamer(textDeltas('12 modules.'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const bound = model.bindTools([findImporters, countModules])
  const answer = await bound.invoke([new HumanMessage('How many modules are there?')])

  assert.equal(answer.content, '12 modules.')

  const sent = engine.calls[0]
  assert.equal(sent?.modelId, RECOMMENDED_MODEL)

  // Never web-llm's own tools path: that is the field whose model whitelist
  // made the agent unreachable in the first place.
  assert.equal('tools' in (sent?.options ?? {}), false)

  // The tools arrived as a system prompt and a grammar instead.
  assert.equal(sent?.messages[0]?.role, 'system')
  assert.ok(sent?.messages[0]?.content.includes('find_importers'))
  assert.ok(sent?.messages[0]?.content.includes('count_modules'))
  assert.equal(sent?.options.responseFormat?.type, 'structural_tag')
}

// Every tool-tuned model is still just a model here — nothing branches on it.
for (const tunedId of TOOL_TUNED_WEB_LLM_MODEL_IDS) {
  const engine = fakeStreamer(textDeltas('ok'))
  const model = new ChatWebLlm({ engine, model: tunedId })

  await model.bindTools([countModules]).invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.responseFormat?.type, 'structural_tag')
  assert.equal('tools' in (engine.calls[0]?.options ?? {}), false)
}

// A model with no tools bound is sent no grammar at all: an unconstrained
// decode is both faster and the only thing a plain chat wants.
{
  const engine = fakeStreamer(textDeltas('ok'))
  await new ChatWebLlm({ engine, model: RECOMMENDED_MODEL }).invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.responseFormat, undefined)
  assert.equal('tools' in (engine.calls[0]?.options ?? {}), false)
}

// `tool_choice: 'none'` means this turn offers nothing, so neither the prompt
// section nor the grammar should be built for it.
{
  const engine = fakeStreamer(textDeltas('ok'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  await model.bindTools([countModules], { tool_choice: 'none' }).invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.responseFormat, undefined)
  assert.equal(engine.calls[0]?.messages[0]?.role, 'user')
}

// A demanded call swaps the grammar for one that forbids prose.
{
  const engine = fakeStreamer(textDeltas('{"name": "count_modules", "arguments": {}}'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const answer = await model.bindTools([countModules], { tool_choice: 'required' })
    .invoke([new HumanMessage('hi')])

  assert.equal(engine.calls[0]?.options.responseFormat?.type, 'json_object')

  // …and the bare JSON that grammar produces still reads back as a tool call,
  // even though there are no tags anywhere in it.
  assert.deepEqual(answer.tool_calls, [{
    id: 'webllm_call_0',
    name: 'count_modules',
    args: {},
    type: 'tool_call'
  }])
}

// The zod schema has to have become JSON Schema on the way, because that is
// the only thing the model can be shown and the only thing a grammar can read.
{
  const engine = fakeStreamer(textDeltas('ok'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  await model.bindTools([findImporters]).invoke([new HumanMessage('hi')])

  const prompt = engine.calls[0]?.messages[0]?.content ?? ''
  assert.ok(prompt.includes('"module"'))
  assert.ok(prompt.includes('Lists the modules that import a given module.'))
}

// --- reading a tool call back out of the text --------------------------------

// The happy path: the grammar produced exactly the shape the prompt asked for.
{
  const engine = fakeStreamer(textDeltas(
    'Looking that up. ',
    `${TOOL_CALL_OPEN_TAG}{"name": "find_importers", "arg`,
    'uments": {"module": "AuthModule"}}',
    TOOL_CALL_CLOSE_TAG
  ))

  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })
  const answer = await model.bindTools([findImporters])
    .invoke([new HumanMessage('Which modules import AuthModule?')])

  // The JSON never reaches the panel as text — only the sentence around it.
  assert.equal(answer.content, 'Looking that up. ')
  assert.deepEqual(answer.tool_calls, [{
    id: 'webllm_call_0',
    name: 'find_importers',
    args: { module: 'AuthModule' },
    type: 'tool_call'
  }])
  assert.deepEqual(answer.invalid_tool_calls, [])
}

// Prose is still reachable on a turn that offered tools. This is the thing a
// whole-reply JSON grammar would have taken away.
{
  const engine = fakeStreamer(textDeltas('There are ', 'twelve ', 'modules.'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const streamed: string[] = []

  for await (const chunk of await model.bindTools([countModules]).stream([new HumanMessage('hi')])) {
    if (chunk.content) {
      streamed.push(chunk.content.toString())
    }
  }

  assert.deepEqual(streamed, ['There are ', 'twelve ', 'modules.'])
}

// Two calls in one reply come back as two calls, not as one run-together mess.
{
  const engine = fakeStreamer(textDeltas(
    `${TOOL_CALL_OPEN_TAG}{"name":"count_modules","arguments":{}}${TOOL_CALL_CLOSE_TAG}`,
    `${TOOL_CALL_OPEN_TAG}{"name":"find_importers","arguments":{"module":"AuthModule"}}${TOOL_CALL_CLOSE_TAG}`
  ))

  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })
  const answer = await model.bindTools([findImporters, countModules]).invoke([new HumanMessage('hi')])

  assert.deepEqual(answer.tool_calls, [
    { id: 'webllm_call_0', name: 'count_modules', args: {}, type: 'tool_call' },
    { id: 'webllm_call_1', name: 'find_importers', args: { module: 'AuthModule' }, type: 'tool_call' }
  ])
}

// A model that ignored the tags and wrote the JSON on its own is met halfway,
// because the constraint only holds when the engine applied it.
{
  const engine = fakeStreamer(textDeltas('{"name": "count_modules", ', '"arguments": {}}'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })
  const answer = await model.bindTools([countModules]).invoke([new HumanMessage('hi')])

  assert.deepEqual(answer.tool_calls, [{
    id: 'webllm_call_0',
    name: 'count_modules',
    args: {},
    type: 'tool_call'
  }])
  assert.equal(answer.content, '')
}

// A reasoning model writes its thinking first, and the JSON of a forced call
// arrives after it. Both have to survive: the thinking as text for the panel,
// the JSON as a call for the agent.
{
  const engine = fakeStreamer(textDeltas(
    '<think>\n\n</think>\n\n',
    '{"name":"count_modules","arguments":{}}'
  ))

  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })
  const answer = await model.bindTools([countModules], { tool_choice: 'required' })
    .invoke([new HumanMessage('hi')])

  assert.equal(answer.content, '<think>\n\n</think>\n\n')
  assert.deepEqual(answer.tool_calls, [{
    id: 'webllm_call_0',
    name: 'count_modules',
    args: {},
    type: 'tool_call'
  }])
}

// Malformed JSON between the tags is handed back as the model's own text, not
// thrown and not guessed at. A phantom invocation is the worst outcome here:
// the agent would run a tool nobody asked for.
{
  const raw = `${TOOL_CALL_OPEN_TAG}{"name": count_modules}${TOOL_CALL_CLOSE_TAG}`
  const engine = fakeStreamer(textDeltas('Let me check. ', raw))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const answer = await model.bindTools([countModules]).invoke([new HumanMessage('hi')])

  assert.equal(answer.content, `Let me check. ${raw}`)
  assert.deepEqual(answer.tool_calls, [])
  assert.deepEqual(answer.invalid_tool_calls, [])
}

// Well-formed JSON that is not a call at all is prose too, however much it
// looks like machinery.
{
  const raw = `${TOOL_CALL_OPEN_TAG}{"thinking": "maybe later"}${TOOL_CALL_CLOSE_TAG}`
  const engine = fakeStreamer(textDeltas(raw))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const answer = await model.bindTools([countModules]).invoke([new HumanMessage('hi')])

  assert.equal(answer.content, raw)
  assert.deepEqual(answer.tool_calls, [])
}

// A call cut off mid-decode is a stopped answer, not a call to make. LangChain
// would happily repair `{"module":` into `{}` and invoke the tool with nothing
// in it, so the fragment comes back as text instead.
{
  const engine = fakeStreamer(textDeltas(`${TOOL_CALL_OPEN_TAG}{"name": "find_importers", "argum`))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  const answer = await model.bindTools([findImporters]).invoke([new HumanMessage('hi')])

  assert.equal(answer.content, `${TOOL_CALL_OPEN_TAG}{"name": "find_importers", "argum`)
  assert.deepEqual(answer.tool_calls, [])
}

// --- the reader on its own ---------------------------------------------------

// Text that only looked like the start of a tag has to come back out, or the
// answer loses its last few characters whenever it ends in `<`.
{
  const reader = createToolCallReader(['count_modules', 'find_importers'])

  assert.equal(collect(reader.push('All done. <')), 'All done. ')
  assert.deepEqual(reader.end(), { text: '<', toolCallChunks: [] })
}

// A tag arriving one character at a time still resolves to one call, and none
// of its characters leak out as text on the way.
{
  const reader = createToolCallReader(['count_modules', 'find_importers'])
  const whole = `hi ${TOOL_CALL_OPEN_TAG}{"name":"count_modules","arguments":{}}${TOOL_CALL_CLOSE_TAG} bye`

  let text = ''
  const chunks = []

  for (const character of whole) {
    const step = reader.push(character)
    text += step.text
    chunks.push(...step.toolCallChunks)
  }

  const last = reader.end()
  text += last.text
  chunks.push(...last.toolCallChunks)

  assert.equal(text, 'hi  bye')
  assert.deepEqual(chunks, [{
    index: 0,
    id: 'webllm_call_0',
    name: 'count_modules',
    args: '{}',
    type: 'tool_call_chunk'
  }])
}

// Thinking streams as it arrives rather than being held until `</think>`,
// because a reader that waited would make a reasoning model look frozen.
{
  const reader = createToolCallReader(['count_modules', 'find_importers'])

  assert.equal(collect(reader.push('<think>Auth')), '<think>Auth')
  assert.equal(collect(reader.push('Module imports')), 'Module imports')
  assert.equal(collect(reader.push('</think>Twelve.')), '</think>Twelve.')
  assert.deepEqual(reader.end(), { text: '', toolCallChunks: [] })
}

// A brace inside a string must not close the object early.
{
  const reader = createToolCallReader(['count_modules', 'find_importers'])
  const step = reader.push('{"name":"find_importers","arguments":{"module":"a}b\\"c"}}')

  assert.deepEqual(step.toolCallChunks, [{
    index: 0,
    id: 'webllm_call_0',
    name: 'find_importers',
    args: '{"module":"a}b\\"c"}',
    type: 'tool_call_chunk'
  }])
}

// Only the *start* of a reply may be a bare call. A JSON object in the middle
// of an explanation is part of the explanation.
{
  const reader = createToolCallReader(['count_modules', 'find_importers'])
  const step = reader.push('The shape is {"name":"count_modules","arguments":{}} exactly.')

  assert.deepEqual(step.toolCallChunks, [])
  assert.equal(step.text + reader.end().text, 'The shape is {"name":"count_modules","arguments":{}} exactly.')
}

// A reasoning model opens its reply with `<think>` and rehearses the call
// format it was just shown. The sampler arms on `<tool_call>` inside the
// reasoning as readily as after it, so the call has to be read there too — a
// reader that only looked for `</think>` would flush a grammar-constrained call
// out as markup and leave the agent nothing to run.
{
  const reader = createToolCallReader(['count_modules', 'find_importers'])
  const step = reader.push(
    `<think>I should look. ${TOOL_CALL_OPEN_TAG}{"name":"count_modules","arguments":{}}${TOOL_CALL_CLOSE_TAG}</think>Twelve.`
  )

  assert.deepEqual(step.toolCallChunks, [{
    index: 0,
    id: 'webllm_call_0',
    name: 'count_modules',
    args: '{}',
    type: 'tool_call_chunk'
  }])

  // The thinking either side of the call is still the model's own text, and
  // `</think>` still closes the block it opened.
  assert.equal(step.text + reader.end().text, '<think>I should look. </think>Twelve.')
}

// The same reply arriving one character at a time reads the same way, so the
// fix is about the state machine and not about where a chunk happened to end.
{
  const reader = createToolCallReader(['count_modules'])
  const whole = `<think>hmm ${TOOL_CALL_OPEN_TAG}{"name":"count_modules","arguments":{}}${TOOL_CALL_CLOSE_TAG} done</think>Twelve.`

  let text = ''
  const chunks = []

  for (const character of whole) {
    const step = reader.push(character)
    text += step.text
    chunks.push(...step.toolCallChunks)
  }

  text += reader.end().text

  assert.equal(chunks.length, 1)
  assert.equal(text, '<think>hmm  done</think>Twelve.')
}

// A call inside the opening think block returns to the block rather than to
// ordinary text, so a second call written before `</think>` is found too.
{
  const reader = createToolCallReader(['count_modules', 'find_importers'])
  const step = reader.push(
    `<think>${TOOL_CALL_OPEN_TAG}{"name":"count_modules","arguments":{}}${TOOL_CALL_CLOSE_TAG}`
    + `${TOOL_CALL_OPEN_TAG}{"name":"find_importers","arguments":{"module":"A"}}${TOOL_CALL_CLOSE_TAG}</think>`
  )

  assert.deepEqual(step.toolCallChunks.map(chunk => chunk.name), ['count_modules', 'find_importers'])
}

// A name nothing was bound for is not a call, whichever shape it arrives in.
// The grammar already refuses to spell one, so a name outside the set can only
// come from a reply the constraint never touched — and reading it as a call
// deletes the object from the visible answer and spends a round trip telling
// the model the tool does not exist.
{
  const reader = createToolCallReader(['count_modules'])
  const raw = '{"name": "UserService", "module": "UserModule"} is the entry you asked about.'
  const step = reader.push(raw)

  assert.deepEqual(step.toolCallChunks, [])
  assert.equal(step.text + reader.end().text, raw)
}

{
  const reader = createToolCallReader(['count_modules'])
  const raw = `${TOOL_CALL_OPEN_TAG}{"name":"UserService","arguments":{}}${TOOL_CALL_CLOSE_TAG}`

  const step = reader.push(raw)

  assert.deepEqual(step.toolCallChunks, [])
  assert.equal(step.text + reader.end().text, raw)
}

// End to end, through the model: the recommended model's normal reply shape
// reaches `createAgent` as a call rather than as markup in the answer.
{
  const engine = fakeStreamer(textDeltas(
    '<think>The user wants a count, so ',
    `${TOOL_CALL_OPEN_TAG}{"name":"count_modules",`,
    '"arguments":{}}',
    TOOL_CALL_CLOSE_TAG,
    ' is what I need.</think>'
  ))

  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })
  const answer = await model.bindTools([countModules]).invoke([new HumanMessage('how many modules?')])

  assert.deepEqual(answer.tool_calls, [{
    id: 'webllm_call_0',
    name: 'count_modules',
    args: {},
    type: 'tool_call'
  }])
  assert.equal(answer.content, '<think>The user wants a count, so  is what I need.</think>')
}

// --- the payload parser ------------------------------------------------------

assert.deepEqual(
  parseToolCallPayload('{"name":"count_modules","arguments":{}}'),
  { name: 'count_modules', args: '{}' }
)

// The OpenAI wire format puts arguments in a JSON *string*, and small models
// copy it. Unwrapped here, because LangChain folds `args` by concatenation and
// only a whole JSON document survives that.
assert.deepEqual(
  parseToolCallPayload('{"name":"find_importers","arguments":"{\\"module\\":\\"AuthModule\\"}"}'),
  { name: 'find_importers', args: '{"module":"AuthModule"}' }
)

// Spellings from other prompt formats are met halfway rather than refused.
assert.deepEqual(
  parseToolCallPayload('{"tool":"count_modules","args":{"scope":"all"}}'),
  { name: 'count_modules', args: '{"scope":"all"}' }
)
assert.deepEqual(
  parseToolCallPayload('{"function":"count_modules","parameters":{}}'),
  { name: 'count_modules', args: '{}' }
)

// The shape OpenAI puts on the wire, which is the shape a model that has read a
// lot of traces reaches for. The fields inside it are the right ones.
assert.deepEqual(
  parseToolCallPayload('{"type":"function","function":{"name":"find_importers","arguments":"{\\"module\\":\\"AuthModule\\"}"}}'),
  { name: 'find_importers', args: '{"module":"AuthModule"}' }
)

// A payload with no usable name is not a call, and saying so is what keeps a
// phantom invocation out of the agent loop.
assert.equal(parseToolCallPayload('{"arguments":{}}'), undefined)
assert.equal(parseToolCallPayload('{"name":"   "}'), undefined)
assert.equal(parseToolCallPayload('["count_modules"]'), undefined)
assert.equal(parseToolCallPayload('not json'), undefined)
assert.equal(parseToolCallPayload(''), undefined)

// Missing arguments mean no arguments, which every tool here answers.
assert.deepEqual(parseToolCallPayload('{"name":"count_modules"}'), { name: 'count_modules', args: '{}' })

// --- tool-call deltas from an engine that reports them -----------------------

// The other path: a provider that streams structured calls rather than writing
// them into the content. Nothing does today, which is exactly why the boundary
// has to keep working.
{
  const read = createToolCallChunkReader()

  assert.deepEqual(read([{ index: 0, function: { name: 'find_importers' } }]), [
    { index: 0, id: 'webllm_call_0', name: 'find_importers', type: 'tool_call_chunk' }
  ])

  // The minted id is emitted once and only once, so that an engine which
  // starts sending real ids mid-call cannot end up with two on one index.
  assert.deepEqual(read([{ index: 0, function: { arguments: '{"mod' } }]), [
    { index: 0, args: '{"mod', type: 'tool_call_chunk' }
  ])
  assert.deepEqual(read([{ index: 0, function: { arguments: 'ule":"Auth"}' } }]), [
    { index: 0, args: 'ule":"Auth"}', type: 'tool_call_chunk' }
  ])

  // A second call gets its own id, keyed on the index rather than on order.
  assert.deepEqual(read([{ index: 1, id: 'call_real', function: { name: 'count' } }]), [
    { index: 1, id: 'call_real', name: 'count', type: 'tool_call_chunk' }
  ])
}

// A name split across fragments is the case LangChain cannot fold on its own:
// it replaces `name` rather than concatenating it, so each fragment has to
// carry the whole name so far or all but the last piece is lost.
{
  const read = createToolCallChunkReader()

  assert.deepEqual(read([{ index: 0, function: { name: 'find_' } }]), [
    { index: 0, id: 'webllm_call_0', name: 'find_', type: 'tool_call_chunk' }
  ])
  assert.deepEqual(read([{ index: 0, function: { name: 'importers' } }]), [
    { index: 0, name: 'find_importers', type: 'tool_call_chunk' }
  ])
}

// An engine's own id always wins over a minted one.
{
  const read = createToolCallChunkReader()

  assert.deepEqual(read([{ index: 0, id: 'call_abc', function: { name: 'a' } }]), [
    { index: 0, id: 'call_abc', name: 'a', type: 'tool_call_chunk' }
  ])
}

// A delta carrying nothing at all opens no call.
{
  const read = createToolCallChunkReader()

  assert.deepEqual(read([]), [])
  assert.deepEqual(read([{ index: 0, function: {} }]), [
    { index: 0, id: 'webllm_call_0', type: 'tool_call_chunk' }
  ])
  assert.deepEqual(read([{ index: 0, function: {} }]), [])
}

// End to end through the model: fragments spread across deltas become one whole
// tool call on the message the agent loop reads.
{
  const engine = fakeStreamer([
    { content: 'Looking that up.' },
    { toolCalls: [{ index: 0, type: 'function', function: { name: 'find_' } }] },
    { toolCalls: [{ index: 0, function: { name: 'importers', arguments: '{"module"' } }] },
    { toolCalls: [{ index: 0, function: { arguments: ':"AuthModule"}' } }] }
  ])

  const model = new ChatWebLlm({ engine, model: TOOL_TUNED_MODEL })
  const answer = await model.invoke([new HumanMessage('Which modules import AuthModule?')])

  assert.equal(answer.content, 'Looking that up.')
  assert.deepEqual(answer.tool_calls, [{
    id: 'webllm_call_0',
    name: 'find_importers',
    args: { module: 'AuthModule' },
    type: 'tool_call'
  }])
  assert.deepEqual(answer.invalid_tool_calls, [])
}

// Two calls in one generation must not have their arguments run together.
{
  const engine = fakeStreamer([
    { toolCalls: [
      { index: 0, function: { name: 'count_modules', arguments: '{' } },
      { index: 1, function: { name: 'count_providers', arguments: '{' } }
    ] },
    { toolCalls: [
      { index: 1, function: { arguments: '"scope":"all"}' } },
      { index: 0, function: { arguments: '}' } }
    ] }
  ])

  const model = new ChatWebLlm({ engine, model: TOOL_TUNED_MODEL })
  const answer = await model.invoke([new HumanMessage('How big is it?')])

  assert.deepEqual(answer.tool_calls, [
    { id: 'webllm_call_0', name: 'count_modules', args: {}, type: 'tool_call' },
    { id: 'webllm_call_1', name: 'count_providers', args: { scope: 'all' }, type: 'tool_call' }
  ])
}

// --- failure and cancellation ------------------------------------------------

// A failure inside the engine reaches the caller unwrapped: the panel
// recognises its own `WebLlmError` and would not recognise a wrapper.
{
  const failing: WebLlmStreamer = {
    async streamChat() {
      throw new Error('the GPU device was lost')
    },
    interrupt() {}
  }

  await assert.rejects(
    new ChatWebLlm({ engine: failing, model: RECOMMENDED_MODEL }).invoke([new HumanMessage('hi')]),
    /the GPU device was lost/
  )
}

/**
 * An engine that keeps decoding until something stops it.
 *
 * `fakeStreamer` finishes on its own, which makes it useless for the cases
 * below: a generation that is already over has nothing to interrupt. This is
 * what a real one looks like from the outside — one token, then a long decode
 * that only ends when `interrupt` reaches the worker.
 */
function stallingStreamer(): WebLlmStreamer & { interrupts: number } {
  const state = { interrupts: 0, release: () => {} }

  return {
    get interrupts() {
      return state.interrupts
    },
    async streamChat(_modelId, _messages, _options, onDelta) {
      onDelta({ content: 'one' })

      await new Promise<void>((resolve) => {
        state.release = resolve
      })
    },
    interrupt() {
      state.interrupts += 1
      state.release()
    }
  }
}

/** Lets a cancellation travel from the consumer down to the generator. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

// Abandoning the stream has to interrupt the worker. Walking away instead
// leaves web-llm holding the per-model lock it took before the first token,
// and the next question would wait on it forever.
{
  const engine = stallingStreamer()
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  for await (const chunk of await model.stream([new HumanMessage('hi')])) {
    assert.equal(chunk.content, 'one')
    break
  }

  await settle()

  assert.ok(engine.interrupts >= 1, 'abandoning the stream should interrupt the engine')
}

// An aborted call reaches the worker and then reports the abort, rather than
// returning half an answer as if it were whole.
{
  const engine = stallingStreamer()
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })
  const controller = new AbortController()

  const answering = model.invoke([new HumanMessage('hi')], { signal: controller.signal })

  await settle()
  controller.abort()

  await assert.rejects(answering)
  assert.ok(engine.interrupts >= 1, 'aborting should interrupt the engine')
}

// A signal that was already aborted must not start a generation at all: the
// listener below it would never fire, and web-llm holds its per-model lock for
// the length of a decode nobody is waiting for.
{
  const engine = fakeStreamer(textDeltas('Nest builds the graph.'))
  const model = new ChatWebLlm({ engine, model: RECOMMENDED_MODEL })

  await assert.rejects(
    model.invoke([new HumanMessage('hi')], { signal: AbortSignal.abort() })
  )
  assert.equal(engine.calls.length, 0, 'an aborted call should never reach the engine')
}

// --- identity ----------------------------------------------------------------

{
  const model = new ChatWebLlm({ engine: fakeStreamer([]), model: RECOMMENDED_MODEL, temperature: 0.4 })

  assert.equal(model._llmType(), 'web-llm')
  assert.equal(ChatWebLlm.lc_name(), 'ChatWebLlm')
  assert.equal(model.model, RECOMMENDED_MODEL)
  assert.equal(model.temperature, 0.4)

  // `bindTools` has to be a real method for `createAgent` to accept the model
  // at all — it checks for one before it wires up a tool node.
  assert.equal(typeof model.bindTools, 'function')

  // Nothing here is a chunk waiting to be concatenated further.
  const answer = new AIMessageChunk({ content: 'x' })
  assert.equal(answer.getType(), 'ai')
}

console.log('web-llm-langchain.test.ts ok')
