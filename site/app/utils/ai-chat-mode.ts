/**
 * Why the AI chat cannot answer from a graph excerpt on a graph file.
 */
export const AI_CHAT_GRAPH_FILE_MODE_REASON
  = 'A graph file carries no Markdown summary, so the chat looks things up in the graph instead.'

/** How the AI chat answers, and whether the reader may change that. */
export type AiChatAnswerMode = {
  /** Answers by looking things up in the graph with tools. */
  agent: boolean
  /** Why the reader cannot switch to the other mode; absent when they can. */
  lockedReason?: string
}

/**
 * TODO(t_f2e5c392): stub reproducing today's panel — the reader's choice, else
 * whichever mode suits the graph's size, with no graph-file case.
 */
export function resolveAiChatAnswerMode(input: {
  isGraphFile: boolean
  /** The reader's own choice, once they have made one. */
  override?: boolean
  /** Whether looking things up suits this graph better than an excerpt. */
  prefersAgent: boolean
}): AiChatAnswerMode {
  return { agent: input.override ?? input.prefersAgent }
}
