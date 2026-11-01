import type { GraphOutput } from 'nest-graph-inspector'
import {
  MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION,
  NEWEST_KNOWN_GRAPH_OUTPUT_VERSION,
  parseGraphOutputVersion
} from './graph-output-support.ts'

/**
 * Reading a graph file the visitor opens in the viewer: the JSON that
 * `nest-graph-inspector export` writes, which is the document a running
 * inspector serves at `/output.json` and its `json` output writes to disk.
 *
 * The file is read in the browser and goes nowhere else. Everything here works
 * on the text the visitor chose, and says what is wrong with it in words they
 * can act on — which is also why a message may quote the file's own name or a
 * piece of it, and why it must never be sent to analytics.
 */

/**
 * The largest graph file the viewer opens. A real application's graph is a
 * few megabytes at most; parsing much more than this would freeze the tab.
 */
export const MAX_GRAPH_FILE_BYTES = 20 * 1024 * 1024

/** What kind of problem kept a file from opening, for analytics: never its words. */
export type GraphFileProblem
  = | 'too-large'
    | 'empty'
    | 'invalid-json'
    | 'not-a-graph'
    | 'unsupported-version'
    | 'unreadable'

/** A file that did not open: what kind of problem, and what to say about it. */
export type GraphFileFailure = { ok: false, problem: GraphFileProblem, message: string }

export type GraphFileResult
  = | {
    ok: true
    graph: GraphOutput
    /** Said beside a graph that opened, when it is newer than this viewer. */
    notice?: string
  }
  | GraphFileFailure

const EXPORT_AGAIN = 'Export it again with npx nest-graph-inspector export.'

const byteSize = new Intl.NumberFormat('en', {
  style: 'unit',
  unit: 'megabyte',
  unitDisplay: 'short',
  maximumFractionDigits: 1
})

/** A size in megabytes, the way the messages below say it. */
export function formatFileSize(bytes: number): string {
  return byteSize.format(bytes / (1024 * 1024))
}

/**
 * Refuses a file too large to open before any of it is read, so a stray
 * multi-gigabyte file costs nothing.
 */
export function checkGraphFileSize(
  fileName: string,
  bytes: number
): GraphFileFailure | undefined {
  if (bytes <= MAX_GRAPH_FILE_BYTES) {
    return undefined
  }

  return {
    ok: false,
    problem: 'too-large',
    message: `${fileName} is ${formatFileSize(bytes)}. The viewer opens graph files up to ${formatFileSize(MAX_GRAPH_FILE_BYTES)}.`
  }
}

/** Parses a graph file's text and checks that it is a graph this viewer can draw. */
export function readGraphFileText(text: string, fileName: string): GraphFileResult {
  if (!text.trim()) {
    return {
      ok: false,
      problem: 'empty',
      message: `${fileName} is empty. ${EXPORT_AGAIN}`
    }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    return {
      ok: false,
      problem: 'invalid-json',
      message: `${fileName} is not valid JSON: ${reason}.`
    }
  }

  return readGraphOutput(value, fileName)
}

/**
 * Checks that a parsed value is a `GraphOutput` this viewer can draw: every
 * field the viewer reads, down to each dependency, has the type it expects.
 * The first field that does not is named by its path, so the message points
 * at the place to look.
 */
export function readGraphOutput(value: unknown, fileName: string): GraphFileResult {
  const notAGraph = (detail: string): GraphFileResult => ({
    ok: false,
    problem: 'not-a-graph',
    message: `${fileName} is not a Nest Graph Inspector graph: ${detail}. ${EXPORT_AGAIN}`
  })

  if (!isRecord(value)) {
    return notAGraph('it holds no JSON object')
  }

  if (value.version === undefined || value.version === null) {
    return notAGraph('it has no format `version`')
  }

  // A whole number, as the contract writes it: `parseGraphOutputVersion`
  // reads the leading digits of anything, `"3garbage"` included.
  const version = isWholeNumber(value.version)
    ? parseGraphOutputVersion(value.version)
    : null
  if (version === null) {
    return notAGraph('its format `version` is not a whole number')
  }

  if (version < MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION) {
    return {
      ok: false,
      problem: 'unsupported-version',
      message: `${fileName} is a version ${version} graph, and the viewer reads version ${MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION} and later. Export it again with a current nest-graph-inspector.`
    }
  }

  const problem = findGraphOutputProblem(value)
  if (problem) {
    // A newer format may have changed the very shape checked here: what
    // helps is a newer viewer, not another export.
    return version > NEWEST_KNOWN_GRAPH_OUTPUT_VERSION
      ? {
          ok: false,
          problem: 'unsupported-version',
          message: `${fileName} is in format ${version}, newer than the format ${NEWEST_KNOWN_GRAPH_OUTPUT_VERSION} this viewer reads, and this viewer cannot draw it: ${problem}. Reload the page for the newest viewer.`
        }
      : notAGraph(problem)
  }

  // Module names come from the file, and every lookup of one has to miss
  // when it names nothing: without a prototype, `modules.toString` is not a
  // module the viewer would go on to read the imports of.
  const graph = {
    ...value,
    modules: Object.assign(Object.create(null), value.modules)
  } as GraphOutput

  return version > NEWEST_KNOWN_GRAPH_OUTPUT_VERSION
    ? {
        ok: true,
        graph,
        notice: `This graph is in format ${version}, newer than the format ${NEWEST_KNOWN_GRAPH_OUTPUT_VERSION} this viewer was built for. If anything looks missing, reload the page for the newest viewer.`
      }
    : { ok: true, graph }
}

/** The first field of a would-be graph the viewer could not read, described. */
function findGraphOutputProblem(graph: Record<string, unknown>): string | undefined {
  if (typeof graph.root !== 'string' || !graph.root) {
    return 'it names no `root` module'
  }

  if (!isRecord(graph.modules)) {
    return '`modules` is not an object of modules'
  }

  if (!Object.hasOwn(graph.modules, graph.root)) {
    return `its root module, ${graph.root}, is not among its \`modules\``
  }

  for (const [moduleName, module] of Object.entries(graph.modules)) {
    const problem = findModuleProblem(module, `modules${key(moduleName)}`)
    if (problem) {
      return problem
    }
  }

  if (!isRecord(graph.cycles)) {
    return '`cycles` is not an object'
  }

  for (const kind of ['modules', 'providers', 'controllers'] as const) {
    const cycles = graph.cycles[kind]
    if (!Array.isArray(cycles)) {
      return `\`cycles.${kind}\` is not a list`
    }

    // A module or controller cycle walks names; a provider cycle walks a
    // provider and the module it came from, at every step.
    const isStep = kind === 'providers' ? isProviderCycleStep : isString
    const index = cycles.findIndex(
      cycle =>
        !isRecord(cycle)
        || typeof cycle.from !== 'string'
        || typeof cycle.to !== 'string'
        || !Array.isArray(cycle.path)
        || !cycle.path.every(isStep)
    )
    if (index !== -1) {
      return `\`cycles.${kind}[${index}]\` is not a cycle`
    }
  }

  return undefined
}

function isProviderCycleStep(step: unknown): boolean {
  return isRecord(step)
    && isRecord(step.module)
    && typeof step.module.name === 'string'
    && isRecord(step.provider)
    && typeof step.provider.name === 'string'
}

function findModuleProblem(module: unknown, path: string): string | undefined {
  if (!isRecord(module)) {
    return `\`${path}\` is not a module`
  }

  for (const field of ['imports', 'exports'] as const) {
    if (!isStringList(module[field])) {
      return `\`${path}.${field}\` is not a list of names`
    }
  }

  for (const field of ['providers', 'controllers'] as const) {
    const members = module[field]
    if (!Array.isArray(members)) {
      return `\`${path}.${field}\` is not a list`
    }

    for (const [index, member] of members.entries()) {
      const problem = findMemberProblem(member, `${path}.${field}[${index}]`)
      if (problem) {
        return problem
      }
    }
  }

  return optionalString(module.jsdoc, `${path}.jsdoc`)
}

function findMemberProblem(member: unknown, path: string): string | undefined {
  if (!isRecord(member) || typeof member.name !== 'string') {
    return `\`${path}\` has no \`name\``
  }

  if (!Array.isArray(member.dependencies)) {
    return `\`${path}.dependencies\` is not a list`
  }

  const dependency = member.dependencies.findIndex(
    entry =>
      !isRecord(entry)
      || typeof entry.token !== 'string'
      || !isRecord(entry.providedBy)
      || typeof entry.providedBy.name !== 'string'
  )
  if (dependency !== -1) {
    return `\`${path}.dependencies[${dependency}]\` is not a dependency`
  }

  if (member.directRun !== undefined) {
    if (!isRecord(member.directRun) || !Array.isArray(member.directRun.methods)) {
      return `\`${path}.directRun.methods\` is not a list`
    }

    const method = member.directRun.methods.findIndex(
      entry =>
        !isRecord(entry)
        || typeof entry.name !== 'string'
        || typeof entry.parameterTypes !== 'string'
    )
    if (method !== -1) {
      return `\`${path}.directRun.methods[${method}]\` is not a method`
    }
  }

  return optionalString(member.jsdoc, `${path}.jsdoc`)
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined || typeof value === 'string'
    ? undefined
    : `\`${path}\` is not text`
}

/** A path segment for a key: `.UserModule`, or `["user module"]` when it is not an identifier. */
function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isWholeNumber(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isInteger(value) && value >= 0
    : typeof value === 'string' && /^\d+$/.test(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}
