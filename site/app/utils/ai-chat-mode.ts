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

/**
 * What the chat fetches from the graph's endpoint. As the panel opens, the
 * Markdown summary: what an excerpt is cut from, and what says whether the
 * graph outgrows the model's window. Before an answer, what that answer's mode
 * reads — the JSON the tools look things up in, or the Markdown again. A graph
 * file was read whole as it opened and has no endpoint to ask, so nothing.
 */
export function resolveAiChatFetch(input: {
  isGraphFile: boolean
  /** The answer about to be given looks things up; absent as the panel opens. */
  agent?: boolean
}): 'markdown' | 'json' | null {
  if (input.isGraphFile) {
    return null
  }

  return input.agent ? 'json' : 'markdown'
}

/** The graph a question was asked about, as the viewer tells one from another. */
export type AskedGraph = {
  /** The graph store's `graphRevision` as the question was asked. */
  revision: number
  /** The graph's endpoint, empty for a graph file. */
  endpointUrl: string
}

/**
 * Whether the graph on screen is still the one a question was asked about.
 *
 * The revision moves whenever the viewer is put on another graph — another
 * endpoint, a graph file, the same file opened again. An endpoint let go
 * leaves the revision where it was, so the endpoint is compared as well.
 */
export function isAskedGraphOnScreen(asked: AskedGraph, onScreen: AskedGraph): boolean {
  return asked.revision === onScreen.revision && asked.endpointUrl === onScreen.endpointUrl
}

/** What an answer says in its place when another graph went on screen first. */
export const AI_CHAT_GRAPH_CHANGED_NOTICE
  = 'Not answered: another graph opened while this question was being prepared. Ask again about the graph on screen.'
