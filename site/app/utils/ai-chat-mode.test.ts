import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  AI_CHAT_GRAPH_FILE_MODE_REASON,
  resolveAiChatAnswerMode
} from './ai-chat-mode.ts'

describe('how the AI chat answers', () => {
  // The excerpt is cut from the Markdown summary a running inspector serves,
  // which a graph file does not carry and the site does not rebuild; the tools
  // read the graph JSON, which is what the file is.
  test('a graph file is looked up in, whatever the reader or the graph\'s size would choose', () => {
    for (const override of [undefined, false, true]) {
      for (const prefersAgent of [false, true]) {
        assert.deepEqual(
          resolveAiChatAnswerMode({ isGraphFile: true, override, prefersAgent }),
          { agent: true, lockedReason: AI_CHAT_GRAPH_FILE_MODE_REASON },
          `override ${override}, prefersAgent ${prefersAgent}`
        )
      }
    }
  })

  test('the reason names what a graph file lacks, and what the chat does instead', () => {
    assert.match(AI_CHAT_GRAPH_FILE_MODE_REASON, /graph file/)
    assert.match(AI_CHAT_GRAPH_FILE_MODE_REASON, /Markdown summary/)
    assert.match(AI_CHAT_GRAPH_FILE_MODE_REASON, /looks things up in the graph/)
  })

  test('an endpoint follows the graph\'s size until the reader chooses, and then the reader', () => {
    assert.deepEqual(resolveAiChatAnswerMode({ isGraphFile: false, prefersAgent: true }), { agent: true })
    assert.deepEqual(resolveAiChatAnswerMode({ isGraphFile: false, prefersAgent: false }), { agent: false })
    assert.deepEqual(
      resolveAiChatAnswerMode({ isGraphFile: false, override: false, prefersAgent: true }),
      { agent: false }
    )
    assert.deepEqual(
      resolveAiChatAnswerMode({ isGraphFile: false, override: true, prefersAgent: false }),
      { agent: true }
    )
  })
})
