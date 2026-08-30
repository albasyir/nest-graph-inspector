import { strict as assert } from 'node:assert'
import {
  TOOL_CALL_CLOSE_TAG,
  TOOL_CALL_OPEN_TAG,
  TOOL_RESPONSE_CLOSE_TAG,
  TOOL_RESPONSE_OPEN_TAG,
  renderAssistantToolCalls,
  toWebLlmTemplateMessages
} from './web-llm-boundary.ts'

function call(name: string, args: string) {
  return { id: `call_${name}`, type: 'function' as const, function: { name, arguments: args } }
}

// A turn with nothing to replay is left exactly as it is.
{
  assert.equal(
    renderAssistantToolCalls({ role: 'assistant', content: 'AppModule imports UserModule.' }),
    'AppModule imports UserModule.'
  )

  assert.equal(renderAssistantToolCalls({ role: 'assistant', content: '', tool_calls: [] }), '')
}

// A call with no narration around it becomes the block the model wrote, so the
// transcript web-llm rebuilds is the conversation that actually happened.
{
  assert.equal(
    renderAssistantToolCalls({
      role: 'assistant',
      content: '',
      tool_calls: [call('describe_module', '{"name":"UserModule"}')]
    }),
    `${TOOL_CALL_OPEN_TAG}{"name":"describe_module","arguments":{"name":"UserModule"}}${TOOL_CALL_CLOSE_TAG}`
  )
}

// Arguments are re-parsed rather than interpolated: embedding the JSON string
// as one would show the model an escaped string where it wrote an object.
{
  const rendered = renderAssistantToolCalls({
    role: 'assistant',
    content: '',
    tool_calls: [call('trace_dependencies', '{"name":"UserService","maxDepth":2}')]
  })

  assert.ok(rendered.includes('"maxDepth":2'))
  assert.ok(!rendered.includes('\\"'))
}

// A model that narrated its call keeps the narration, and the call follows it.
{
  const rendered = renderAssistantToolCalls({
    role: 'assistant',
    content: 'Let me look that up.',
    tool_calls: [call('list_modules', '{}')]
  })

  assert.ok(rendered.startsWith('Let me look that up.\n'))
  assert.ok(rendered.includes(`${TOOL_CALL_OPEN_TAG}{"name":"list_modules","arguments":{}}`))
}

// Two calls in one turn are both replayed, in order.
{
  const rendered = renderAssistantToolCalls({
    role: 'assistant',
    content: '',
    tool_calls: [call('list_modules', '{}'), call('find_cycles', '{}')]
  })

  assert.ok(rendered.indexOf('list_modules') < rendered.indexOf('find_cycles'))
  assert.equal(rendered.split(TOOL_CALL_OPEN_TAG).length - 1, 2)
}

// Arguments that are not JSON are replayed verbatim rather than dropped: what
// the model actually wrote is the honest thing to show it again.
{
  const rendered = renderAssistantToolCalls({
    role: 'assistant',
    content: '',
    tool_calls: [call('search_graph', 'not json at all')]
  })

  assert.ok(rendered.includes('"arguments":"not json at all"'))
}

// --- the transcript web-llm's chat templates will actually take --------------

// The `tool` role never reaches web-llm. Four of the eight curated models —
// including the recommended default — declare only `user` and `assistant` in
// their chat template, and web-llm throws `Role is not supported: tool` rather
// than falling back, which took agent mode down on the model it is tuned for.
{
  const rendered = toWebLlmTemplateMessages([
    { role: 'system', content: 'You answer questions about a graph.' },
    { role: 'user', content: 'what is in UserModule?' },
    { role: 'assistant', content: '', tool_calls: [call('describe_module', '{"name":"UserModule"}')] },
    { role: 'tool', content: 'UserModule provides UserService.', tool_call_id: 'call_describe_module' }
  ])

  assert.deepEqual(rendered.map(message => message.role), ['system', 'user', 'assistant', 'user'])

  // The result is still legible as a result, in the shape the same prompt
  // format pairs with `<tool_call>`.
  assert.equal(
    rendered[3]?.content,
    `${TOOL_RESPONSE_OPEN_TAG}UserModule provides UserService.${TOOL_RESPONSE_CLOSE_TAG}`
  )

  // And the call it answers is still on the assistant turn before it, so the
  // transcript the model reads is the conversation that happened.
  assert.ok(rendered[2]?.content.includes(`${TOOL_CALL_OPEN_TAG}{"name":"describe_module"`))
}

// web-llm insists the last message be a `user` turn, which a rewritten tool
// result satisfies and the `tool` role only satisfied on half the catalog.
{
  const rendered = toWebLlmTemplateMessages([
    { role: 'user', content: 'hello' },
    { role: 'tool', content: 'two modules', tool_call_id: 'webllm_call_0' }
  ])

  assert.equal(rendered.at(-1)?.role, 'user')
}

console.log('web-llm-boundary.test.ts ok')
