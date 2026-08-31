import { strict as assert } from 'node:assert'
import type { GraphOutput } from 'nest-graph-inspector'
import {
  DEFAULT_GRAPH_AGENT_MAX_STEPS,
  GRAPH_AGENT_TOOL_PROMPT_CHARS,
  budgetAgentTranscript,
  buildGraphAgentSystemPrompt,
  estimateGraphAgentPromptChars,
  runGraphAgent
} from './graph-agent-run.ts'
import type { GraphAgentEvent, TranscriptMessage } from './graph-agent-run.ts'
import { createGraphAgentTools } from './graph-agent-tools.ts'
import { WEB_LLM_PROMPT_CHAR_BUDGET } from './web-llm-context.ts'
import { renderAssistantToolCalls } from './web-llm-boundary.ts'
import type {
  WebLlmChatMessage,
  WebLlmStreamDelta,
  WebLlmStreamOptions,
  WebLlmStreamer
} from './web-llm-boundary.ts'

/**
 * A graph small enough to reason about by eye and complete enough for every
 * tool to answer from it.
 */
function buildGraph(): GraphOutput {
  return {
    version: '3',
    root: 'AppModule',
    modules: {
      AppModule: {
        imports: ['UserModule'],
        exports: [],
        providers: [],
        controllers: []
      },
      UserModule: {
        imports: [],
        exports: ['UserService'],
        providers: [{ name: 'UserService', dependencies: [] }],
        controllers: [
          {
            name: 'UserController',
            dependencies: [{ providedBy: { type: 'module', name: 'UserModule' }, token: 'UserService' }]
          }
        ]
      }
    },
    cycles: { modules: [], providers: [], controllers: [] }
  }
}

/**
 * An engine that reads from a script instead of a GPU.
 *
 * This is the whole reason the streamer is a type rather than the composable:
 * the ReAct loop, the tool-call parsing and the step cap are all exercised here
 * with no browser, no WebGPU and no downloaded weights.
 */
function scriptedEngine(turns: readonly (readonly string[])[]): WebLlmStreamer & {
  requests: WebLlmChatMessage[][]
  options: WebLlmStreamOptions[]
} {
  let turn = 0
  const requests: WebLlmChatMessage[][] = []
  const options: WebLlmStreamOptions[] = []

  return {
    requests,
    options,
    async streamChat(
      _modelId: string,
      messages: readonly WebLlmChatMessage[],
      streamOptions: WebLlmStreamOptions,
      onDelta: (delta: WebLlmStreamDelta) => void
    ): Promise<void> {
      requests.push([...messages])
      options.push(streamOptions)

      // Past the end of the script the last turn repeats, which is what a
      // looping model looks like and what the step cap has to survive.
      const script = turns[Math.min(turn, turns.length - 1)] ?? []
      turn += 1

      for (const piece of script) {
        onDelta({ content: piece })
      }
    },
    interrupt() {}
  }
}

function toolCall(name: string, args: Record<string, unknown> = {}): string {
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`
}

// --- the system prompt -------------------------------------------------------
{
  const prompt = buildGraphAgentSystemPrompt(buildGraph())

  assert.match(prompt, /AppModule/)
  assert.match(prompt, /UserModule/)

  // The graph itself stays out of the prompt: the point of the agent is that it
  // asks rather than reads, and the window is 4096 tokens with tool schemas
  // already in it.
  assert.ok(!prompt.includes('UserService'), 'the agent prompt must not carry the graph body')
  assert.ok(prompt.length < 900, `agent prompt is ${prompt.length} chars`)

  // Past the naming budget it points at the tool rather than listing badly.
  const wide = buildGraphAgentSystemPrompt(buildGraph(), 1)
  assert.match(wide, /call list_modules/)
  assert.ok(!wide.includes('AppModule'))

  // An empty graph has to say so rather than invite the model to invent one.
  assert.match(buildGraphAgentSystemPrompt(null), /No graph has loaded yet/)
}

// --- one lookup, then an answer ---------------------------------------------
{
  const engine = scriptedEngine([
    [toolCall('describe_module', { name: 'UserModule' })],
    ['UserModule declares ', '`UserService`.']
  ])

  const events: GraphAgentEvent[] = []
  const result = await runGraphAgent(
    {
      engine,
      modelId: 'Qwen3-1.7B-q4f16_1-MLC',
      graph: buildGraph(),
      messages: [{ role: 'user', content: 'what is in UserModule?' }]
    },
    event => events.push(event)
  )

  assert.equal(result.stoppedAtLimit, false)
  assert.equal(result.toolCallCount, 1)
  assert.equal(result.text, 'UserModule declares `UserService`.')

  const call = events.find(event => event.type === 'tool-call')
  assert.ok(call && call.type === 'tool-call')
  assert.equal(call.name, 'describe_module')
  assert.equal(call.args, '{"name":"UserModule"}')

  const toolResult = events.find(event => event.type === 'tool-result')
  assert.ok(toolResult && toolResult.type === 'tool-result')
  assert.equal(toolResult.name, 'describe_module')
  assert.equal(toolResult.id, call.id)
  assert.match(toolResult.text, /UserService/)

  // The answer is reported whole on every delta, so a panel can render the
  // current state without keeping its own buffer.
  const answers = events.filter(event => event.type === 'answer').map(event => event.text)
  assert.deepEqual(answers, ['UserModule declares ', 'UserModule declares `UserService`.'])

  // The call comes before its result, and both before the answer they produced.
  const order = events.map(event => event.type)
  assert.ok(order.indexOf('tool-call') < order.indexOf('tool-result'))
  assert.ok(order.indexOf('tool-result') < order.indexOf('answer'))
}

// --- the model asks with no tools bound to web-llm itself --------------------
{
  const engine = scriptedEngine([
    [toolCall('list_modules')],
    ['Two: AppModule and UserModule.']
  ])

  await runGraphAgent(
    {
      engine,
      modelId: 'Qwen3-1.7B-q4f16_1-MLC',
      graph: buildGraph(),
      messages: [{ role: 'user', content: 'how many modules?' }],
      temperature: 0.1,
      enableThinking: false
    },
    () => {}
  )

  const [firstOptions] = engine.options
  assert.ok(firstOptions)
  assert.equal(firstOptions.temperature, 0.1)
  assert.equal(firstOptions.enableThinking, false)

  // The engine is never asked for web-llm's own tools path, which is what makes
  // the agent run on a model outside the Hermes allowlist.
  assert.equal('tools' in firstOptions, false)

  // The decode is constrained instead, and the trigger leaves prose reachable.
  assert.equal(firstOptions.responseFormat?.type, 'structural_tag')

  const [firstRequest] = engine.requests
  assert.ok(firstRequest)

  const system = firstRequest[0]
  assert.ok(system && system.role === 'system')
  assert.match(system.content, /describe_module/)
  assert.match(system.content, /<tool_call>/)

  // The second turn replays the call the model made. It reaches the engine
  // structurally, in the OpenAI field a hosted provider would read; it is the
  // web-llm engine that renders it back into text, because web-llm's own prompt
  // builder discards `tool_calls` and would show the model a tool result
  // answering nothing.
  const secondRequest = engine.requests[1]
  assert.ok(secondRequest)

  const replayed = secondRequest.find(message => message.role === 'assistant')
  assert.ok(replayed, 'the assistant turn that made the call has to be replayed')
  assert.equal(replayed.tool_calls?.[0]?.function.name, 'list_modules')
  assert.match(renderAssistantToolCalls(replayed), /<tool_call>\{"name":"list_modules"/)

  const toolTurn = secondRequest.find(message => message.role === 'tool')
  assert.ok(toolTurn)
  assert.match(toolTurn.content, /AppModule/)
}

// --- a model that will not stop ---------------------------------------------
{
  // Every turn calls the same tool again, which is exactly the failure a small
  // model produces and the reason the cap exists.
  const engine = scriptedEngine([[toolCall('list_modules')]])

  const events: GraphAgentEvent[] = []
  const result = await runGraphAgent(
    {
      engine,
      modelId: 'Qwen3-1.7B-q4f16_1-MLC',
      graph: buildGraph(),
      messages: [{ role: 'user', content: 'how many modules?' }],
      maxSteps: 2
    },
    event => events.push(event)
  )

  assert.equal(result.stoppedAtLimit, true)
  assert.ok(result.toolCallCount >= 2)

  const stopped = events.find(event => event.type === 'stopped')
  assert.ok(stopped && stopped.type === 'stopped')
  assert.match(stopped.text, /I stopped after \d+ tool calls/)
  assert.match(stopped.text, /larger model/)

  // Giving up is not an error: nothing was thrown, and the loop said what it
  // did rather than handing the panel a stack trace.
  assert.equal(DEFAULT_GRAPH_AGENT_MAX_STEPS > 2, true)
}

// --- a reply that is not a tool call at all ----------------------------------
{
  const engine = scriptedEngine([['AppModule imports UserModule.']])

  const events: GraphAgentEvent[] = []
  const result = await runGraphAgent(
    {
      engine,
      modelId: 'Qwen3-1.7B-q4f16_1-MLC',
      graph: buildGraph(),
      messages: [{ role: 'user', content: 'hello' }]
    },
    event => events.push(event)
  )

  assert.equal(result.toolCallCount, 0)
  assert.equal(result.text, 'AppModule imports UserModule.')
  assert.equal(events.some(event => event.type === 'tool-call'), false)
}

// --- an answer after a tool result replaces the turn before it ---------------
{
  // The model narrates, calls, and then answers. The second turn must not be
  // appended to the first, or the panel renders a reply that argues with itself.
  const engine = scriptedEngine([
    ['Let me look. ', toolCall('list_modules')],
    ['There are two modules.']
  ])

  const events: GraphAgentEvent[] = []
  const result = await runGraphAgent(
    {
      engine,
      modelId: 'Qwen3-1.7B-q4f16_1-MLC',
      graph: buildGraph(),
      messages: [{ role: 'user', content: 'how many modules?' }]
    },
    event => events.push(event)
  )

  assert.equal(result.text, 'There are two modules.')

  const answers = events.filter(event => event.type === 'answer').map(event => event.text)
  assert.ok(answers.includes('Let me look. '))
  assert.ok(answers.includes('There are two modules.'))
  assert.equal(answers.some(text => text.includes('Let me look. There are')), false)
}

// --- a handler that throws stops the run ------------------------------------
{
  // How the panel abandons a model that thinks without ever answering.
  class StopError extends Error {}

  const engine = scriptedEngine([['thinking and thinking']])

  await assert.rejects(
    runGraphAgent(
      {
        engine,
        modelId: 'Qwen3-1.7B-q4f16_1-MLC',
        graph: buildGraph(),
        messages: [{ role: 'user', content: 'hello' }]
      },
      () => {
        throw new StopError('enough')
      }
    ),
    StopError
  )
}

// --- and the run it stopped is actually over --------------------------------
{
  // Leaving the stream by a throw only closes the iterator on this side.
  // Without the cancel, the graph kept taking turns in the background: the
  // panel's thinking-off retry then queued behind a loop it thought it had
  // abandoned, on the same per-model lock the retry was waiting for.
  class StopError extends Error {}

  const engine = scriptedEngine([['narrating ', toolCall('list_modules')]])

  await assert.rejects(
    runGraphAgent(
      {
        engine,
        modelId: 'Qwen3-1.7B-q4f16_1-MLC',
        graph: buildGraph(),
        messages: [{ role: 'user', content: 'how many modules?' }]
      },
      (event) => {
        if (event.type === 'answer') {
          throw new StopError('enough')
        }
      }
    ),
    StopError
  )

  const atThrow = engine.requests.length

  // Long enough for another round trip to have started, if one were going to.
  await new Promise((resolve) => {
    setTimeout(resolve, 100)
  })

  assert.equal(engine.requests.length, atThrow)
}

// --- an aborted run stops rather than running out its steps ------------------
{
  // How the panel abandons a loop when the chat is restarted or the drawer is
  // closed. Interrupting the engine only ends the generation that is decoding;
  // the signal is what ends the loop.
  const engine = scriptedEngine([[toolCall('list_modules')]])
  const controller = new AbortController()

  await assert.rejects(
    runGraphAgent(
      {
        engine,
        modelId: 'Qwen3-1.7B-q4f16_1-MLC',
        graph: buildGraph(),
        messages: [{ role: 'user', content: 'how many modules?' }],
        signal: controller.signal
      },
      (event) => {
        if (event.type === 'tool-result') {
          controller.abort()
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      // The panel recognises the run as abandoned by this name and stays quiet
      // rather than reporting a generation failure nobody caused.
      assert.equal(error.name, 'AbortError')

      return true
    }
  )
}

// --- the step cap counts the answer as well as the lookups -------------------
{
  // A run that spends every one of its lookups must still get the turn that
  // writes the answer. Before, the limit aborted on exactly that call: the
  // panel rendered the finished answer and then put a notice under it saying no
  // answer had been reached.
  const engine = scriptedEngine([
    [toolCall('list_modules')],
    [toolCall('describe_module', { name: 'UserModule' })],
    ['UserModule declares UserService.']
  ])

  const events: GraphAgentEvent[] = []
  const result = await runGraphAgent(
    {
      engine,
      modelId: 'Qwen3-1.7B-q4f16_1-MLC',
      graph: buildGraph(),
      messages: [{ role: 'user', content: 'what is in UserModule?' }],
      maxSteps: 2
    },
    event => events.push(event)
  )

  assert.equal(result.stoppedAtLimit, false)
  assert.equal(result.toolCallCount, 2)
  assert.equal(result.text, 'UserModule declares UserService.')
  assert.equal(events.some(event => event.type === 'stopped'), false)
}

// --- the transcript budget ---------------------------------------------------

function transcript(...messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return [...messages]
}

function turn(type: string, content: string, toolCalls?: { name: string }[]): TranscriptMessage {
  return {
    getType: () => type,
    content,
    ...(toolCalls ? { tool_calls: toolCalls.map(call => ({ name: call.name, args: {} })) } : {})
  }
}

// Under budget, nothing moves. The loop's own traffic is only worth losing when
// keeping it would cost the answer.
{
  const messages = transcript(
    turn('human', 'which modules import UserModule?'),
    turn('ai', '', [{ name: 'list_modules' }]),
    turn('tool', 'AppModule, UserModule')
  )

  assert.deepEqual(budgetAgentTranscript(messages, 9000), messages)
}

// Over budget, whole rounds go — oldest first, the call and the result that
// answered it together, so the model is never shown a result responding to
// nothing.
{
  const messages = transcript(
    turn('human', 'which modules import UserModule?'),
    turn('ai', '', [{ name: 'list_modules' }]),
    turn('tool', 'x'.repeat(400)),
    turn('ai', '', [{ name: 'describe_module' }]),
    turn('tool', 'y'.repeat(400)),
    turn('ai', 'Only AppModule does.')
  )

  const kept = budgetAgentTranscript(messages, 600)

  assert.deepEqual(kept.map(message => message.getType()), ['human', 'ai', 'tool', 'ai'])
  assert.ok(kept.some(message => message.content === 'y'.repeat(400)))
  assert.ok(!kept.some(message => message.content === 'x'.repeat(400)))
}

// The newest round stays whatever it costs. A model asked to answer from a
// lookup that was deleted invents one; a model refusing an over-long prompt at
// least says so.
{
  const messages = transcript(
    turn('human', 'trace UserService'),
    turn('ai', '', [{ name: 'trace_dependencies' }]),
    turn('tool', 'z'.repeat(5000))
  )

  assert.equal(budgetAgentTranscript(messages, 100).length, 3)
}

// --- what the fixed part of an agent prompt costs ----------------------------
{
  // The panel budgets its history before the run starts, so the tool-schema
  // cost has to be a constant there rather than a measurement. This is the
  // measurement, and it fails if the schemas outgrow what the panel reserves.
  const { convertToOpenAITool } = await import('@langchain/core/utils/function_calling')
  const { buildToolPromptSection } = await import('./web-llm-langchain.ts')

  const tools = await createGraphAgentTools(buildGraph())
  const section = buildToolPromptSection(tools.map(tool => convertToOpenAITool(tool)))

  assert.ok(
    section.length <= GRAPH_AGENT_TOOL_PROMPT_CHARS,
    `the tool prompt is ${section.length} chars against a reserve of ${GRAPH_AGENT_TOOL_PROMPT_CHARS}`
  )

  // And the reserve covers more than the fixed prompt: the loop adds a replayed
  // call and a full lookup on every round, into the same window.
  const reserve = estimateGraphAgentPromptChars(buildGraph())

  assert.ok(reserve > section.length + buildGraphAgentSystemPrompt(buildGraph()).length)

  // Still leaving room for a conversation, or the reserve would have eaten the
  // question it is protecting.
  assert.ok(
    WEB_LLM_PROMPT_CHAR_BUDGET - reserve > 3000,
    `the reserve of ${reserve} leaves only ${WEB_LLM_PROMPT_CHAR_BUDGET - reserve} chars for the conversation`
  )
}

console.log('graph-agent-run.test.ts ok')
