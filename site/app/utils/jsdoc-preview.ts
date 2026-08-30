/**
 * Turns the `jsdoc` string carried by a graph node into something renderable.
 *
 * The library extracts a class's comment with ts-morph and hands over its
 * description text — block tags such as `@param` are dropped there, so what
 * arrives is prose: hard-wrapped lines, bullet lists, `{@link}` references, or
 * nothing at all. The viewer shows it in a card a few hundred pixels wide, and
 * re-wrapping an author's line breaks is the difference between a paragraph and
 * a ragged column, so the text is parsed into blocks here rather than dropped
 * into the DOM as-is.
 */

/** One renderable piece of a JSDoc comment. */
export type JsDocPreviewBlock
  = | { kind: 'paragraph', text: string }
    | { kind: 'list', items: string[] }

/** A bullet written as `-`, `*` or `+`, the way Markdown does it. */
const LIST_ITEM_PATTERN = /^[-*+][ \t]+(.*)$/
/** `{@link Target}`, `{@link Target label}` or `{@link Target|label}`. */
const INLINE_LINK_PATTERN = /\{@(?:link|linkcode|linkplain)[ \t]+([^}]+)\}/g
/** The `*` column of a comment block, in case an unstripped comment arrives. */
const COMMENT_GUTTER_PATTERN = /^[ \t]*\*[ \t]?/

/**
 * Strips a raw comment-block wrapper, or returns `null` when there is none.
 *
 * A leading `*` is ambiguous — it opens a comment gutter and a Markdown bullet
 * alike — and guessing between them from the lines alone gets bullet lists
 * wrong. The delimiters are not ambiguous, so they are what decides: only text
 * that is literally a comment block has its gutter stripped, and a description
 * written entirely as `*` bullets keeps every marker. The library hands over
 * comment *text*, so this normally finds nothing; it is here so a comment read
 * from somewhere else still renders.
 */
function unwrapRawComment(comment: string): string | null {
  const trimmed = comment.trim()

  if (!trimmed.startsWith('/*') || !trimmed.endsWith('*/')) {
    return null
  }

  return trimmed
    .slice(2, -2)
    // `/**` opens a doc comment; the third character belongs to the delimiter.
    .replace(/^\*/, '')
    .split('\n')
    .map(line => line.replace(COMMENT_GUTTER_PATTERN, ''))
    .join('\n')
}

/**
 * Replaces `{@link}` references with the text a reader should see.
 *
 * The viewer has nowhere to navigate to — the graph knows class names, not
 * source locations — so a link becomes its label, or its target when it has no
 * label.
 */
function renderInlineLinks(text: string): string {
  return text.replace(INLINE_LINK_PATTERN, (_match, reference: string) => {
    const [target = '', ...rest] = reference.trim().split(/[|\s]+/)
    return rest.length > 0 ? rest.join(' ') : target
  })
}

/** One line as the card should read it: links resolved, indentation gone. */
function normalizeLine(line: string): string {
  return renderInlineLinks(line).trim()
}

/** Joins a hard-wrapped paragraph back into one line the card can re-wrap. */
function joinWrappedLines(lines: string[]): string {
  return lines.join(' ').replace(/\s+/g, ' ').trim()
}

type PreviewParserState = {
  blocks: JsDocPreviewBlock[]
  paragraph: string[]
  list: string[][]
}

/** Closes the paragraph being collected, dropping it when it is empty. */
function flushParagraph(state: PreviewParserState): void {
  const text = joinWrappedLines(state.paragraph)
  state.paragraph = []

  if (text) {
    state.blocks.push({ kind: 'paragraph', text })
  }
}

/** Closes the bullet list being collected, dropping it when it is empty. */
function flushList(state: PreviewParserState): void {
  const items = state.list
    .map(joinWrappedLines)
    .filter(item => item.length > 0)
  state.list = []

  if (items.length > 0) {
    state.blocks.push({ kind: 'list', items })
  }
}

/**
 * Parses a class-level JSDoc comment into the blocks the hover card renders.
 *
 * Anything that is not a string, or holds nothing but whitespace, parses to an
 * empty list — the caller shows no card at all in that case, rather than an
 * empty one.
 */
export function parseJsDocPreview(
  jsdoc: string | null | undefined
): JsDocPreviewBlock[] {
  if (typeof jsdoc !== 'string') {
    return []
  }

  const state: PreviewParserState = { blocks: [], paragraph: [], list: [] }
  const text = jsdoc.replace(/\r\n?/g, '\n')

  for (const rawLine of (unwrapRawComment(text) ?? text).split('\n')) {
    const line = normalizeLine(rawLine)

    if (!line) {
      flushParagraph(state)
      flushList(state)
      continue
    }

    const listItem = LIST_ITEM_PATTERN.exec(line)
    if (listItem) {
      flushParagraph(state)
      state.list.push([listItem[1] ?? ''])
      continue
    }

    // A continuation line belongs to whichever block is still open, so a
    // hard-wrapped bullet does not break into prose halfway through.
    const openListItem = state.list.at(-1)
    if (openListItem) {
      openListItem.push(line)
      continue
    }

    state.paragraph.push(line)
  }

  flushParagraph(state)
  flushList(state)

  return state.blocks
}

/** Whether a `jsdoc` value has anything worth showing on hover. */
export function hasJsDocPreview(jsdoc: string | null | undefined): boolean {
  return parseJsDocPreview(jsdoc).length > 0
}
