<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import type { GraphOutput } from 'nest-graph-inspector'
import {
  buildDirectRunArgsJsonSchema,
  buildDirectRunEditorPath,
  buildDirectRunRequest,
  buildDirectRunSnapshot,
  findDirectRunTarget,
  getDirectRunMethodHttp,
  getDirectRunMethodSignature,
  getDirectRunParameterCount,
  getDirectRunTargetState,
  parseDirectRunArgs,
  resolveDirectRunFailure,
  resolveDirectRunResponse,
  type DirectRunAnyMethod,
  type DirectRunExecutionSnapshot,
  type DirectRunResultPayload
} from '~/utils/direct-run-provider'

/**
 * The Direct Run drawer, shared by the navigator and a module's deep dive.
 *
 * It is opened on a graph node id rather than a class name, and resolves the
 * provider or controller — and that target's own methods — from the graph
 * itself, so a controller and a same-named provider never share a drawer, an
 * editor, or a result. Run state is kept per node while the drawer is closed,
 * so reopening a target shows its last run.
 */
const props = withDefaults(
  defineProps<{
    graph: Pick<GraphOutput, 'modules'>
    /** Node id of the provider or controller to show; `null` closes the drawer. */
    nodeId: string | null
    directRunUrl?: string
    directRunHeaders?: Record<string, string>
    /** A graph read from a file has no application behind it to call. */
    directRunDisabled?: boolean
  }>(),
  {
    directRunUrl: undefined,
    directRunHeaders: undefined,
    directRunDisabled: false
  }
)

const emit = defineEmits<{
  close: []
  /** An inspection recorded a trace, or the visitor asked for the trace history. */
  traceOpen: []
}>()

type DirectRunMode = 'run' | 'inspect'
type PendingRun = { method: string, mode: DirectRunMode }

const STATIC_GRAPH_REASON
  = 'This graph was read from a file, not served by a running application, so its methods cannot run here. Open the trace history to explore a recorded run.'
const NO_ENDPOINT_REASON = 'Direct Run endpoint is unavailable for this graph URL.'
/** `monaco.MarkerSeverity.Error`, without importing Monaco at runtime. */
const MONACO_ERROR_SEVERITY = 8

// Keyed by node id — or `nodeId:method` for an editor — so two targets, or
// two same-named methods on them, never share state.
const snapshotByNodeId = ref<Record<string, DirectRunExecutionSnapshot>>({})
const pendingByNodeId = ref<Record<string, PendingRun>>({})
const runErrorByNodeId = ref<Record<string, string>>({})
const argsInputByKey = ref<Record<string, string>>({})
const argsErrorByKey = ref<Record<string, string>>({})
const argsInvalidByKey = ref<Record<string, boolean>>({})
const activeMethod = ref('')

const target = computed(() => findDirectRunTarget(props.graph, props.nodeId))
const targetState = computed(() =>
  target.value ? getDirectRunTargetState(props.graph, target.value) : null
)

const isOpen = computed({
  get: () => Boolean(target.value),
  set: (open: boolean) => {
    if (!open) {
      emit('close')
    }
  }
})

const methodTabs = computed(() =>
  (targetState.value?.methods || []).map((method) => {
    const parameterCount = getDirectRunParameterCount(method)

    return {
      label: method.name,
      value: method.name,
      method,
      badge: parameterCount ? formatArgCount(parameterCount) : undefined
    }
  })
)

const unavailableReason = computed(() => {
  if (props.directRunDisabled) {
    return STATIC_GRAPH_REASON
  }
  return props.directRunUrl ? '' : NO_ENDPOINT_REASON
})

const pendingRun = computed(() =>
  target.value ? pendingByNodeId.value[target.value.nodeId] : undefined
)
const runError = computed(() =>
  target.value ? runErrorByNodeId.value[target.value.nodeId] || '' : ''
)
const lastRun = computed(() =>
  target.value ? snapshotByNodeId.value[target.value.nodeId] : undefined
)
const lastRunLabel = computed(() =>
  lastRun.value ? new Date(lastRun.value.updatedAt).toLocaleString() : ''
)

watch(
  () => methodTabs.value.map(tab => tab.value),
  (methodNames) => {
    if (!methodNames.includes(activeMethod.value)) {
      activeMethod.value = methodNames[0] || ''
    }
  },
  { immediate: true }
)

function formatArgCount(count: number): string {
  return `${count} ${count === 1 ? 'arg' : 'args'}`
}

function argsKey(methodName: string): string {
  return `${target.value?.nodeId}:${methodName}`
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

function getEditorPath(methodName: string): string {
  return target.value ? buildDirectRunEditorPath(target.value, methodName) : ''
}

function getArgsJsonSchema(method: DirectRunAnyMethod): Monaco.json.JSONSchema {
  // Plain JSON Schema either way; the two libraries only type it differently.
  return buildDirectRunArgsJsonSchema(method) as Monaco.json.JSONSchema
}

function getArgsInput(methodName: string): string {
  return argsInputByKey.value[argsKey(methodName)] || ''
}

function setArgsInput(methodName: string, value: unknown): void {
  const key = argsKey(methodName)
  argsInputByKey.value = {
    ...argsInputByKey.value,
    [key]: typeof value === 'string' ? value : String(value ?? '')
  }
  argsErrorByKey.value = without(argsErrorByKey.value, key)
}

function setArgsValidation(methodName: string, markers: Monaco.editor.IMarker[]): void {
  argsInvalidByKey.value = {
    ...argsInvalidByKey.value,
    [argsKey(methodName)]: markers.some(marker => marker.severity >= MONACO_ERROR_SEVERITY)
  }
}

/** The error to show under the editor: a refused Run's, else the live one. */
function getArgsError(method: DirectRunAnyMethod): string {
  const storedError = argsErrorByKey.value[argsKey(method.name)]
  if (storedError) {
    return storedError
  }

  const input = getArgsInput(method.name)
  if (!input.trim()) {
    return ''
  }

  const parsed = parseDirectRunArgs(method, input)
  return parsed.ok ? '' : parsed.error
}

function isActionDisabled(method: DirectRunAnyMethod): boolean {
  if (unavailableReason.value || pendingRun.value) {
    return true
  }

  if (getDirectRunParameterCount(method) === 0) {
    return false
  }

  return !parseDirectRunArgs(method, getArgsInput(method.name)).ok
    || Boolean(argsInvalidByKey.value[argsKey(method.name)])
}

async function runMethod(method: DirectRunAnyMethod, mode: DirectRunMode): Promise<void> {
  const current = target.value
  const url = props.directRunUrl
  if (!current || !url || props.directRunDisabled || pendingByNodeId.value[current.nodeId]) {
    return
  }

  const { nodeId } = current
  const key = argsKey(method.name)
  const parsedArgs = parseDirectRunArgs(method, argsInputByKey.value[key] ?? '')
  if (!parsedArgs.ok) {
    argsErrorByKey.value = { ...argsErrorByKey.value, [key]: parsedArgs.error }
    return
  }

  argsErrorByKey.value = without(argsErrorByKey.value, key)
  runErrorByNodeId.value = without(runErrorByNodeId.value, nodeId)
  pendingByNodeId.value = {
    ...pendingByNodeId.value,
    [nodeId]: { method: method.name, mode }
  }

  let response: DirectRunResultPayload | null = null
  try {
    const body = buildDirectRunRequest({
      moduleName: current.moduleName,
      targetType: current.targetType,
      targetName: current.targetName,
      methodName: method.name,
      args: parsedArgs.args
    })
    response = resolveDirectRunResponse(
      await $fetch<unknown>(url, {
        method: 'POST',
        headers: props.directRunHeaders,
        body
      })
    )
  } catch (error) {
    const failure = resolveDirectRunFailure(error)
    if (failure.answered) {
      response = failure.payload
    } else {
      // Nothing ran, so there is no run to record — only why it did not.
      runErrorByNodeId.value = {
        ...runErrorByNodeId.value,
        [nodeId]: failure.payload.error || ''
      }
    }
  } finally {
    pendingByNodeId.value = without(pendingByNodeId.value, nodeId)
  }

  if (!response) {
    return
  }

  const snapshot = buildDirectRunSnapshot({ response, requestedMethod: method.name })
  snapshotByNodeId.value = { ...snapshotByNodeId.value, [nodeId]: snapshot }
  if (mode === 'inspect' && snapshot.runtimeTrace) {
    emit('traceOpen')
  }
}
</script>

<template>
  <UDrawer
    v-model:open="isOpen"
    direction="right"
    :ui="{ content: 'w-screen max-w-md' }"
  >
    <template #header>
      <div class="direct-run-drawer__header">
        <div class="direct-run-drawer__heading">
          <UBadge
            :label="target?.targetType === 'controller' ? 'Controller' : 'Provider'"
            :icon="target?.targetType === 'controller' ? 'i-lucide-route' : 'i-lucide-box'"
            :color="target?.targetType === 'controller' ? 'warning' : 'primary'"
            variant="subtle"
            size="sm"
          />
          <p class="direct-run-drawer__title">
            {{ target?.targetName }}
          </p>
          <p class="direct-run-drawer__subtitle">
            {{ target?.moduleName }}
          </p>
        </div>

        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          square
          aria-label="Close direct run drawer"
          @click="isOpen = false"
        />
      </div>
    </template>

    <template #body>
      <div class="direct-run-drawer__body">
        <UAlert
          v-if="unavailableReason"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="Direct Run is unavailable"
          :description="unavailableReason"
          :actions="
            props.directRunDisabled
              ? [
                {
                  label: 'Open Trace',
                  icon: 'i-lucide-activity',
                  color: 'neutral',
                  variant: 'outline',
                  onClick: () => emit('traceOpen')
                }
              ]
              : undefined
          "
        />

        <p
          v-if="target?.targetType === 'controller'"
          class="direct-run-drawer__message"
        >
          Direct Run calls this method on the controller instance directly. It
          does not send an HTTP request and does not run guards, interceptors,
          pipes, or parameter decorators — the HTTP verb and path shown below
          are informational only, and the path leaves out any global prefix,
          RouterModule path, or version.
        </p>

        <p
          v-if="targetState && !targetState.runnable"
          class="direct-run-drawer__message"
        >
          {{ targetState.reason }}
        </p>

        <UTabs
          v-else-if="methodTabs.length"
          v-model="activeMethod"
          :items="methodTabs"
          color="primary"
          variant="pill"
          :ui="{
            root: 'gap-4',
            list: 'w-full overflow-x-auto',
            trigger: 'shrink-0',
            content: 'outline-none'
          }"
        >
          <template #content="{ item }">
            <div class="direct-run-drawer__method">
              <div class="direct-run-drawer__method-header">
                <div class="min-w-0">
                  <p class="direct-run-drawer__method-name">
                    {{ getDirectRunMethodSignature(item.method) }}
                  </p>
                  <p class="direct-run-drawer__method-subtitle">
                    {{ item.method.parameterTypes || '[]' }}
                  </p>
                </div>
                <UBadge
                  v-if="item.badge"
                  :label="item.badge"
                  color="neutral"
                  variant="soft"
                />
              </div>

              <div
                v-if="getDirectRunMethodHttp(item.method)"
                class="direct-run-drawer__http"
              >
                <UBadge
                  :label="getDirectRunMethodHttp(item.method)?.method"
                  color="neutral"
                  variant="outline"
                  size="sm"
                />
                <code class="direct-run-drawer__http-path">
                  {{ getDirectRunMethodHttp(item.method)?.path }}
                </code>
                <span class="direct-run-drawer__method-subtitle">
                  invoked directly, not over HTTP
                </span>
              </div>

              <ClientOnly v-if="item.badge">
                <JsonMonacoEditor
                  :model-value="getArgsInput(item.method.name)"
                  :path="getEditorPath(item.method.name)"
                  :schema="getArgsJsonSchema(item.method)"
                  :readonly="Boolean(pendingRun)"
                  height="240px"
                  @update:model-value="(value) => setArgsInput(item.method.name, value)"
                  @validate="(markers) => setArgsValidation(item.method.name, markers)"
                />

                <template #fallback>
                  <div class="direct-run-drawer__editor-placeholder">
                    Loading editor...
                  </div>
                </template>
              </ClientOnly>

              <p
                v-if="getArgsError(item.method)"
                class="direct-run-drawer__message direct-run-drawer__message--error"
              >
                {{ getArgsError(item.method) }}
              </p>

              <div class="direct-run-drawer__action-buttons">
                <UButton
                  type="button"
                  label="Run"
                  icon="i-lucide-play"
                  color="primary"
                  class="flex-1 justify-center"
                  :loading="pendingRun?.method === item.method.name && pendingRun.mode === 'run'"
                  :disabled="isActionDisabled(item.method)"
                  @click="runMethod(item.method, 'run')"
                />
                <UButton
                  type="button"
                  label="Inspect"
                  icon="i-lucide-chart-gantt"
                  color="neutral"
                  variant="soft"
                  class="flex-1 justify-center"
                  :loading="pendingRun?.method === item.method.name && pendingRun.mode === 'inspect'"
                  :disabled="isActionDisabled(item.method)"
                  @click="runMethod(item.method, 'inspect')"
                />
              </div>
            </div>
          </template>
        </UTabs>

        <p
          v-if="pendingRun"
          class="direct-run-drawer__status"
          role="status"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          Running {{ pendingRun.method }}()…
        </p>

        <UAlert
          v-else-if="runError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="runError"
        />

        <section
          v-if="lastRun"
          class="direct-run-drawer__result"
          aria-label="Last run"
        >
          <div class="direct-run-drawer__result-header">
            <p class="direct-run-drawer__result-title">
              Last run · {{ lastRun.method }}()
            </p>
            <UBadge
              :label="lastRun.state === 'success' ? 'Success' : 'Failed'"
              :color="lastRun.state === 'success' ? 'success' : 'error'"
              variant="subtle"
              size="sm"
            />
          </div>
          <pre
            class="direct-run-drawer__summary"
            :class="{ 'direct-run-drawer__message--error': lastRun.state === 'failed' }"
          >{{ lastRun.summary }}</pre>
          <div class="direct-run-drawer__result-footer">
            <p
              v-if="lastRunLabel"
              class="direct-run-drawer__timestamp"
            >
              {{ lastRunLabel }}
            </p>
            <UButton
              v-if="lastRun.traceId"
              icon="i-lucide-activity"
              label="Open Trace"
              color="neutral"
              variant="link"
              size="sm"
              @click="emit('traceOpen')"
            />
          </div>
        </section>
      </div>
    </template>
  </UDrawer>
</template>

<style scoped>
.direct-run-drawer__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.direct-run-drawer__heading {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.direct-run-drawer__body,
.direct-run-drawer__method,
.direct-run-drawer__result {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.direct-run-drawer__result {
  gap: 8px;
  width: 100%;
}

.direct-run-drawer__method-name,
.direct-run-drawer__method-subtitle,
.direct-run-drawer__subtitle,
.direct-run-drawer__timestamp,
.direct-run-drawer__message,
.direct-run-drawer__status,
.direct-run-drawer__result-title,
.direct-run-drawer__title {
  margin: 0;
}

.direct-run-drawer__title {
  font-size: 14px;
  font-weight: 700;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}

.direct-run-drawer__subtitle,
.direct-run-drawer__method-subtitle,
.direct-run-drawer__timestamp {
  font-size: 12px;
  color: var(--ui-text-muted);
}

.direct-run-drawer__method-subtitle {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    monospace;
  overflow-wrap: anywhere;
}

.direct-run-drawer__method-header,
.direct-run-drawer__result-header,
.direct-run-drawer__result-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.direct-run-drawer__method-name {
  min-width: 0;
  color: var(--ui-text-highlighted);
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.direct-run-drawer__http {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.direct-run-drawer__http-path {
  font-size: 12px;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}

.direct-run-drawer__action-buttons {
  display: flex;
  gap: 8px;
}

.direct-run-drawer__editor-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  color: var(--ui-text-muted);
  font-size: 13px;
}

.direct-run-drawer__message {
  font-size: 13px;
  line-height: 1.45;
  color: var(--ui-text);
  overflow-wrap: anywhere;
}

.direct-run-drawer__message--error {
  color: var(--ui-error);
}

.direct-run-drawer__status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ui-text-muted);
}

.direct-run-drawer__result-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}

.direct-run-drawer__summary {
  max-height: 12rem;
  margin: 0;
  overflow: auto;
  padding: 0.5rem;
  border-radius: 0.375rem;
  background: var(--ui-bg-elevated);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
