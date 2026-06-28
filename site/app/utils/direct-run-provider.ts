export type DirectRunProviderMethod = {
  name: string
  parameterTypes: string
}

export type DirectRunProviderState = {
  runnable: boolean
  reason: string
  methods: DirectRunProviderMethod[]
}

export type DirectRunResultPayload = {
  ok: boolean
  method?: string
  result?: unknown
  error?: string
}

export type DirectRunCapableProvider = {
  directRun?: {
    methods?: DirectRunProviderMethod[]
  }
}

export type DirectRunRequestPayload = {
  module: string
  provider: string
  method: string
  args?: unknown
}

export type DirectRunExecutionState = 'idle' | 'running' | 'success' | 'failed'

export type DirectRunExecutionSnapshot = {
  state: DirectRunExecutionState
  summary: string
  method: string
  updatedAt: string
}

const DIRECT_RUN_EMPTY_REASON = 'No public methods available for direct run.'
const DIRECT_RUN_SUMMARY_CHAR_LIMIT = 240

export function parseProviderNodeId(nodeId: string): {
  moduleName: string
  providerName: string
} | null {
  if (!nodeId.startsWith('provider-')) {
    return null
  }

  const withoutPrefix = nodeId.slice('provider-'.length)
  const separatorIndex = withoutPrefix.indexOf('-')
  if (separatorIndex <= 0 || separatorIndex >= withoutPrefix.length - 1) {
    return null
  }

  return {
    moduleName: withoutPrefix.slice(0, separatorIndex),
    providerName: withoutPrefix.slice(separatorIndex + 1)
  }
}

export function getDirectRunProviderState(provider: DirectRunCapableProvider): DirectRunProviderState {
  const methods = provider.directRun?.methods || []

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
  providerName: string
  methodName: string
  args?: unknown[]
}): DirectRunRequestPayload {
  const request: DirectRunRequestPayload = {
    module: payload.moduleName,
    provider: payload.providerName,
    method: payload.methodName
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
    updatedAt: (payload.updatedAt || new Date()).toISOString()
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
