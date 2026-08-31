/**
 * Splitting a model's reply into its thinking and its answer.
 *
 * web-llm's streaming chunks carry only `delta.content` — there is no separate
 * reasoning field, the way a server-side runtime gives you one. Reasoning
 * models emit their thinking inline in that same content stream, wrapped in
 * `<think>`, so the only way to show it in its own collapsible is to parse the
 * text as it arrives.
 *
 * Two functions rather than one because a half-arrived tag means something
 * different mid-stream than it does at the end: while streaming, an unclosed
 * `<think>` means the model is still thinking, and once the stream is done it
 * means the model never got as far as an answer.
 *
 * `<reasoning>` and `<answer>` are handled alongside `<think>` because prompted
 * models reach for those spellings too, and a stray tag rendered into the chat
 * bubble is the failure this prevents.
 */

export type ParsedReply = {
  reasoning: string
  content: string
}

/**
 * The content of a closed tag, or `undefined` when the tag is not there at all.
 *
 * The two are worth telling apart for `<answer>`: a model that closed an empty
 * one answered with nothing, and treating that as "no answer tag" falls back to
 * the raw reply, which is the markup itself.
 */
function matchTaggedContent(content: string, tag: string): string | undefined {
  const match = content.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'))

  return match ? (match[1] ?? '').trim() : undefined
}

function getTaggedContent(content: string, tag: string) {
  return matchTaggedContent(content, tag) ?? ''
}

/** The final split, once the whole reply has arrived. */
export function parseAssistantReply(content: string): ParsedReply {
  const reasoning = getTaggedContent(content, 'reasoning') || getTaggedContent(content, 'think')
  const answer = matchTaggedContent(content, 'answer')

  if (answer !== undefined) {
    return {
      reasoning,
      content: answer
    }
  }

  return {
    reasoning,
    content: content
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/i, '')
      .replace(/<think>[\s\S]*?<\/think>/i, '')
      .trim()
  }
}

/**
 * The split to render mid-stream, where any of the tags may still be open.
 *
 * Index arithmetic rather than a regex: a regex needs a closing tag to match,
 * and the whole point here is the stretch of text after an opening tag whose
 * close has not arrived yet.
 */
export function parseStreamingAssistantReply(content: string): ParsedReply {
  const lowerContent = content.toLowerCase()
  const reasoningOpenTag = '<reasoning>'
  const reasoningCloseTag = '</reasoning>'
  const thinkOpenTag = '<think>'
  const thinkCloseTag = '</think>'
  const answerOpenTag = '<answer>'
  const answerCloseTag = '</answer>'
  const reasoningOpenIndex = lowerContent.indexOf(reasoningOpenTag)
  const reasoningCloseIndex = lowerContent.indexOf(reasoningCloseTag)
  const thinkOpenIndex = lowerContent.indexOf(thinkOpenTag)
  const thinkCloseIndex = lowerContent.indexOf(thinkCloseTag)
  const answerOpenIndex = lowerContent.indexOf(answerOpenTag)
  const answerCloseIndex = lowerContent.indexOf(answerCloseTag)
  const activeReasoningOpenTag = reasoningOpenIndex === -1 ? thinkOpenTag : reasoningOpenTag
  const activeReasoningCloseTag = reasoningOpenIndex === -1 ? thinkCloseTag : reasoningCloseTag
  const activeReasoningOpenIndex = reasoningOpenIndex === -1 ? thinkOpenIndex : reasoningOpenIndex
  const activeReasoningCloseIndex = reasoningOpenIndex === -1 ? thinkCloseIndex : reasoningCloseIndex

  const reasoning = activeReasoningOpenIndex === -1
    ? ''
    : content
        .slice(
          activeReasoningOpenIndex + activeReasoningOpenTag.length,
          activeReasoningCloseIndex === -1 ? content.length : activeReasoningCloseIndex
        )
        .trim()

  if (answerOpenIndex !== -1) {
    return {
      reasoning,
      content: content
        .slice(
          answerOpenIndex + answerOpenTag.length,
          answerCloseIndex === -1 ? content.length : answerCloseIndex
        )
        .trim()
    }
  }

  if (activeReasoningCloseIndex !== -1) {
    return {
      reasoning,
      content: content
        .slice(activeReasoningCloseIndex + activeReasoningCloseTag.length)
        .replace(new RegExp(answerOpenTag, 'gi'), '')
        .replace(new RegExp(answerCloseTag, 'gi'), '')
        .trim()
    }
  }

  return {
    reasoning,
    content: activeReasoningOpenIndex === -1
      ? content
          .replace(new RegExp(answerOpenTag, 'gi'), '')
          .replace(new RegExp(answerCloseTag, 'gi'), '')
          .trim()
      : ''
  }
}
