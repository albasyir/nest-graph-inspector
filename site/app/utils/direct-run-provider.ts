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

export type DirectRunRequestPayload = {
  module: string
  target: DirectRunTargetType
  /** Read by the server only when `target` is `"provider"`. */
  provider?: string
  /** Read by the server only when `target` is `"controller"`. */
  controller?: string
  method: string
  args?: unknown
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

const DIRECT_RUN_EMPTY_REASON = 'No public methods available for direct run.'
const DIRECT_RUN_SUMMARY_CHAR_LIMIT = 240

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

export function buildDirectRunRequest(payload: {
  moduleName: string
  targetType: DirectRunTargetType
  targetName: string
  methodName: string
  args?: unknown[]
}): DirectRunRequestPayload {
  const request: DirectRunRequestPayload = {
    module: payload.moduleName,
    target: payload.targetType,
    method: payload.methodName,
    ...(payload.targetType === 'controller'
      ? { controller: payload.targetName }
      : { provider: payload.targetName })
  }

  if (payload.args !== undefined) {
    request.args = payload.args.length === 1 ? payload.args[0] : payload.args
  }

  return request
}

export function summarizeDirectRunResult(payload: DirectRunResultPayload): string {
  if (!payload.ok) {
    return payload.error || 'Direct run failed.'
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

function safeJsonStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}
