/**
 * Why the AI chat cannot answer from a graph excerpt on a graph file.
 *
 * The excerpt is cut from the Markdown summary a running inspector serves at
 * `/output.md`, which only the library writes — the site does not rebuild it —
 * while the tools read the graph JSON, which is what the file is.
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
 * How the AI chat answers the graph on screen.
 *
 * On an endpoint it is the reader's to choose, and until they do, the graph's
 * size chooses: looking things up wins once the graph outgrows the model's
 * context window, and an excerpt answers a small graph in a single turn. A
 * graph file can only be looked up in, so the chat does that, and says why the
 * reader cannot switch.
 */
export function resolveAiChatAnswerMode(input: {
  isGraphFile: boolean
  /** The reader's own choice, once they have made one. */
  override?: boolean
  /** Whether looking things up suits this graph better than an excerpt. */
  prefersAgent: boolean
}): AiChatAnswerMode {
  if (input.isGraphFile) {
    return { agent: true, lockedReason: AI_CHAT_GRAPH_FILE_MODE_REASON }
  }

  return { agent: input.override ?? input.prefersAgent }
}
