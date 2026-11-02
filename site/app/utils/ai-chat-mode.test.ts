import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  AI_CHAT_GRAPH_CHANGED_NOTICE,
  AI_CHAT_GRAPH_FILE_MODE_REASON,
  isAskedGraphOnScreen,
  resolveAiChatAnswerMode,
  resolveAiChatFetch
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

describe('what the AI chat fetches', () => {
  // A graph file has no endpoint: nothing may be fetched on its behalf, from
  // an address that is empty or, worse, left over from another graph.
  test('nothing for a graph file, as the panel opens or before an answer', () => {
    for (const agent of [undefined, false, true]) {
      assert.equal(resolveAiChatFetch({ isGraphFile: true, agent }), null, String(agent))
    }
  })

  test('an endpoint\'s Markdown as the panel opens, and what the answer reads before it', () => {
    assert.equal(resolveAiChatFetch({ isGraphFile: false }), 'markdown')
    assert.equal(resolveAiChatFetch({ isGraphFile: false, agent: false }), 'markdown')
    assert.equal(resolveAiChatFetch({ isGraphFile: false, agent: true }), 'json')
  })
})

describe('the graph a question was asked about', () => {
  const ENDPOINT = 'http://localhost:53371/__graph-inspector'
  const asked = { revision: 4, endpointUrl: ENDPOINT }

  test('is still on screen while the viewer has not moved', () => {
    assert.equal(isAskedGraphOnScreen(asked, { revision: 4, endpointUrl: ENDPOINT }), true)
    assert.equal(isAskedGraphOnScreen({ revision: 7, endpointUrl: '' }, { revision: 7, endpointUrl: '' }), true)
  })

  // Another endpoint, a graph file, or the same file opened again.
  test('is gone once the viewer is put on another graph', () => {
    assert.equal(isAskedGraphOnScreen(asked, { revision: 5, endpointUrl: ENDPOINT }), false)
    assert.equal(isAskedGraphOnScreen(asked, { revision: 5, endpointUrl: '' }), false)
    assert.equal(isAskedGraphOnScreen({ revision: 7, endpointUrl: '' }, { revision: 8, endpointUrl: '' }), false)
  })

  // Letting an endpoint go leaves the revision where it was.
  test('is gone once its endpoint has been let go', () => {
    assert.equal(isAskedGraphOnScreen(asked, { revision: 4, endpointUrl: '' }), false)
  })

  test('the notice says why there is no answer, and what to do', () => {
    assert.match(AI_CHAT_GRAPH_CHANGED_NOTICE, /another graph/)
    assert.match(AI_CHAT_GRAPH_CHANGED_NOTICE, /Ask again/)
  })
})
