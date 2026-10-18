import { z } from 'zod'
import type {
  DirectRunControllerMethod,
  DirectRunProviderMethod,
  DirectRunTargetType,
  GraphOutput,
  RuntimeTrace,
  RuntimeTraceSpan
} from 'nest-graph-inspector'

export type {
  DirectRunControllerMethod,
  DirectRunProviderMethod,
  DirectRunTargetType,
  RuntimeTrace,
  RuntimeTraceSpan,
  RuntimeTraceSpanStatus
} from 'nest-graph-inspector'

/** A provider or controller method — a controller's may additionally carry `http`. */
export type DirectRunAnyMethod = DirectRunProviderMethod | DirectRunControllerMethod

export type DirectRunProviderState = {
  runnable: boolean
  reason: string
  methods: DirectRunAnyMethod[]
}

export type DirectRunResultPayload = {
  ok: boolean
  method?: string
  result?: unknown
  error?: string
  runId?: string
  traceId?: string
  runtimeTrace?: RuntimeTrace
}

/** Shape shared by a `GraphOutputProvider` and a `GraphOutputController`. */
export type DirectRunCapableTarget = {
  directRun?: {
    methods?: DirectRunAnyMethod[]
  }
}

/** A provider or controller the viewer can Direct Run, named by its graph node. */
export type DirectRunTargetRef = {
  nodeId: string
  moduleName: string
  targetType: DirectRunTargetType
  targetName: string
}

export type DirectRunExecutionState = 'idle' | 'running' | 'success' | 'failed'

export type DirectRunExecutionSnapshot = {
  state: DirectRunExecutionState
  summary: string
  method: string
  updatedAt: string
  runId?: string
  traceId?: string
  runtimeTrace?: RuntimeTrace
}

/** A JSON Schema document, as the Monaco args editor validates against it. */
export type DirectRunArgsJsonSchema = z.core.JSONSchema.BaseSchema

/** One parameter of a Direct Run method, read from its `parameterTypes` tuple. */
export type DirectRunParameterInfo = {
  name: string
  /** The TypeScript type text the library rendered for this parameter. */
  type: string
  /** What a JSON value for this parameter must look like at runtime. */
  schema: z.ZodType
}

export type DirectRunArgsParseResult
  = | { ok: true, args: unknown[] | undefined }
    | { ok: false, error: string }

const DIRECT_RUN_EMPTY_REASON = 'No public methods available for direct run.'
const DIRECT_RUN_SUMMARY_CHAR_LIMIT = 240
const DIRECT_RUN_FAILED_MESSAGE = 'Direct run failed.'
export const DIRECT_RUN_UNEXPECTED_RESPONSE_MESSAGE
  = 'Direct Run answered with a response the viewer does not recognise.'

// ---------------------------------------------------------------------------
// Request and response schemas
// ---------------------------------------------------------------------------

export const directRunTargetTypeSchema = z.enum(['provider', 'controller'])

const directRunNameSchema = z.string().regex(/\S/, 'must not be empty')

/**
 * The body of `POST {path}/direct-run`. Strict, and split on `target`, so a
 * request names its instance through exactly the field matching its target
 * type — a provider request carrying `controller`, or the reverse, is refused
 * before it is sent rather than left to the server to disambiguate.
 */
export const directRunRequestSchema = z.discriminatedUnion('target', [
  z.strictObject({
    module: directRunNameSchema,
    target: z.literal('provider'),
    provider: directRunNameSchema,
    method: directRunNameSchema,
    args: z.unknown().optional()
  }),
  z.strictObject({
    module: directRunNameSchema,
    target: z.literal('controller'),
    controller: directRunNameSchema,
    method: directRunNameSchema,
    args: z.unknown().optional()
  })
])

export type DirectRunRequestPayload = z.infer<typeof directRunRequestSchema>

/**
 * What the library answers a Direct Run with — on success, and in the body of
 * a refusal. `runtimeTrace` is only checked for the fields the viewer keys on;
 * the trace pages read the rest.
 */
export const directRunResultPayloadSchema = z.object({
  ok: z.boolean(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  runId: z.string().optional(),
  traceId: z.string().optional(),
  runtimeTrace: z.unknown().optional()
})

/** Validates a Direct Run request, throwing a readable error when it is malformed. */
export function parseDirectRunRequest(value: unknown): DirectRunRequestPayload {
  const parsed = directRunRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`Invalid Direct Run request: ${formatRequestIssues(parsed.error.issues)}`)
  }

  return parsed.data
}

/**
 * The response as a `DirectRunResultPayload`, or `null` when it is not one. A
 * `runtimeTrace` without a trace id and spans is dropped rather than failing
 * the whole response: the call still ran, only its trace is unreadable.
 */
export function parseDirectRunResultPayload(value: unknown): DirectRunResultPayload | null {
  const parsed = directRunResultPayloadSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }

  const { runtimeTrace, ...payload } = parsed.data
  return isRuntimeTrace(runtimeTrace) ? { ...payload, runtimeTrace } : payload
}

/** A successful `$fetch` body as a result payload, or a failure saying why not. */
export function resolveDirectRunResponse(value: unknown): DirectRunResultPayload {
  return parseDirectRunResultPayload(value)
    ?? { ok: false, error: DIRECT_RUN_UNEXPECTED_RESPONSE_MESSAGE }
}

/**
 * A thrown `$fetch` as a result payload. A refused call still answers with
 * the payload saying why (`error.data`); anything else — a network failure,
 * a request that never left — becomes a failure carrying the error's message.
 */
export function resolveDirectRunFailure(error: unknown): {
  payload: DirectRunResultPayload
  /** Whether the server answered, as opposed to the request failing outright. */
  answered: boolean
} {
  const data = isRecord(error) ? parseDirectRunResultPayload(error.data) : null
  if (data) {
    return {
      payload: data.ok ? data : { ...data, error: data.error || DIRECT_RUN_FAILED_MESSAGE },
      answered: true
    }
  }

  return {
    payload: {
      ok: false,
      error: error instanceof Error && error.message ? error.message : DIRECT_RUN_FAILED_MESSAGE
    },
    answered: false
  }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The graph node id of a provider or controller. The type prefix is what
 * keeps a controller apart from a same-named provider, so anything that has
 * to name a Direct Run target again later — the selection, the drawer event,
 * the `direct-run-on` query — carries this id, never the bare class name.
 */
export function getDirectRunNodeId(
  targetType: DirectRunTargetType,
  moduleName: string,
  targetName: string
): string {
  return `${targetType}-${moduleName}-${targetName}`
}

/**
 * The provider or controller a node id names in this graph, or `null`. The
 * id is matched exactly against the graph's own nodes rather than parsed, so
 * a controller's id only ever resolves to that controller — never to a
 * same-named provider — and a bare class name resolves to nothing.
 */
export function findDirectRunTarget(
  graph: Pick<GraphOutput, 'modules'>,
  nodeId: string | null | undefined
): DirectRunTargetRef | null {
  if (!nodeId) {
    return null
  }

  for (const [moduleName, moduleData] of Object.entries(graph.modules)) {
    const provider = moduleData.providers.find(
      item => getDirectRunNodeId('provider', moduleName, item.name) === nodeId
    )
    if (provider) {
      return {
        nodeId,
        moduleName,
        targetType: 'provider',
        targetName: provider.name
      }
    }

    const controller = moduleData.controllers.find(
      item => getDirectRunNodeId('controller', moduleName, item.name) === nodeId
    )
    if (controller) {
      return {
        nodeId,
        moduleName,
        targetType: 'controller',
        targetName: controller.name
      }
    }
  }

  return null
}

/**
 * What the target can run, read from its own instance table — a controller's
 * methods never come from a same-named provider, nor the reverse.
 */
export function getDirectRunTargetState(
  graph: Pick<GraphOutput, 'modules'>,
  target: Pick<DirectRunTargetRef, 'moduleName' | 'targetType' | 'targetName'>
): DirectRunProviderState | null {
  const moduleData = Object.hasOwn(graph.modules, target.moduleName)
    ? graph.modules[target.moduleName]
    : undefined
  const entries: Array<DirectRunCapableTarget & { name: string }> | undefined
    = target.targetType === 'controller'
      ? moduleData?.controllers
      : moduleData?.providers
  const entry = entries?.find(candidate => candidate.name === target.targetName)

  return entry ? getDirectRunProviderState(entry) : null
}

/**
 * The Direct Run args editor's model path. Monaco keys both the editor model
 * and the JSON schema registered for it by this path, so it carries the
 * target type: a controller and a same-named provider in one module, each
 * with a method of the same name, never share an editor or a schema.
 */
export function buildDirectRunEditorPath(
  target: Pick<DirectRunTargetRef, 'targetType' | 'moduleName' | 'targetName'>,
  methodName: string
): string {
  return `direct-run://${target.targetType}/${target.moduleName}/${target.targetName}/${methodName}.json`
}

/**
 * Whether a runtime-trace span can be re-run from the trace alone. A span
 * records its module, class, and method, but not whether that class is a
 * provider or a controller, and a re-run has to say which. So a span is
 * re-run only as a provider, and only when the graph knows its class as a
 * provider of that module and not also as a controller there. A controller
 * span is never offered: re-sent as a provider it would be refused with a
 * `404` — or, when the module also has a provider of that name, run that
 * provider's method instead.
 */
export function canRerunSpanAsProvider(
  graph: Pick<GraphOutput, 'modules'> | null | undefined,
  span: Pick<RuntimeTraceSpan, 'moduleName' | 'className' | 'methodName'>
): boolean {
  const { moduleName, className, methodName } = span
  const moduleData = graph && moduleName && Object.hasOwn(graph.modules, moduleName)
    ? graph.modules[moduleName]
    : undefined

  return Boolean(
    className
    && methodName
    && moduleData?.providers.some(provider => provider.name === className)
    && !moduleData.controllers.some(controller => controller.name === className)
  )
}

export function getDirectRunProviderState(target: DirectRunCapableTarget): DirectRunProviderState {
  const methods = target.directRun?.methods || []

  if (!methods.length) {
    return {
      runnable: false,
      reason: DIRECT_RUN_EMPTY_REASON,
      methods: []
    }
  }

  return {
    runnable: true,
    reason: '',
    methods
  }
}

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/**
 * The request body for one call. `args` is sent unwrapped when the method
 * takes one argument — the library hands a one-parameter method the value as
 * is — and as the array otherwise. Throws when the request is malformed.
 */
export function buildDirectRunRequest(payload: {
  moduleName: string
  targetType: DirectRunTargetType
  targetName: string
  methodName: string
  args?: unknown[]
}): DirectRunRequestPayload {
  const request: Record<string, unknown> = {
    module: payload.moduleName,
    target: payload.targetType,
    method: payload.methodName,
    [payload.targetType === 'controller' ? 'controller' : 'provider']: payload.targetName
  }

  if (payload.args !== undefined) {
    request.args = payload.args.length === 1 ? payload.args[0] : payload.args
  }

  return parseDirectRunRequest(request)
}

export function summarizeDirectRunResult(payload: DirectRunResultPayload): string {
  if (!payload.ok) {
    return payload.error || DIRECT_RUN_FAILED_MESSAGE
  }

  if (payload.result === undefined) {
    return 'Completed with no return value.'
  }

  const summary = safeJsonStringify(payload.result)
  return summary.length > DIRECT_RUN_SUMMARY_CHAR_LIMIT
    ? `${summary.slice(0, DIRECT_RUN_SUMMARY_CHAR_LIMIT - 1)}…`
    : summary
}

export function buildDirectRunSnapshot(payload: {
  response: DirectRunResultPayload
  requestedMethod: string
  updatedAt?: Date
}): DirectRunExecutionSnapshot {
  return {
    state: payload.response.ok ? 'success' : 'failed',
    summary: summarizeDirectRunResult(payload.response),
    method: payload.response.method || payload.requestedMethod,
    updatedAt: (payload.updatedAt || new Date()).toISOString(),
    runId: payload.response.runId,
    traceId: payload.response.traceId,
    runtimeTrace: payload.response.runtimeTrace
  }
}

// ---------------------------------------------------------------------------
// Method signatures and arguments
// ---------------------------------------------------------------------------

/**
 * The parameters of a method, read from the TypeScript tuple the library
 * renders into `parameterTypes` (`[id: string, options?: { limit: number }]`).
 * A method that takes nothing is written `[]`; text that is not a tuple at all
 * is read as no parameters.
 */
export function getDirectRunParameterInfos(
  method: Pick<DirectRunAnyMethod, 'parameterTypes'>
): DirectRunParameterInfo[] {
  const tupleBody = parseTupleBody(method.parameterTypes?.trim() || '[]')
  if (!tupleBody) {
    return []
  }

  return splitTopLevel(tupleBody, ',').map(
    (parameter, index): DirectRunParameterInfo => {
      const separatorIndex = findTopLevelSeparator(parameter, ':')
      const rawName = separatorIndex >= 0
        ? parameter.slice(0, separatorIndex).trim()
        : `arg${index + 1}`
      const type = separatorIndex >= 0
        ? parameter.slice(separatorIndex + 1).trim() || 'unknown'
        : parameter.trim() || 'unknown'

      return {
        name: sanitizeParameterName(rawName) || `arg${index + 1}`,
        type,
        schema: typeScriptTypeToZodSchema(type)
      }
    }
  )
}

export function getDirectRunParameterCount(
  method: Pick<DirectRunAnyMethod, 'parameterTypes'>
): number {
  return getDirectRunParameterInfos(method).length
}

/** `find(id, options)` — the method as the drawer titles it. */
export function getDirectRunMethodSignature(method: DirectRunAnyMethod): string {
  const names = getDirectRunParameterInfos(method).map(parameter => parameter.name)
  return `${method.name}(${names.join(', ')})`
}

/**
 * Only a `DirectRunControllerMethod` ever carries `http`, and only when Nest
 * recorded route metadata for it — informational, since Direct Run never
 * sends this method an HTTP request.
 */
export function getDirectRunMethodHttp(
  method: DirectRunAnyMethod
): { method: string, path: string } | undefined {
  return 'http' in method ? method.http : undefined
}

/**
 * The runtime schema for a TypeScript type the library rendered as text.
 * Primitives, literals, unions, arrays, tuples, and object literals are
 * checked; anything else — a class, an alias, a generic — names a type the
 * viewer cannot see into, so it accepts any JSON value.
 */
export function typeScriptTypeToZodSchema(typeText: string): z.ZodType {
  const type = stripOuterParens(typeText.trim())
  if (!type || type === 'unknown' || type === 'any') {
    return z.unknown()
  }

  switch (type) {
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'object':
      return z.looseObject({})
  }

  const literal = parseTypeScriptLiteral(type)
  if (literal.matched) {
    return z.literal(literal.value)
  }

  const rawUnionTypes = splitTopLevel(type, '|')
  if (rawUnionTypes.length > 1) {
    // JSON has no `undefined`: an optional member is simply left out.
    const unionTypes = rawUnionTypes.filter(
      candidate => candidate !== 'undefined' && candidate !== 'void'
    )
    if (unionTypes.length === 0) {
      return z.unknown()
    }
    if (unionTypes.length === 1) {
      return typeScriptTypeToZodSchema(unionTypes[0] as string)
    }

    const literals = unionTypes.map(parseTypeScriptLiteral)
    if (literals.every(isMatchedLiteral)) {
      return z.literal(literals.map(candidate => candidate.value))
    }

    const [first, second, ...rest] = unionTypes.map(typeScriptTypeToZodSchema)
    return z.union([first as z.ZodType, second as z.ZodType, ...rest])
  }

  const genericArray = /^(?:Readonly)?Array<(.+)>$/.exec(type)
  if (genericArray) {
    return z.array(typeScriptTypeToZodSchema(genericArray[1] as string))
  }

  if (isArrayType(type)) {
    return z.array(typeScriptTypeToZodSchema(type.slice(0, -2)))
  }

  if (type.startsWith('[') && type.endsWith(']')) {
    return exactTuple(splitTopLevel(type.slice(1, -1), ',').map(typeScriptTypeToZodSchema))
  }

  if (type.startsWith('{') && type.endsWith('}')) {
    return objectTypeToZodSchema(type.slice(1, -1))
  }

  return z.unknown()
}

type DirectRunArgsSchemas = {
  fingerprint: string
  runtime: z.ZodType<unknown[]>
  json: DirectRunArgsJsonSchema
}

/** Methods are stable objects of one loaded graph; a reload brings new ones. */
const argsSchemaCache = new WeakMap<object, DirectRunArgsSchemas>()

/**
 * The runtime schema for a method's arguments: a JSON array holding exactly
 * one value per parameter, each matching that parameter's type.
 */
export function buildDirectRunArgsSchema(method: DirectRunAnyMethod): z.ZodType<unknown[]> {
  return getArgsSchemas(method).runtime
}

/**
 * The same arguments as a JSON Schema, for the Monaco editor to validate and
 * complete against while the visitor types. Derived from the parameter
 * schemas the runtime check uses, so what the editor underlines and what Run
 * refuses never disagree.
 */
export function buildDirectRunArgsJsonSchema(method: DirectRunAnyMethod): DirectRunArgsJsonSchema {
  return getArgsSchemas(method).json
}

/**
 * The editor's text as the arguments to send, validated against the method's
 * parameter types; `args` is `undefined` for a method that takes nothing.
 */
export function parseDirectRunArgs(
  method: DirectRunAnyMethod,
  input: string
): DirectRunArgsParseResult {
  const parameters = getDirectRunParameterInfos(method)
  if (parameters.length === 0) {
    return { ok: true, args: undefined }
  }

  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return { ok: false, error: `Enter JSON arguments for ${method.name}().` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmedInput)
  } catch {
    return { ok: false, error: 'Arguments must be valid JSON.' }
  }

  const result = buildDirectRunArgsSchema(method).safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: formatArgsIssue(result.error.issues[0], parameters) }
  }

  return { ok: true, args: result.data }
}

function getArgsSchemas(method: DirectRunAnyMethod): DirectRunArgsSchemas {
  const fingerprint = method.parameterTypes || '[]'
  const cached = argsSchemaCache.get(method)
  if (cached?.fingerprint === fingerprint) {
    return cached
  }

  const parameters = getDirectRunParameterInfos(method)
  const count = parameters.length
  const label = `${method.name}()`

  // The length is checked before the tuple, so a short array is reported as
  // a missing argument rather than as the last parameter being `undefined`.
  const runtime = z
    .array(z.unknown(), { error: `${label} takes its arguments as a JSON array.` })
    .length(count, {
      error: `${label} expects ${count} ${count === 1 ? 'argument' : 'arguments'}.`
    })
    .pipe(exactTuple(parameters.map(parameter => parameter.schema)))

  const description = count === 0
    ? 'JSON array passed as method arguments.'
    : count === 1
      ? `JSON array passed as ${parameters[0]?.name}: ${parameters[0]?.type}.`
      : `JSON array passed as ${count} method arguments.`
  const json: DirectRunArgsJsonSchema = {
    ...z.toJSONSchema(
      exactTuple(parameters.map(parameter =>
        parameter.schema.meta({ title: parameter.name, description: parameter.type })
      )),
      { target: 'draft-7', unrepresentable: 'any' }
    ),
    title: `${label} arguments`,
    description,
    minItems: count,
    maxItems: count
  }

  const schemas = { fingerprint, runtime, json }
  argsSchemaCache.set(method, schemas)
  return schemas
}

/**
 * A fixed-length tuple, typed as taking an array in: `.pipe()` requires the
 * next schema to accept what the previous one outputs, and the default input
 * type of `z.ZodType<unknown[]>` is `unknown`.
 */
function exactTuple(items: z.ZodType[]): z.ZodType<unknown[], unknown[]> {
  return z.tuple(items as [z.ZodType, ...z.ZodType[]])
}

function formatArgsIssue(
  issue: z.core.$ZodIssue | undefined,
  parameters: DirectRunParameterInfo[]
): string {
  if (!issue) {
    return 'Arguments do not match the method.'
  }

  const [index, ...rest] = issue.path
  if (typeof index !== 'number') {
    return issue.message
  }

  const label = rest.reduce<string>(
    (path, segment) => typeof segment === 'number'
      ? `${path}[${segment}]`
      : `${path}.${String(segment)}`,
    parameters[index]?.name || `arg${index + 1}`
  )

  return `${label}: ${issue.message}`
}

function formatRequestIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map(issue => `${issue.path.map(String).join('.') || 'request'}: ${issue.message}`)
    .join('; ')
}

function objectTypeToZodSchema(typeBody: string): z.ZodType {
  const shape: Record<string, z.ZodType> = {}

  for (const member of splitTopLevelAny(typeBody, [';', ','])) {
    const separatorIndex = findTopLevelSeparator(member, ':')
    if (separatorIndex <= 0) {
      continue
    }

    const rawName = member.slice(0, separatorIndex).trim()
    const propertyType = member.slice(separatorIndex + 1).trim()
    const name = sanitizeParameterName(rawName)
    if (!name) {
      continue
    }

    const schema = typeScriptTypeToZodSchema(propertyType)
    shape[name] = rawName.endsWith('?') || typeIncludesUndefined(propertyType)
      ? schema.optional()
      : schema
  }

  // Extra properties pass through: the type text may be a simplification.
  return z.looseObject(shape)
}

// ---------------------------------------------------------------------------
// TypeScript type text
// ---------------------------------------------------------------------------

function parseTupleBody(parameterTypes: string): string {
  const trimmed = stripOuterParens(parameterTypes.trim())
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return ''
  }

  return trimmed.slice(1, -1).trim()
}

function sanitizeParameterName(name: string): string {
  return name
    .replace(/^\.\.\./, '')
    .replace(/^readonly\s+/, '')
    .replace(/\?$/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim()
}

function stripOuterParens(value: string): string {
  let next = value.trim()
  while (next.startsWith('(') && next.endsWith(')') && enclosesWholeValue(next)) {
    next = next.slice(1, -1).trim()
  }

  return next
}

function enclosesWholeValue(value: string): boolean {
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"' || character === '\'' || character === '`') {
      quote = character
      continue
    }
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
      if (depth === 0 && index < value.length - 1) {
        return false
      }
    }
  }

  return depth === 0
}

function splitTopLevel(value: string, separator: string): string[] {
  return splitTopLevelAny(value, [separator])
}

/** Splits on separators outside brackets, braces, parens, generics, and strings. */
function splitTopLevelAny(value: string, separators: string[]): string[] {
  const parts: string[] = []
  let start = 0

  scanTopLevel(value, (character, index) => {
    if (separators.includes(character)) {
      const part = value.slice(start, index).trim()
      if (part) {
        parts.push(part)
      }
      start = index + 1
    }
    return false
  })

  const part = value.slice(start).trim()
  if (part) {
    parts.push(part)
  }

  return parts
}

function findTopLevelSeparator(value: string, separator: string): number {
  return scanTopLevel(value, character => character === separator)
}

/**
 * Walks `value`, calling `visit` for each character at nesting depth zero
 * and outside string literals; returns the first index `visit` accepts, or -1.
 */
function scanTopLevel(
  value: string,
  visit: (character: string, index: number) => boolean
): number {
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"' || character === '\'' || character === '`') {
      quote = character
    } else if ('{[(<'.includes(character)) {
      depth += 1
    } else if ('}])>'.includes(character)) {
      depth -= 1
    } else if (depth === 0 && visit(character, index)) {
      return index
    }
  }

  return -1
}

type MatchedLiteral = { matched: true, value: string | number | boolean | null }

function isMatchedLiteral(
  literal: MatchedLiteral | { matched: false }
): literal is MatchedLiteral {
  return literal.matched
}

function parseTypeScriptLiteral(
  value: string
): MatchedLiteral | { matched: false } {
  if (/^'(?:\\.|[^'\\])*'$/.test(value) || /^"(?:\\.|[^"\\])*"$/.test(value)) {
    try {
      const normalizedValue = value.startsWith('\'')
        ? JSON.stringify(value.slice(1, -1).replace(/\\'/g, '\''))
        : value

      return { matched: true, value: JSON.parse(normalizedValue) as string }
    } catch {
      return { matched: true, value: value.slice(1, -1) }
    }
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return { matched: true, value: Number(value) }
  }
  if (value === 'true') {
    return { matched: true, value: true }
  }
  if (value === 'false') {
    return { matched: true, value: false }
  }
  if (value === 'null') {
    return { matched: true, value: null }
  }

  return { matched: false }
}

function isArrayType(type: string): boolean {
  return type.endsWith('[]') && stripOuterParens(type.slice(0, -2)).length > 0
}

function typeIncludesUndefined(type: string): boolean {
  return splitTopLevel(type, '|').some(candidate => candidate === 'undefined')
}

function isRuntimeTrace(value: unknown): value is RuntimeTrace {
  return isRecord(value) && typeof value.traceId === 'string' && Array.isArray(value.spans)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeJsonStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}
