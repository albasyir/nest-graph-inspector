/**
 * What the in-browser model actually gets to see, on both counts: how much of
 * the graph Markdown, and how much of the conversation.
 *
 * Every curated web-llm model has a 4096-token context window, and the system
 * prompt, the conversation so far and the generated answer all have to fit
 * inside it together. web-llm does not trim to make them fit — it throws
 * `ContextWindowSizeExceededError` — so anything sent has to be budgeted here
 * first. The Markdown the inspector emits is already 7 KB for the demo
 * application and grows with the graph, and a conversation only ever gets
 * longer, so neither can be handed over whole.
 *
 * Two things make that budget affordable. The Markdown opens with a `mermaid`
 * fenced block that is pure rendering instruction — the same edges are spelled
 * out in prose further down — so it costs a third of the document and teaches
 * the model nothing. And what remains is a list of self-contained `## Module`
 * sections, which means it can be cut at a section boundary instead of
 * mid-sentence.
 *
 * Deliberately free of browser APIs: this runs in the site's plain assertion
 * scripts as well as in the panel.
 */

export const WEB_LLM_GRAPH_MARKDOWN_CHAR_BUDGET = 6000

export type GraphContext = {
  /** The Markdown to hand the model. Empty when there is no graph yet. */
  text: string
  truncated: boolean
  omittedModuleCount: number
}

/** web-llm's own error name, and the sentence it puts in the message. */
const CONTEXT_WINDOW_OVERFLOW = /ContextWindowSizeExceeded|context window size/i

const MERMAID_FENCE_OPEN = /^\s*```\s*mermaid\b/i
const FENCE_CLOSE = /^\s*```\s*$/
const MODULE_HEADING = /^##\s+\S/
const SECTION_SEPARATOR = '\n\n'

function stripMermaidBlocks(markdown: string): string[] {
  const kept: string[] = []
  let insideMermaid = false

  for (const line of markdown.split(/\r?\n/)) {
    if (insideMermaid) {
      insideMermaid = !FENCE_CLOSE.test(line)
      continue
    }

    if (MERMAID_FENCE_OPEN.test(line)) {
      insideMermaid = true
      continue
    }

    kept.push(line)
  }

  return kept
}

function collapseBlankLines(lines: readonly string[]): string[] {
  const collapsed: string[] = []

  for (const line of lines) {
    // Removing the diagram leaves runs of blank lines where it used to be. One
    // is a paragraph break the model reads; three are budget spent on nothing.
    if (!line.trim() && !collapsed.at(-1)?.trim()) {
      continue
    }

    collapsed.push(line)
  }

  while (collapsed.length && !collapsed.at(-1)?.trim()) {
    collapsed.pop()
  }

  return collapsed
}

function splitModuleSections(lines: readonly string[]) {
  const sectionStarts: number[] = []

  lines.forEach((line, index) => {
    if (MODULE_HEADING.test(line)) {
      sectionStarts.push(index)
    }
  })

  return {
    // The `# NestJS Dependency Graph` heading and any prose before the first
    // module. Without it the excerpt reads as a fragment of an unknown
    // document.
    heading: lines.slice(0, sectionStarts[0] ?? lines.length).join('\n').trimEnd(),
    sections: sectionStarts.map((start, index) =>
      lines.slice(start, sectionStarts[index + 1] ?? lines.length).join('\n').trimEnd()
    )
  }
}

/**
 * Trims the graph Markdown to something a 4096-token model can hold.
 *
 * Drops the `mermaid` block, then keeps whole `## Module` sections until the
 * budget runs out — never half a section, because half a module's provider list
 * is worse than none of it. When the stripped Markdown already fits, nothing is
 * trimmed and nothing is reported as missing.
 *
 * The heading is kept even in the unlikely case that it alone is over budget:
 * dropping it would leave the model an excerpt it cannot place, and no module
 * was omitted to make room, so nothing is disclosed either.
 */
export function buildGraphContext(
  markdown: string,
  charBudget = WEB_LLM_GRAPH_MARKDOWN_CHAR_BUDGET
): GraphContext {
  const lines = collapseBlankLines(stripMermaidBlocks(markdown || ''))
  const stripped = lines.join('\n')

  if (!stripped.trim()) {
    return { text: '', truncated: false, omittedModuleCount: 0 }
  }

  if (stripped.length <= charBudget) {
    return { text: stripped, truncated: false, omittedModuleCount: 0 }
  }

  const { heading, sections } = splitModuleSections(lines)
  const parts = heading ? [heading] : []
  let used = heading.length
  let omittedModuleCount = 0

  for (const [index, section] of sections.entries()) {
    // Sections are kept as a contiguous prefix rather than packed in wherever
    // one happens to fit. The disclosure the system prompt carries can only say
    // *how many* modules are missing, and "the first N of them" is a claim the
    // reader can check against the viewer, while a cherry-picked set is not.
    if (used + section.length + SECTION_SEPARATOR.length > charBudget) {
      omittedModuleCount = sections.length - index
      break
    }

    parts.push(section)
    used += section.length + SECTION_SEPARATOR.length
  }

  return {
    text: parts.join(SECTION_SEPARATOR),
    truncated: omittedModuleCount > 0,
    omittedModuleCount
  }
}

/**
 * The system prompt the chat sends, with the graph context already budgeted.
 *
 * When the graph did not fit, the prompt says so and says how much is missing —
 * a model that knows its excerpt is partial answers "that module is not in what
 * I was given", which is the honest answer, instead of inventing one.
 */
export function buildWebLlmSystemPrompt(
  markdown: string,
  charBudget = WEB_LLM_GRAPH_MARKDOWN_CHAR_BUDGET
): string {
  const context = buildGraphContext(markdown, charBudget)

  const lines = [
    '# Nest Graph Inspector AI Assistant',
    '',
    '## Instructions',
    '',
    '- Use only the dependency graph markdown below as your source of truth.',
    '- Help users understand NestJS modules, imports, exports, controllers, providers, and dependency paths.',
    '- When the graph does not contain enough information, say what is missing instead of guessing.',
    '- Keep answers concise and mention exact module/provider/controller names from the graph.',
    '- Format user-facing answers with GitHub-flavored Markdown.',
    '- Do not return JSON.',
    '- Keep any model thinking brief, then provide the final answer.',
    '',
    '## Dependency Graph Markdown',
    '',
    context.text || '_No graph markdown is available yet._'
  ]

  if (context.truncated) {
    const omitted = context.omittedModuleCount === 1
      ? '1 module section was'
      : `${context.omittedModuleCount} module sections were`

    lines.push(
      '',
      `_Only part of this graph fits the context window: ${omitted} left out. If a question is about a module that is not listed above, say it is outside this excerpt rather than guessing._`
    )
  }

  return lines.join('\n')
}

/**
 * How many characters of prompt — system prompt and conversation together — a
 * 4096-token window holds.
 *
 * Derived rather than measured, because tokenizing in the panel would mean
 * loading the model's tokenizer to build a message. About a quarter of the
 * window is left for the answer itself, and the rest is converted at roughly
 * three characters per token, which is the pessimistic end for text this dense
 * in identifiers. Being wrong in this direction costs a few dropped turns;
 * being wrong in the other costs the whole request, because web-llm throws
 * `ContextWindowSizeExceededError` rather than trimming anything itself.
 */
export const WEB_LLM_PROMPT_CHAR_BUDGET = 9000

/** Roughly what a turn's role markers and separators add on top of its text. */
const MESSAGE_OVERHEAD_CHARS = 8

export type BudgetedChatHistory<TMessage> = {
  messages: TMessage[]
  droppedMessageCount: number
}

/**
 * The most recent turns that still fit beside the system prompt.
 *
 * A conversation only grows, and every curated model refuses outright once the
 * prompt passes its window — so without this the chat works for a while and
 * then fails permanently, with no error the user can act on. Oldest turns go
 * first, which is the part of a graph conversation least likely to be needed:
 * the question just asked is what the answer has to address.
 *
 * The newest message is kept whatever it costs. A conversation with nothing to
 * answer is not a smaller request, it is a broken one, and an over-long single
 * question is better refused by the model with its own error than silently
 * turned into an empty prompt.
 */
export function budgetChatHistory<TMessage extends { content: string }>(
  history: readonly TMessage[],
  systemPromptChars: number,
  promptCharBudget = WEB_LLM_PROMPT_CHAR_BUDGET
): BudgetedChatHistory<TMessage> {
  const available = Math.max(0, promptCharBudget - Math.max(0, systemPromptChars))
  const kept: TMessage[] = []
  let used = 0

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]

    if (!message) {
      continue
    }

    const cost = message.content.length + MESSAGE_OVERHEAD_CHARS

    if (kept.length && used + cost > available) {
      break
    }

    kept.unshift(message)
    used += cost
  }

  return { messages: kept, droppedMessageCount: history.length - kept.length }
}

/**
 * Whether a rejection is the model refusing a prompt longer than its window.
 *
 * Takes `unknown` because this arrives from the inference worker, which
 * serialises whatever went wrong with `toString()` — so what reaches the panel
 * is usually a bare string, and even when it is an `Error` the class name only
 * survives inside the message. Matching the text is the only thing that works.
 */
export function isContextWindowOverflow(cause: unknown): boolean {
  if (cause instanceof Error) {
    return CONTEXT_WINDOW_OVERFLOW.test(cause.message)
  }

  return typeof cause === 'string' && CONTEXT_WINDOW_OVERFLOW.test(cause)
}
