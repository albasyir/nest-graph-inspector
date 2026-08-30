import { strict as assert } from 'node:assert'
import {
  WEB_LLM_GRAPH_MARKDOWN_CHAR_BUDGET,
  WEB_LLM_PROMPT_CHAR_BUDGET,
  budgetChatHistory,
  buildGraphContext,
  buildWebLlmSystemPrompt,
  isContextWindowOverflow
} from './web-llm-context.ts'

assert.equal(WEB_LLM_GRAPH_MARKDOWN_CHAR_BUDGET, 6000)

const MERMAID_BLOCK = [
  '```mermaid',
  'graph TD',
  '  subgraph module_group_AppModule["AppModule"]',
  '  end',
  '  module_group_AppModule --> module_group_UserModule',
  '```'
].join('\n')

function moduleSection(name: string, providerCount: number) {
  return [
    `## ${name}`,
    '',
    `${name} is an example feature module.`,
    '',
    '### Providers',
    ...Array.from({ length: providerCount }, (_, index) => `- ${name}Provider${index}`)
  ].join('\n')
}

const GRAPH = [
  '# NestJS Dependency Graph',
  '',
  MERMAID_BLOCK,
  '',
  '> Arrow direction: `A --> B` means `A` depends on `B`.',
  '',
  moduleSection('AppModule', 2),
  '',
  moduleSection('UserModule', 3),
  '',
  moduleSection('OrderModule', 2)
].join('\n')

// The mermaid block is rendering instruction: the same edges are spelled out in
// the module sections, so it is a third of the document that teaches the model
// nothing.
const whole = buildGraphContext(GRAPH)
assert.equal(whole.truncated, false)
assert.equal(whole.omittedModuleCount, 0)
assert.ok(!whole.text.includes('```'))
assert.ok(!whole.text.includes('subgraph'))
assert.ok(whole.text.startsWith('# NestJS Dependency Graph'))
assert.ok(whole.text.includes('> Arrow direction'))
assert.ok(whole.text.includes('## AppModule'))
assert.ok(whole.text.includes('## OrderModule'))

// Stripping the block must not leave the run of blank lines it stood in.
assert.ok(!whole.text.includes('\n\n\n'))

// A graph with no diagram at all is the common case for a hand-written fixture,
// and must come back untouched.
const noMermaid = buildGraphContext(['# NestJS Dependency Graph', '', moduleSection('AppModule', 1)].join('\n'))
assert.equal(noMermaid.truncated, false)
assert.ok(noMermaid.text.includes('## AppModule'))
assert.ok(noMermaid.text.startsWith('# NestJS Dependency Graph'))

// A document that is nothing but a diagram has nothing left to say once the
// diagram is gone.
assert.deepEqual(buildGraphContext(MERMAID_BLOCK), {
  text: '',
  truncated: false,
  omittedModuleCount: 0
})

// An unterminated fence swallows the rest of the document, which is right:
// everything after it is diagram source too.
assert.deepEqual(buildGraphContext('# NestJS Dependency Graph\n\n```mermaid\ngraph TD\n  a --> b'), {
  text: '# NestJS Dependency Graph',
  truncated: false,
  omittedModuleCount: 0
})

// Nothing to send is not an error — the panel asks for a prompt before the
// graph Markdown has loaded.
for (const empty of ['', '   ', '\n\n\t\n']) {
  assert.deepEqual(
    buildGraphContext(empty),
    { text: '', truncated: false, omittedModuleCount: 0 },
    `${JSON.stringify(empty)} should yield no context`
  )
}

// Exactly on budget is not over it.
const HEAD = '# NestJS Dependency Graph'
const onBudget = buildGraphContext(HEAD, HEAD.length)
assert.equal(onBudget.text, HEAD)
assert.equal(onBudget.truncated, false)

// Sections are kept whole and in order until the budget runs out, and the count
// of what was dropped has to match what is missing.
const trimmed = buildGraphContext(GRAPH, 200)
assert.ok(trimmed.truncated)
assert.ok(trimmed.text.startsWith('# NestJS Dependency Graph'))
assert.ok(trimmed.text.includes('## AppModule'))
assert.ok(!trimmed.text.includes('## OrderModule'))
assert.equal(trimmed.omittedModuleCount, 2)
assert.ok(trimmed.text.length <= 200)

// Dropping every module still keeps the heading: an excerpt the model cannot
// place is worse than a heading with nothing under it.
const headingOnly = buildGraphContext(GRAPH, 60)
assert.equal(headingOnly.omittedModuleCount, 3)
assert.ok(headingOnly.truncated)
assert.ok(headingOnly.text.startsWith('# NestJS Dependency Graph'))
assert.ok(!headingOnly.text.includes('## '))

// A single module larger than the whole budget takes the modules behind it with
// it, because the excerpt stays a contiguous prefix rather than a cherry-picked
// set the disclosure line could not describe.
const oneHugeModule = [
  '# NestJS Dependency Graph',
  '',
  moduleSection('HugeModule', 400),
  '',
  moduleSection('TinyModule', 1)
].join('\n')
const hugeFirst = buildGraphContext(oneHugeModule, 1000)
assert.equal(hugeFirst.omittedModuleCount, 2)
assert.ok(!hugeFirst.text.includes('## HugeModule'))
assert.ok(!hugeFirst.text.includes('## TinyModule'))

// `### Providers` is not a module boundary — cutting there would strand a
// module's own subsections under the module before it.
const trimmedLines = trimmed.text.split('\n')
assert.equal(trimmedLines.filter(line => line.startsWith('## ') && !line.startsWith('###')).length, 1)

// A heading longer than the budget is kept anyway, and no module was dropped to
// make room for it, so nothing is disclosed.
const oversizedHeading = buildGraphContext('# NestJS Dependency Graph\n\nA very long preamble indeed.', 10)
assert.equal(oversizedHeading.truncated, false)
assert.equal(oversizedHeading.omittedModuleCount, 0)
assert.ok(oversizedHeading.text.includes('A very long preamble indeed.'))

// The instructions are load-bearing: they are what keeps an answer grounded in
// the graph instead of in the model's own idea of NestJS.
const prompt = buildWebLlmSystemPrompt(GRAPH)
for (const instruction of [
  '# Nest Graph Inspector AI Assistant',
  '- Use only the dependency graph markdown below as your source of truth.',
  '- When the graph does not contain enough information, say what is missing instead of guessing.',
  '- Keep answers concise and mention exact module/provider/controller names from the graph.',
  '- Format user-facing answers with GitHub-flavored Markdown.',
  '- Do not return JSON.',
  '- Keep any model thinking brief, then provide the final answer.',
  '## Dependency Graph Markdown'
]) {
  assert.ok(prompt.includes(instruction), `system prompt should keep ${JSON.stringify(instruction)}`)
}
assert.ok(prompt.includes('## AppModule'))
assert.ok(!prompt.includes('```mermaid'))
assert.ok(!prompt.includes('fits the context window'))

// No graph yet has to be said out loud, or the model answers about the
// instructions instead.
const emptyPrompt = buildWebLlmSystemPrompt('')
assert.ok(emptyPrompt.includes('_No graph markdown is available yet._'))
assert.ok(!emptyPrompt.includes('fits the context window'))

// A trimmed graph is disclosed to the model, with the count and the right verb.
const trimmedPrompt = buildWebLlmSystemPrompt(GRAPH, 200)
assert.ok(trimmedPrompt.includes('2 module sections were left out'))
assert.ok(trimmedPrompt.trimEnd().endsWith('rather than guessing._'))

const singlePrompt = buildWebLlmSystemPrompt(GRAPH, 340)
assert.equal(buildGraphContext(GRAPH, 340).omittedModuleCount, 1)
assert.ok(singlePrompt.includes('1 module section was left out'))

assert.equal(WEB_LLM_PROMPT_CHAR_BUDGET, 9000)

// The whole point of the history budget: a conversation that fits is untouched,
// so an ordinary chat behaves exactly as it did before there was a budget.
const shortHistory = [
  { role: 'user', content: 'Which modules import UserModule?' },
  { role: 'assistant', content: 'AppModule and BillingModule.' },
  { role: 'user', content: 'And which providers does it export?' }
]

assert.deepEqual(budgetChatHistory(shortHistory, 3655), {
  messages: shortHistory,
  droppedMessageCount: 0
})

// Once it does not fit, the oldest turns go and the newest stay — asking the
// same question again has to keep working rather than failing harder each time.
const longHistory = Array.from({ length: 20 }, (_value, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `turn ${index} `.padEnd(500, 'x')
}))
const budgeted = budgetChatHistory(longHistory, 6742)

assert.ok(budgeted.messages.length < longHistory.length)
assert.ok(budgeted.droppedMessageCount > 0)
assert.equal(budgeted.messages.length + budgeted.droppedMessageCount, longHistory.length)
assert.equal(budgeted.messages.at(-1), longHistory.at(-1))
assert.deepEqual(budgeted.messages, longHistory.slice(-budgeted.messages.length))

const budgetedChars = budgeted.messages.reduce((total, message) => total + message.content.length, 0)
assert.ok(6742 + budgetedChars <= WEB_LLM_PROMPT_CHAR_BUDGET, 'the kept turns have to fit beside the system prompt')

// The question just asked is never the one dropped: a prompt with nothing to
// answer is not a smaller request, it is a broken one.
const oversizedQuestion = [{ role: 'user', content: 'x'.repeat(20000) }]

assert.deepEqual(budgetChatHistory(oversizedQuestion, 6742), {
  messages: oversizedQuestion,
  droppedMessageCount: 0
})

// A system prompt that already fills the window leaves room for the question
// and nothing else, rather than going negative and dropping everything.
assert.equal(budgetChatHistory(shortHistory, 99999).messages.length, 1)
assert.deepEqual(budgetChatHistory([], 100), { messages: [], droppedMessageCount: 0 })

// The overflow arrives from the inference worker, which serialises it with
// `toString()` — so the class name only survives inside the text.
assert.ok(isContextWindowOverflow('ContextWindowSizeExceededError: prompt tokens exceed context window size'))
assert.ok(isContextWindowOverflow(new Error('ContextWindowSizeExceededError: 4200 > 4096')))
assert.ok(isContextWindowOverflow('Error: the prompt is longer than the context window size (4096)'))
assert.equal(isContextWindowOverflow('Failed to fetch dynamically imported module'), false)
assert.equal(isContextWindowOverflow(new Error('WebGPU device lost')), false)
for (const nonsense of [undefined, null, 0, {}, []]) {
  assert.equal(isContextWindowOverflow(nonsense), false)
}

console.log('web-llm-context.test.ts ok')
