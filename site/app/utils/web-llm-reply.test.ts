import { strict as assert } from 'node:assert'
import { parseAssistantReply, parseStreamingAssistantReply } from './web-llm-reply.ts'

// Nothing tagged is the plain case, and must not lose or gain anything.
assert.deepEqual(parseStreamingAssistantReply('AppModule imports UserModule.'), {
  reasoning: '',
  content: 'AppModule imports UserModule.'
})
assert.deepEqual(parseAssistantReply('AppModule imports UserModule.'), {
  reasoning: '',
  content: 'AppModule imports UserModule.'
})
assert.deepEqual(parseStreamingAssistantReply(''), { reasoning: '', content: '' })
assert.deepEqual(parseAssistantReply(''), { reasoning: '', content: '' })

// `enable_thinking: false` does not stop web-llm emitting the tags — it prepends
// an EMPTY `<think>\n\n</think>\n\n` pair. Both halves have to come out clean,
// or every answer starts with a stray tag and an empty reasoning collapsible.
const suppressed = '<think>\n\n</think>\n\nAppModule imports UserModule.'
assert.deepEqual(parseStreamingAssistantReply(suppressed), {
  reasoning: '',
  content: 'AppModule imports UserModule.'
})
assert.deepEqual(parseAssistantReply(suppressed), {
  reasoning: '',
  content: 'AppModule imports UserModule.'
})

// The same pair arriving one chunk at a time must never render as markup.
for (const partial of ['<think>', '<think>\n', '<think>\n\n', '<think>\n\n</think>', '<think>\n\n</think>\n\n']) {
  const parsed = parseStreamingAssistantReply(partial)
  assert.equal(parsed.reasoning, '', `${JSON.stringify(partial)} should have no reasoning`)
  assert.equal(parsed.content, '', `${JSON.stringify(partial)} should have no content yet`)
}

// A `<think>` that has not closed yet is the model still thinking: show the
// thinking, show no answer.
assert.deepEqual(parseStreamingAssistantReply('<think>Tracing UserService back to'), {
  reasoning: 'Tracing UserService back to',
  content: ''
})

// Once it closes, everything after it is the answer.
assert.deepEqual(
  parseStreamingAssistantReply('<think>Tracing UserService.</think>UserService lives in UserModule.'),
  {
    reasoning: 'Tracing UserService.',
    content: 'UserService lives in UserModule.'
  }
)

// A `<think>` that never closes at all still yields its thinking at the end,
// and an empty answer rather than the thinking leaking into the bubble.
assert.deepEqual(parseAssistantReply('<think>Tracing UserService back to'), {
  reasoning: '',
  content: '<think>Tracing UserService back to'
})
assert.deepEqual(parseStreamingAssistantReply('<think>Tracing UserService back to'), {
  reasoning: 'Tracing UserService back to',
  content: ''
})

// `<reasoning>` is the other spelling prompted models reach for, and it wins
// over `<think>` when both are present.
assert.deepEqual(
  parseStreamingAssistantReply('<reasoning>Checking imports.</reasoning>UserModule imports MobileModule.'),
  {
    reasoning: 'Checking imports.',
    content: 'UserModule imports MobileModule.'
  }
)
assert.deepEqual(
  parseAssistantReply('<reasoning>Checking imports.</reasoning>UserModule imports MobileModule.'),
  {
    reasoning: 'Checking imports.',
    content: 'UserModule imports MobileModule.'
  }
)

// `<answer>` names the answer explicitly, so nothing outside it is one.
assert.deepEqual(
  parseStreamingAssistantReply('<think>Checking.</think><answer>UserModule.</answer>trailing noise'),
  {
    reasoning: 'Checking.',
    content: 'UserModule.'
  }
)
assert.deepEqual(
  parseAssistantReply('<think>Checking.</think><answer>UserModule.</answer>trailing noise'),
  {
    reasoning: 'Checking.',
    content: 'UserModule.'
  }
)

// `<answer>` with no close is the answer still streaming in.
assert.deepEqual(parseStreamingAssistantReply('<answer>UserModule imports'), {
  reasoning: '',
  content: 'UserModule imports'
})
assert.deepEqual(parseStreamingAssistantReply('<think>Checking.</think><answer>UserModule imports'), {
  reasoning: 'Checking.',
  content: 'UserModule imports'
})

// An `<answer>` anywhere in the reply claims the whole answer, and prose before
// it is preamble the model was not asked for: a reasoning model puts that
// preamble in front of the tag, and keeping it would show the thinking twice.
assert.equal(
  parseStreamingAssistantReply('Let me check. <answer>UserModule.</answer>').content,
  'UserModule.'
)

// With no `<answer>` in sight, an `</answer>` on its own is a stray tag rather
// than a boundary, and must not be rendered.
assert.equal(
  parseStreamingAssistantReply('UserModule imports MobileModule.</answer>').content,
  'UserModule imports MobileModule.'
)

// Casing is the model's choice, not ours.
assert.deepEqual(parseStreamingAssistantReply('<THINK>Checking.</THINK>UserModule.'), {
  reasoning: 'Checking.',
  content: 'UserModule.'
})
assert.deepEqual(parseAssistantReply('<Think>Checking.</Think>UserModule.'), {
  reasoning: 'Checking.',
  content: 'UserModule.'
})

// Markdown in the answer survives — the chat renders it, so a mangled fence is
// a visible bug.
const withMarkdown = '<think>Short.</think>\n\n### UserModule\n\n- `UserService`\n- `UserRepository`'
assert.equal(
  parseStreamingAssistantReply(withMarkdown).content,
  '### UserModule\n\n- `UserService`\n- `UserRepository`'
)
assert.equal(
  parseAssistantReply(withMarkdown).content,
  '### UserModule\n\n- `UserService`\n- `UserRepository`'
)

console.log('web-llm-reply.test.ts ok')
