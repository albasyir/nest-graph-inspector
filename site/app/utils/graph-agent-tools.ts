/**
 * The dependency graph as something the model can *ask about*, rather than
 * something it has to be handed.
 *
 * The chat used to paste the graph Markdown into the system prompt and cut it
 * at 6000 characters, because every curated in-browser model has a 4096-token
 * window — see `web-llm-context.ts` for that budget. Whatever fell past the cut
 * did not exist as far as the model was concerned, and on a real application
 * that is most of the graph. A ReAct agent turns the arrangement around: the
 * model gets a handful of queries and spends its window on the two or three
 * modules the question is actually about.
 *
 * That only pays off if a tool call is never a dead end. Tool calling here does
 * not need a fine-tuned 7B model — the schemas go into the system prompt and the
 * decoder is constrained to a valid call — so the model on the other side of
 * these functions is as small as Qwen3 1.7B, and a small model recovers from a
 * bad result worst of all. It repeats the same call, or it invents an answer. So
 * every function replies in prose the model can act on: a near-miss name comes
 * back as a "did you mean" list, a name that belongs to the other lookup comes
 * back as the call to make instead, a token with no provider entry comes back
 * with what *is* known about it, and nothing throws.
 *
 * The same reasoning caps the tool list at six. Every schema is charged against
 * the window twice — once in the system prompt and once in each turn that
 * repeats it — and each extra tool is one more thing to choose wrongly between.
 *
 * The query layer is deliberately free of LangChain and of browser APIs, so the
 * site's plain assertion scripts can exercise it directly. LangChain is reached
 * only through the dynamic import inside `createGraphAgentTools`, because the
 * chat panel's module is compiled into the prerender bundle too.
 */

import type { ClientTool } from '@langchain/core/tools'
import type {
  GraphOutput,
  GraphOutputController,
  GraphOutputDependencyRef,
  GraphOutputModule,
  GraphOutputProvider
} from 'nest-graph-inspector'
import { z } from 'zod'
import { collectCircularDependencyIssues } from './circular-dependency-issues.ts'

/**
 * The panel calls these before the graph has loaded and after a failed reload,
 * so absence is a normal input rather than a caller mistake.
 */
type GraphInput = GraphOutput | null | undefined

/** Names on one line, as in a module's provider list. */
const MAX_INLINE_NAMES = 40
const MAX_SEARCH_MATCHES = 25
const MAX_TREE_LINES = 40
const MAX_CYCLES_LISTED = 15
const MAX_SUGGESTIONS = 8

/** How many modules declaring the same token get spelled out in full. */
const MAX_OCCURRENCES = 3

const MAX_DOC_CHARS = 160

export const DEFAULT_TRACE_DEPTH = 3
export const MAX_TRACE_DEPTH = 6

const NO_GRAPH = 'No graph is loaded yet, so there is nothing to look up.'

/**
 * Shortest name a partial match is allowed to hinge on. Below this a candidate
 * such as a two-letter token matches nearly every question that is asked.
 */
const MIN_PARTIAL_MATCH_LENGTH = 3

type ProviderLocation = {
  moduleName: string
  provider: GraphOutputProvider
}

type ControllerLocation = {
  moduleName: string
  controller: GraphOutputController
}

/** Anything with a name and an injection list — a provider or a controller. */
type Injector = {
  kind: 'provider' | 'controller'
  moduleName: string
  name: string
  jsdoc?: string
  dependencies: GraphOutputDependencyRef[]
  provider?: GraphOutputProvider
}

function moduleEntries(graph: GraphInput): [string, GraphOutputModule][] {
  return Object.entries(graph?.modules || {})
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)]
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function formatNames(names: readonly string[], cap = MAX_INLINE_NAMES): string {
  if (!names.length) {
    return 'none'
  }

  if (names.length <= cap) {
    return names.join(', ')
  }

  return `${names.slice(0, cap).join(', ')}, and ${names.length - cap} more`
}

/** `Providers (3): A, B, C` — the count spares the model from counting. */
function formatSection(label: string, names: readonly string[]): string {
  return `${label} (${names.length}): ${formatNames(names)}`
}

/**
 * A JSDoc block flattened to one line and clipped. Comments run to paragraphs
 * and the model is paying for every one of those characters twice — once to
 * read them and once in the window it no longer has for the answer.
 */
function formatDoc(jsdoc: string | undefined): string | null {
  const text = (jsdoc || '').replace(/\s+/g, ' ').trim()

  if (!text) {
    return null
  }

  return text.length <= MAX_DOC_CHARS
    ? text
    : `${text.slice(0, MAX_DOC_CHARS - 1)}…`
}

function qualify(name: string, moduleName: string): string {
  return `${name} from ${moduleName}`
}

/**
 * Case, punctuation and spacing removed, because the model is quoting a name it
 * read in prose. `UserService`, `userService`, `user_service` and
 * `the user service` all have to land on the same provider.
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function tokenize(query: string): string[] {
  return query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= MIN_PARTIAL_MATCH_LENGTH)
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let shared = 0

  while (shared < limit && left[shared] === right[shared]) {
    shared += 1
  }

  return shared
}

/**
 * The names worth offering when a lookup misses.
 *
 * Ranked by how many words of the question appear in the candidate, then by how
 * far the two names agree from the start — that ordering puts a misspelling
 * next to what was meant. When nothing scores at all the first few names are
 * offered anyway: a model handed an empty list asks the same dead question
 * again, whereas a wrong list at least gets it moving.
 */
function suggestNames(query: string, candidates: readonly string[]): string[] {
  const wanted = normalize(query)
  const tokens = tokenize(query)

  const scored = unique(candidates)
    .map((name) => {
      const normalized = normalize(name)
      const matched = tokens.filter(token => normalized.includes(token)).length

      return {
        name,
        score: matched * 10 + commonPrefixLength(normalized, wanted)
      }
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.name.localeCompare(right.name)
    )

  if (!scored.length) {
    return unique(candidates).slice(0, MAX_SUGGESTIONS)
  }

  return scored.slice(0, MAX_SUGGESTIONS).map(candidate => candidate.name)
}

type NameMatch
  = | { kind: 'one', name: string }
    | { kind: 'many', names: string[] }
    | { kind: 'elsewhere', name: string }
    | { kind: 'none', suggestions: string[] }

/** An exact hit, allowing only for case and punctuation. No partials. */
function exactName(query: string, candidates: readonly string[]): string | null {
  const names = unique(candidates)
  const trimmed = query.trim()
  const wanted = normalize(trimmed)

  if (!wanted) {
    return null
  }

  if (names.includes(trimmed)) {
    return trimmed
  }

  const sameName = names.filter(name => normalize(name) === wanted)

  return sameName.length === 1 ? sameName[0] || null : null
}

/**
 * Resolves what the model typed against the names that exist.
 *
 * Exact first, then the same name modulo case and punctuation, then either name
 * containing the other — which is what catches "the user service" and
 * "userservice" alike. A partial that fits several names is reported as
 * ambiguous rather than resolved to the first one, because guessing there
 * produces a confidently wrong answer instead of one more question.
 *
 * `elsewhere` holds the names the *other* lookup owns. They never match
 * partially and never appear as a suggestion, but an exact hit among them beats
 * a partial hit among the candidates, because otherwise a longer name swallows a
 * shorter one it happens to contain. `Symbol(CONFIG_SERVICE)` is a real token in
 * the demo graph and normalizes to something ending in `configservice`, so the
 * rule that lets "the user service" find UserService would answer a question
 * about the symbol with ConfigService's dependencies.
 */
function matchName(
  query: string,
  candidates: readonly string[],
  elsewhere: readonly string[] = []
): NameMatch {
  const names = unique(candidates)
  const trimmed = query.trim()
  const wanted = normalize(trimmed)

  if (!wanted) {
    return { kind: 'none', suggestions: names.slice(0, MAX_SUGGESTIONS) }
  }

  const here = exactName(trimmed, names)
  if (here) {
    return { kind: 'one', name: here }
  }

  const other = exactName(trimmed, elsewhere)
  if (other) {
    return { kind: 'elsewhere', name: other }
  }

  const partial = names.filter((name) => {
    const normalized = normalize(name)

    return normalized.includes(wanted)
      || (normalized.length >= MIN_PARTIAL_MATCH_LENGTH && wanted.includes(normalized))
  })

  if (partial.length === 1 && partial[0]) {
    return { kind: 'one', name: partial[0] }
  }

  if (partial.length > 1) {
    return { kind: 'many', names: partial }
  }

  return { kind: 'none', suggestions: suggestNames(trimmed, names) }
}

function ambiguousReply(query: string, names: readonly string[]): string {
  return `"${query.trim()}" matches ${countLabel(names.length, 'name')}: ${formatNames(names)}. Ask again with one of them.`
}

function findProviderLocations(graph: GraphInput, name: string): ProviderLocation[] {
  const found: ProviderLocation[] = []

  for (const [moduleName, module] of moduleEntries(graph)) {
    for (const provider of module.providers || []) {
      if (provider.name === name) {
        found.push({ moduleName, provider })
      }
    }
  }

  return found
}

function findControllerLocations(graph: GraphInput, name: string): ControllerLocation[] {
  const found: ControllerLocation[] = []

  for (const [moduleName, module] of moduleEntries(graph)) {
    for (const controller of module.controllers || []) {
      if (controller.name === name) {
        found.push({ moduleName, controller })
      }
    }
  }

  return found
}

/** Every provider and controller that carries `name`, providers first. */
function findInjectors(graph: GraphInput, name: string): Injector[] {
  const providers: Injector[] = findProviderLocations(graph, name).map(location => ({
    kind: 'provider',
    moduleName: location.moduleName,
    name: location.provider.name,
    jsdoc: location.provider.jsdoc,
    dependencies: location.provider.dependencies || [],
    provider: location.provider
  }))

  const controllers: Injector[] = findControllerLocations(graph, name).map(location => ({
    kind: 'controller',
    moduleName: location.moduleName,
    name: location.controller.name,
    jsdoc: location.controller.jsdoc,
    dependencies: location.controller.dependencies || []
  }))

  return [...providers, ...controllers]
}

function injectableNames(graph: GraphInput): string[] {
  const names: string[] = []

  for (const [, module] of moduleEntries(graph)) {
    for (const provider of module.providers || []) {
      names.push(provider.name)
    }

    for (const controller of module.controllers || []) {
      names.push(controller.name)
    }
  }

  return unique(names)
}

/**
 * Tokens that are referenced but never declared: an `exports` entry with no
 * matching provider, or a dependency on something the graph does not describe.
 * Nest is happy to register a value or factory under a bare string, so these
 * are ordinary parts of a graph and a question about one deserves an answer.
 */
function referencedTokenNames(graph: GraphInput): string[] {
  const names: string[] = []

  for (const [, module] of moduleEntries(graph)) {
    names.push(...(module.exports || []))

    for (const provider of module.providers || []) {
      for (const dependency of provider.dependencies || []) {
        names.push(dependency.token)
      }
    }

    for (const controller of module.controllers || []) {
      for (const dependency of controller.dependencies || []) {
        names.push(dependency.token)
      }
    }
  }

  return unique(names)
}

/** Every name `find_provider` answers about: declared, plus the bare tokens. */
function lookupNames(graph: GraphInput): string[] {
  const declared = injectableNames(graph)
  const tokens = referencedTokenNames(graph).filter(token => !declared.includes(token))

  return [...declared, ...tokens]
}

/**
 * The two halves of the name space, resolved separately.
 *
 * A model that asks `describe_module` about `UserService` has not asked
 * nonsense, it has picked the wrong one of two similarly-shaped tools — the
 * commonest mistake a small model makes with this set. Answering "no such
 * module" spends a turn teaching it nothing, so each miss checks the other half
 * and names the call that would have worked. Only an unambiguous hit is worth
 * offering: several candidates would just be a second riddle.
 */
function resolveModuleName(graph: GraphInput, query: string): string | null {
  const match = matchName(query, listModules(graph))

  return match.kind === 'one' ? match.name : null
}

function resolveLookupName(graph: GraphInput, query: string): string | null {
  const match = matchName(query, lookupNames(graph))

  return match.kind === 'one' ? match.name : null
}

/** What kind of thing a name turned out to be, for the redirect line. */
function locate(graph: GraphInput, name: string): string {
  const injectors = findInjectors(graph, name)
  const first = injectors[0]

  if (!first) {
    return 'It is an injection token with no provider entry'
  }

  const kind = first.kind === 'provider' ? 'a provider' : 'a controller'

  return injectors.length > 1
    ? `It is ${kind} declared in ${countLabel(injectors.length, 'module')}`
    : `It is ${kind} in module ${first.moduleName}`
}

/** The three redirects, worded once so the model reads the same sentence twice. */
function useFindProviderReply(graph: GraphInput, name: string): string {
  return `${name} is not a module. ${locate(graph, name)}. Call find_provider with "${name}" instead.`
}

function useDescribeModuleReply(name: string): string {
  return `${name} is a module, not a provider or a controller. Call describe_module with "${name}" instead.`
}

function untraceableReply(name: string): string {
  return `${name} has no dependencies to walk — it is an injection token with no provider entry in this graph. Call find_provider with "${name}" instead.`
}

/** Who injects `token`, optionally only where it resolves to `fromModule`. */
function findDependents(
  graph: GraphInput,
  token: string,
  fromModule: string | null
): string[] {
  const dependents: string[] = []

  const matches = (dependency: GraphOutputDependencyRef) =>
    dependency.token === token
    && (fromModule === null || dependency.providedBy?.name === fromModule)

  for (const [moduleName, module] of moduleEntries(graph)) {
    for (const provider of module.providers || []) {
      if ((provider.dependencies || []).some(matches)) {
        dependents.push(qualify(provider.name, moduleName))
      }
    }

    for (const controller of module.controllers || []) {
      if ((controller.dependencies || []).some(matches)) {
        dependents.push(qualify(controller.name, moduleName))
      }
    }
  }

  return dependents
}

function findExporters(graph: GraphInput, token: string): string[] {
  return moduleEntries(graph)
    .filter(([, module]) => (module.exports || []).includes(token))
    .map(([moduleName]) => moduleName)
}

function findImporters(graph: GraphInput, moduleName: string): string[] {
  return moduleEntries(graph)
    .filter(([, module]) => (module.imports || []).includes(moduleName))
    .map(([importer]) => importer)
}

/**
 * Every module in the graph, in the order the library emitted them — the root
 * comes first, and that ordering is something the user can check against the
 * viewer.
 */
export function listModules(graph: GraphInput): string[] {
  return moduleEntries(graph).map(([name]) => name)
}

function formatModuleList(graph: GraphInput): string {
  const names = listModules(graph)

  if (!names.length) {
    return NO_GRAPH
  }

  const root = graph?.root
  const header = root
    ? `${countLabel(names.length, 'module')}, root module ${root}:`
    : `${countLabel(names.length, 'module')}:`

  return `${header} ${formatNames(names)}`
}

/**
 * One module's whole neighbourhood: what it pulls in, what it hands out, what
 * it owns, and who imports it. The last of those is not in the JSON — it is the
 * reverse of every other module's `imports` — but "what breaks if I move this"
 * is the question that gets asked, so it is cheaper to compute it here than to
 * make the model list every module and check them one at a time.
 */
export function describeModule(graph: GraphInput, name: string): string {
  const names = listModules(graph)

  if (!names.length) {
    return NO_GRAPH
  }

  const match = matchName(name, names, lookupNames(graph))

  if (match.kind === 'many') {
    return ambiguousReply(name, match.names)
  }

  if (match.kind === 'elsewhere') {
    return useFindProviderReply(graph, match.name)
  }

  if (match.kind === 'none') {
    const elsewhere = resolveLookupName(graph, name)

    if (elsewhere) {
      return useFindProviderReply(graph, elsewhere)
    }

    return `No module named "${name.trim()}". Did you mean: ${formatNames(match.suggestions, MAX_SUGGESTIONS)}?`
  }

  const module = graph?.modules?.[match.name]

  if (!module) {
    return `No module named "${name.trim()}". Known modules: ${formatNames(names)}.`
  }

  const doc = formatDoc(module.jsdoc)
  const isRoot = graph?.root === match.name

  const lines = [`Module ${match.name}${isRoot ? ' (root module)' : ''}`]

  if (doc) {
    lines.push(`Doc: ${doc}`)
  }

  lines.push(
    formatSection('Imports', module.imports || []),
    formatSection('Exports', module.exports || []),
    formatSection('Providers', (module.providers || []).map(provider => provider.name)),
    formatSection('Controllers', (module.controllers || []).map(controller => controller.name)),
    formatSection('Imported by', findImporters(graph, match.name))
  )

  return lines.join('\n')
}

function describeInjector(graph: GraphInput, injector: Injector): string {
  const kindLabel = injector.kind === 'provider' ? 'Provider' : 'Controller'
  const lines = [`${kindLabel} ${injector.name} in module ${injector.moduleName}`]

  const doc = formatDoc(injector.jsdoc)
  if (doc) {
    lines.push(`Doc: ${doc}`)
  }

  lines.push(formatSection(
    'Depends on',
    injector.dependencies.map(dependency =>
      qualify(dependency.token, dependency.providedBy?.name || 'an unknown module')
    )
  ))

  // A controller is the end of the chain: nothing injects it and no module
  // exports it, so those two lines would only ever read "none".
  if (injector.kind === 'provider') {
    lines.push(
      formatSection('Used by', findDependents(graph, injector.name, injector.moduleName)),
      formatSection('Exported by', findExporters(graph, injector.name))
    )

    const methods = injector.provider?.directRun?.methods || []
    if (methods.length) {
      lines.push(formatSection('Runnable methods', methods.map(method => method.name)))
    }
  }

  return lines.join('\n')
}

/**
 * Where a provider or controller lives and what it is wired to.
 *
 * Controllers are searched alongside providers on purpose. A model that asks
 * this about `UserController` has asked a reasonable question, and answering
 * "no such provider" would send it looking for a second tool that does not
 * exist. A bare token — exported or injected but never declared, which is what
 * a `useValue` or `useFactory` registration looks like from here — gets the
 * same treatment for the same reason. A module name is the one thing this does
 * not answer, and it comes back as the call that would have.
 */
export function findProvider(graph: GraphInput, name: string): string {
  const moduleNames = listModules(graph)

  if (!moduleNames.length) {
    return NO_GRAPH
  }

  const names = lookupNames(graph)
  const match = matchName(name, names, moduleNames)

  if (match.kind === 'many') {
    return ambiguousReply(name, match.names)
  }

  if (match.kind === 'elsewhere') {
    return useDescribeModuleReply(match.name)
  }

  if (match.kind === 'none') {
    const asModule = resolveModuleName(graph, name)

    if (asModule) {
      return useDescribeModuleReply(asModule)
    }

    if (!names.length) {
      return 'This graph declares no providers or controllers. Call list_modules to see what it does have.'
    }

    return `No provider or controller named "${name.trim()}". Did you mean: ${formatNames(match.suggestions, MAX_SUGGESTIONS)}?`
  }

  const injectors = findInjectors(graph, match.name)

  if (!injectors.length) {
    // An `exports` entry is documented as a provider token, but Nest also lets a
    // module re-export a module it imported, and the demo graph does exactly
    // that with ConfigHostModule. Calling one of those "a token registered with
    // a factory" would be a confident lie, so it is named for what it is.
    if (moduleNames.includes(match.name)) {
      return `${match.name} is a module, re-exported by ${formatNames(findExporters(graph, match.name))}. Call describe_module with "${match.name}" for what is inside it.`
    }

    // Referenced but never described. Saying so beats an empty answer, because
    // the exporters and the dependents are still the model's next step.
    return [
      `${match.name} is a token with no provider or controller entry in this graph. It is registered with a value or a factory, or it comes from outside the graph.`,
      formatSection('Exported by', findExporters(graph, match.name)),
      formatSection('Used by', findDependents(graph, match.name, null))
    ].join('\n')
  }

  const shown = injectors.slice(0, MAX_OCCURRENCES)
  const blocks = shown.map(injector => describeInjector(graph, injector))

  if (injectors.length === 1) {
    return blocks.join('\n\n')
  }

  const header = `${match.name} is declared in ${countLabel(injectors.length, 'module')}: ${formatNames(injectors.map(injector => injector.moduleName))}.`
  const footer = injectors.length > shown.length
    ? [`... ${injectors.length - shown.length} more not shown.`]
    : []

  return [header, ...blocks, ...footer].join('\n\n')
}

/**
 * Walks the injection chain under one provider, one dependency at a time.
 *
 * Two things stop the walk besides the depth limit. A node already on the
 * current path is a circular dependency and is marked as one rather than
 * followed — the demo application alone has two, so this is the normal case and
 * not a defensive flourish. A node expanded earlier under a different parent is
 * pointed back at instead of repeated, which is what keeps a diamond-shaped
 * graph from turning into an exponential amount of text.
 */
export function traceDependencies(
  graph: GraphInput,
  providerName: string,
  maxDepth: number = DEFAULT_TRACE_DEPTH
): string {
  const declared = injectableNames(graph)
  const moduleNames = listModules(graph)

  if (!declared.length) {
    return moduleNames.length
      ? 'This graph has no providers or controllers to trace.'
      : NO_GRAPH
  }

  // Suggestions are drawn from `declared` alone, so a miss only ever offers
  // names this walk could actually follow. Modules and bare tokens are handed to
  // `elsewhere`, where they can win a spelling outright without ever being
  // proposed as the next thing to trace.
  const untraceable = [...moduleNames, ...lookupNames(graph).filter(name => !declared.includes(name))]
  const match = matchName(providerName, declared, untraceable)

  if (match.kind === 'many') {
    return ambiguousReply(providerName, match.names)
  }

  if (match.kind === 'elsewhere') {
    return moduleNames.includes(match.name)
      ? useDescribeModuleReply(match.name)
      : untraceableReply(match.name)
  }

  if (match.kind === 'none') {
    const asModule = resolveModuleName(graph, providerName)

    if (asModule) {
      return useDescribeModuleReply(asModule)
    }

    // Only the bare tokens can still match here: they were left out of
    // `declared` above precisely because there is no dependency list to walk.
    const asToken = resolveLookupName(graph, providerName)

    if (asToken) {
      return untraceableReply(asToken)
    }

    return `No provider or controller named "${providerName.trim()}". Did you mean: ${formatNames(match.suggestions, MAX_SUGGESTIONS)}?`
  }

  const injectors = findInjectors(graph, match.name)
  const start = injectors[0]

  if (!start) {
    return `No provider or controller named "${match.name}".`
  }

  // A depth outside the range is clamped rather than refused. The model picked
  // this number out of a sentence, and turning a bad guess into an error would
  // cost a turn to say something the walk can simply do sensibly instead.
  const requested = Math.trunc(maxDepth)
  const depth = Number.isNaN(requested)
    ? DEFAULT_TRACE_DEPTH
    : Math.min(Math.max(requested, 1), MAX_TRACE_DEPTH)

  const lines: string[] = []
  const expanded = new Set<string>()
  let truncated = false

  const keyOf = (moduleName: string, name: string) => `${moduleName}:${name}`

  const render = (moduleName: string, name: string, level: number, note?: string) => {
    lines.push(`${'  '.repeat(level)}${qualify(name, moduleName)}${note ? ` (${note})` : ''}`)
  }

  const walk = (
    moduleName: string,
    name: string,
    dependencies: GraphOutputDependencyRef[] | null,
    level: number,
    onPath: readonly string[]
  ) => {
    if (lines.length >= MAX_TREE_LINES) {
      truncated = true
      return
    }

    const key = keyOf(moduleName, name)

    if (onPath.includes(key)) {
      render(moduleName, name, level, 'circular, already on this path')
      return
    }

    if (expanded.has(key)) {
      render(moduleName, name, level, 'already expanded above')
      return
    }

    if (dependencies === null) {
      render(moduleName, name, level, 'not declared in this graph')
      return
    }

    if (!dependencies.length) {
      render(moduleName, name, level, 'no dependencies')
      return
    }

    if (level >= depth) {
      render(moduleName, name, level, `${countLabel(dependencies.length, 'dependency', 'dependencies')} not shown, depth limit reached`)
      return
    }

    render(moduleName, name, level)
    expanded.add(key)

    const nextPath = [...onPath, key]

    for (const dependency of dependencies) {
      const nextModule = dependency.providedBy?.name || ''
      const next = graph?.modules?.[nextModule]?.providers
        ?.find(provider => provider.name === dependency.token)

      walk(
        nextModule || 'an unknown module',
        dependency.token,
        next ? next.dependencies || [] : null,
        level + 1,
        nextPath
      )
    }
  }

  walk(start.moduleName, start.name, start.dependencies, 0, [])

  const header = injectors.length > 1
    ? `${match.name} is declared in ${countLabel(injectors.length, 'module')}; tracing the one in ${start.moduleName}.\nDependency tree for ${qualify(start.name, start.moduleName)} (depth limit ${depth}):`
    : `Dependency tree for ${qualify(start.name, start.moduleName)} (depth limit ${depth}):`

  const footer = truncated
    ? [`... tree truncated at ${MAX_TREE_LINES} lines, ask about one branch instead.`]
    : []

  return [header, ...lines, ...footer].join('\n')
}

/**
 * `collectCircularDependencyIssues` reads the three cycle arrays straight off
 * the graph, which is right where it is used — the viewer renders a payload the
 * loader has already accepted. The same call sits inside an agent loop here, and
 * a graph missing one of those arrays would throw where the model is waiting for
 * a result, so the container is completed before it is handed over.
 */
function withCompleteCycles(graph: GraphOutput): GraphOutput {
  const cycles = graph.cycles

  return {
    ...graph,
    cycles: {
      modules: Array.isArray(cycles?.modules) ? cycles.modules : [],
      providers: Array.isArray(cycles?.providers) ? cycles.providers : [],
      controllers: Array.isArray(cycles?.controllers) ? cycles.controllers : []
    }
  }
}

function formatCyclePath(path: readonly string[]): string {
  const cap = 12

  if (path.length <= cap) {
    return path.join(' -> ')
  }

  return `${path.slice(0, cap).join(' -> ')} -> ... (${path.length} nodes in total)`
}

/**
 * Every circular dependency the library reported, in one list.
 *
 * The three cycle categories are read through `collectCircularDependencyIssues`
 * so this and the viewer's own issue list stay in step — the graph contract
 * spells module and controller paths as strings but provider paths as objects,
 * and that split is already untangled there.
 */
export function findCycles(graph: GraphInput): string {
  if (!graph || !listModules(graph).length) {
    return NO_GRAPH
  }

  const issues = collectCircularDependencyIssues(withCompleteCycles(graph))

  if (!issues.length) {
    return 'No circular dependencies were found in this graph.'
  }

  const counts = {
    module: issues.filter(issue => issue.category === 'module').length,
    provider: issues.filter(issue => issue.category === 'provider').length,
    controller: issues.filter(issue => issue.category === 'controller').length
  }

  const header = `${countLabel(issues.length, 'circular dependency', 'circular dependencies')}: ${counts.module} module, ${counts.provider} provider, ${counts.controller} controller.`

  const shown = issues.slice(0, MAX_CYCLES_LISTED).map(issue =>
    `#${issue.id} ${issue.category}, ${issue.type}: ${formatCyclePath(issue.path)}`
  )

  const footer = issues.length > shown.length
    ? [`... and ${issues.length - shown.length} more.`]
    : []

  return [header, ...shown, ...footer].join('\n')
}

type SearchMatch = {
  line: string
  doc: boolean
}

/**
 * A substring sweep over every name in the graph, plus the doc comments.
 *
 * This is the tool a model reaches for when it only half-remembers a name, so
 * name matches are listed before doc mentions: the first group is what the
 * question was about, the second is context that might explain it.
 */
export function searchGraph(graph: GraphInput, query: string): string {
  if (!listModules(graph).length) {
    return NO_GRAPH
  }

  const trimmed = query.trim()
  const wanted = normalize(trimmed)

  if (!wanted) {
    return 'Give search_graph a word to look for, such as part of a module or provider name.'
  }

  const lowered = trimmed.toLowerCase()
  const matches: SearchMatch[] = []
  const named = new Set<string>()

  // An `exports` entry is usually a re-export of something already listed as a
  // module or a provider, and repeating it as a loose token would pad the
  // result with lines the model has to read twice. What is left after this are
  // the tokens that exist nowhere else — a `useValue` registration, a symbol —
  // and those are worth a line of their own.
  const declared = new Set([...listModules(graph), ...injectableNames(graph)])

  const matchesName = (name: string) => normalize(name).includes(wanted)
  const matchesDoc = (jsdoc: string | undefined) =>
    (jsdoc || '').toLowerCase().includes(lowered)

  for (const [moduleName, module] of moduleEntries(graph)) {
    if (matchesName(moduleName)) {
      matches.push({ line: `module ${moduleName}`, doc: false })
      named.add(`module ${moduleName}`)
    }

    for (const provider of module.providers || []) {
      if (matchesName(provider.name)) {
        matches.push({ line: `provider ${qualify(provider.name, moduleName)}`, doc: false })
        named.add(`provider ${qualify(provider.name, moduleName)}`)
      }
    }

    for (const controller of module.controllers || []) {
      if (matchesName(controller.name)) {
        matches.push({ line: `controller ${qualify(controller.name, moduleName)}`, doc: false })
        named.add(`controller ${qualify(controller.name, moduleName)}`)
      }
    }

    for (const token of module.exports || []) {
      if (matchesName(token) && !declared.has(token)) {
        matches.push({ line: `token ${token} exported by ${moduleName}`, doc: false })
      }
    }
  }

  for (const [moduleName, module] of moduleEntries(graph)) {
    if (matchesDoc(module.jsdoc) && !named.has(`module ${moduleName}`)) {
      matches.push({ line: `module ${moduleName} (doc mention)`, doc: true })
    }

    for (const provider of module.providers || []) {
      const line = `provider ${qualify(provider.name, moduleName)}`
      if (matchesDoc(provider.jsdoc) && !named.has(line)) {
        matches.push({ line: `${line} (doc mention)`, doc: true })
      }
    }

    for (const controller of module.controllers || []) {
      const line = `controller ${qualify(controller.name, moduleName)}`
      if (matchesDoc(controller.jsdoc) && !named.has(line)) {
        matches.push({ line: `${line} (doc mention)`, doc: true })
      }
    }
  }

  if (!matches.length) {
    return `Nothing in the graph matches "${trimmed}". Call list_modules to see what is there.`
  }

  const ordered = [
    ...matches.filter(match => !match.doc),
    ...matches.filter(match => match.doc)
  ]

  const shown = ordered.slice(0, MAX_SEARCH_MATCHES).map(match => match.line)
  const footer = ordered.length > shown.length
    ? [`... and ${ordered.length - shown.length} more.`]
    : []

  return [
    `${countLabel(ordered.length, 'match', 'matches')} for "${trimmed}":`,
    ...shown,
    ...footer
  ].join('\n')
}

/**
 * Every argument is total: `.catch()` turns a missing, misspelled or
 * wrongly-typed field into a value the query layer can answer about, instead of
 * a `ToolInputParsingException`. LangChain raises that before the tool body
 * runs, and an exception is exactly what a ReAct loop cannot recover from — the
 * model has no result to reason about, so it repeats the call. The trade is
 * that the generated JSON Schema carries a default rather than a `required`
 * entry, so each description says outright what it needs.
 */
const noArgumentSchema = z.object({})

const moduleNameSchema = z.object({
  name: z.string()
    .describe('Required. One module name, such as UserModule.')
    .catch('')
})

const providerNameSchema = z.object({
  name: z.string()
    .describe('Required. One provider, controller or token name, such as UserService.')
    .catch('')
})

const traceSchema = z.object({
  name: z.string()
    .describe('Required. The provider to start walking from, such as OrderService.')
    .catch(''),
  maxDepth: z.coerce.number().int().min(1).max(MAX_TRACE_DEPTH)
    .describe(`Optional. Levels to walk, 1 to ${MAX_TRACE_DEPTH}. Defaults to ${DEFAULT_TRACE_DEPTH}.`)
    .catch(DEFAULT_TRACE_DEPTH)
})

const searchSchema = z.object({
  query: z.string()
    .describe('Required. One word to look for, such as order or repository.')
    .catch('')
})

/**
 * The query layer as LangChain tools, bound to one graph.
 *
 * Asynchronous because LangChain is imported here and nowhere else in the
 * module: the chat panel is part of the prerendered bundle, and a static import
 * would drag the agent runtime into it. Rebuild the list when the graph
 * reloads — each tool closes over the graph it was given.
 */
export async function createGraphAgentTools(graph: GraphInput): Promise<ClientTool[]> {
  const { tool } = await import('langchain/browser')

  // Each callback names its argument type outright. `tool()` is overloaded on a
  // plain-string input as well as a structured one, and an un-annotated arrow
  // resolves to the string overload — which typechecks, and then hands the body
  // a `String` at runtime.
  //
  // The descriptions are the prompt, not documentation: they are what a 1.7B
  // model has in front of it when it picks. Each one says what it returns in a
  // sentence, and then which sibling to use instead — a wrong pick between two
  // tools that both take a name is the failure that turns into a loop, and the
  // pairs most easily confused are named in each other's text.
  return [
    tool(async () => formatModuleList(graph), {
      name: 'list_modules',
      description: 'List the names of every module in the application. No arguments. Use it first when you do not know any names yet.',
      schema: noArgumentSchema
    }),
    tool(async ({ name }: z.infer<typeof moduleNameSchema>) => describeModule(graph, name), {
      name: 'describe_module',
      description: 'Describe one module: what it imports, what it exports, the providers and controllers it declares, and which modules import it. The name must be a module, such as UserModule. For a service or a controller use find_provider instead.',
      schema: moduleNameSchema
    }),
    tool(async ({ name }: z.infer<typeof providerNameSchema>) => findProvider(graph, name), {
      name: 'find_provider',
      description: 'Describe one provider, service, controller or injection token: the module that declares it, what it injects, what injects it, and which modules export it. The name is a class or a token, such as UserService. For a module use describe_module instead.',
      schema: providerNameSchema
    }),
    tool(async ({ name, maxDepth }: z.infer<typeof traceSchema>) => traceDependencies(graph, name, maxDepth), {
      name: 'trace_dependencies',
      description: 'Walk the chain of dependencies below one provider, several levels deep, marking every circular link on the way. Use it only when the single level find_provider returns is not deep enough.',
      schema: traceSchema
    }),
    tool(async () => findCycles(graph), {
      name: 'find_cycles',
      description: 'List every circular dependency already detected in this application, with its full path. No arguments. Use it for any question about cycles or circular imports.',
      schema: noArgumentSchema
    }),
    tool(async ({ query }: z.infer<typeof searchSchema>) => searchGraph(graph, query), {
      name: 'search_graph',
      description: 'Find every module, provider, controller and doc comment whose text contains one word. Use it when you remember only part of a name. When you already know the exact name, use find_provider or describe_module instead.',
      schema: searchSchema
    })
  ]
}
