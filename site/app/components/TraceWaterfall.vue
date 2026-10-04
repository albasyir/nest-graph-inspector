<script setup lang="ts">
import type { GraphOutput } from 'nest-graph-inspector'
import { useClipboard } from '@vueuse/core'
import type {
  DirectRunResultPayload,
  RuntimeTrace,
  RuntimeTraceSpan
} from '~/utils/direct-run-provider'
import {
  buildDirectRunRequest,
  canRerunSpanAsProvider
} from '~/utils/direct-run-provider'
import type { SpanKind, SpanStatusColor, WaterfallRow } from '~/utils/trace-waterfall'
import {
  buildSpanHierarchy,
  computeTimelineRulerTicks,
  formatDuration,
  resolveSpanKind,
  resolveSpanStatus,
  resolveTraceStatus,
  spanLabel
} from '~/utils/trace-waterfall'

const props = defineProps<{
  trace?: RuntimeTrace | null
  result?: string
  resultType?: string
  directRunUrl?: string
  directRunHeaders?: Record<string, string>
  running?: boolean
  // What tells a provider span from a controller span: the trace cannot.
  graph?: GraphOutput | null
}>()

const emit = defineEmits<{
  navigatorOpen: []
}>()

type RuntimeTraceHistoryItem = Pick<
  RuntimeTrace,
  'traceId' | 'entrypoint' | 'status' | 'startedAt' | 'totalDurationMs'
>

const historyIndex = ref<RuntimeTraceHistoryItem[]>([])
const historyTraces = ref<Record<string, RuntimeTrace>>({})
const historyError = ref('')
const historyIndexLoading = ref(false)
const loadingTraceIds = ref<Set<string>>(new Set())
const rerunningSpanIds = ref<Set<string>>(new Set())
const rerunErrors = ref<Record<string, string>>({})
const activeTraceId = ref<string>()
const collapsedSpanIds = ref<Set<string>>(new Set())
const selectedSpanId = ref<string | null>(null)

const { copy, copied, isSupported: canCopy } = useClipboard({ copiedDuring: 1500 })
const copiedKey = ref('')

const selectedTraceId = computed(() => props.trace?.traceId ?? '')

const activeTrace = computed(() =>
  activeTraceId.value ? historyTraces.value[activeTraceId.value] : undefined
)
const activeSummary = computed(() =>
  activeTraceId.value ? historyItem(activeTraceId.value) : undefined
)
const activeTraceStatus = computed(() => {
  const trace = activeTrace.value ?? activeSummary.value
  return trace ? resolveTraceStatus(trace) : undefined
})

/**
 * Rows actually drawn — descendants of a collapsed span are left out — with
 * what each one shows worked out once rather than per binding.
 */
const rows = computed(() =>
  activeTrace.value
    ? buildSpanHierarchy(activeTrace.value, collapsedSpanIds.value).map(row => ({
        ...row,
        label: spanLabel(row.span),
        status: resolveSpanStatus(row.span),
        kind: spanKind(row.span)
      }))
    : []
)

/**
 * Every span's row, collapsed or not — so the inspector keeps showing a span
 * whose ancestor was collapsed after it was selected.
 */
const rowsBySpanId = computed(() => new Map(
  activeTrace.value
    ? buildSpanHierarchy(activeTrace.value).map(row => [row.span.spanId, row])
    : []
))

const parentSpanIds = computed(() =>
  [...rowsBySpanId.value.values()]
    .filter(row => row.hasChildren)
    .map(row => row.span.spanId)
)

const ticks = computed(() =>
  computeTimelineRulerTicks(activeTrace.value?.totalDurationMs ?? 0)
)

const selectedRow = computed(() =>
  selectedSpanId.value ? rowsBySpanId.value.get(selectedSpanId.value) : undefined
)

const historyOptions = computed(() =>
  historyIndex.value.map((summary) => {
    const trace = historyTraces.value[summary.traceId] ?? summary

    return {
      label: entrypointLabel(trace),
      value: summary.traceId,
      // A legacy index carries ids only, so there is nothing else to show.
      description: trace.startedAt
        ? [
            resolveTraceStatus(trace).label,
            formatDuration(trace.totalDurationMs),
            startedAtLabel(trace)
          ].join(' · ')
        : shortTraceId(summary.traceId),
      icon: isTraceLoading(summary.traceId)
        ? 'i-lucide-loader-circle'
        : 'i-lucide-activity'
    }
  })
)

watch(
  () => props.trace,
  (trace) => {
    if (trace) adoptTrace(trace)
  },
  { immediate: true }
)

watch(activeTraceId, (traceId) => {
  // Collapsed and selected spans belong to the trace they were chosen in.
  collapsedSpanIds.value = new Set()
  selectedSpanId.value = null
  if (traceId && !historyTraces.value[traceId]) {
    void fetchHistoryTrace(traceId)
  }
})

watch(
  () => props.directRunUrl,
  () => {
    void fetchHistoryIndex()
  },
  { immediate: true }
)

/** Puts a trace at the top of the history and shows it. */
function adoptTrace(trace: RuntimeTrace): void {
  historyTraces.value = { ...historyTraces.value, [trace.traceId]: trace }
  historyIndex.value = [
    historySummary(trace),
    ...historyIndex.value.filter(item => item.traceId !== trace.traceId)
  ]
  activeTraceId.value = trace.traceId
}

function entrypointLabel(trace: Pick<RuntimeTrace, 'entrypoint'>): string {
  const { className, methodName } = trace.entrypoint
  return className ? `${className}.${methodName}()` : `${methodName}()`
}

function startedAtLabel(trace: Pick<RuntimeTrace, 'startedAt'>): string {
  return new Date(trace.startedAt).toLocaleString()
}

function historySummary(trace: RuntimeTrace): RuntimeTraceHistoryItem {
  return {
    traceId: trace.traceId,
    entrypoint: trace.entrypoint,
    startedAt: trace.startedAt,
    status: trace.status,
    totalDurationMs: trace.totalDurationMs
  }
}

function normalizeHistoryItem(
  item: string | RuntimeTraceHistoryItem
): RuntimeTraceHistoryItem {
  if (typeof item !== 'string') return item

  return {
    traceId: item,
    entrypoint: { methodName: item },
    startedAt: '',
    status: 'success',
    totalDurationMs: 0
  }
}

function historyItem(traceId: string): RuntimeTraceHistoryItem | undefined {
  const trace = historyTraces.value[traceId]
  return trace
    ? historySummary(trace)
    : historyIndex.value.find(item => item.traceId === traceId)
}

function shortTraceId(traceId: string): string {
  return traceId.slice(0, 8)
}

function isTraceLoading(traceId: string): boolean {
  return loadingTraceIds.value.has(traceId)
}

function isSpanRerunning(spanId: string): boolean {
  return rerunningSpanIds.value.has(spanId)
}

function canRerunSpan(span: RuntimeTraceSpan): boolean {
  return Boolean(props.directRunUrl) && canRerunSpanAsProvider(props.graph, span)
}

/** Why a span offers no re-run, in the inspector's words. */
function rerunUnavailableReason(span: RuntimeTraceSpan): string {
  if (!props.directRunUrl) {
    return 'Direct Run is unavailable for this graph.'
  }
  if (spanKind(span) === 'controller') {
    return 'A trace does not record whether a span ran on a provider or a controller, so a re-run can only be sent as a provider — and this is a controller.'
  }
  return 'Only a span whose class the graph knows as a provider of its module can be re-run.'
}

function spanKind(span: RuntimeTraceSpan): SpanKind {
  return resolveSpanKind(span, props.graph)
}

const KIND_LABELS: Record<SpanKind, string> = {
  controller: 'Controller',
  provider: 'Provider',
  unknown: 'Unknown'
}

const BAR_COLORS: Record<SpanStatusColor, string> = {
  success: 'var(--ui-color-success-500)',
  error: 'var(--ui-color-error-500)',
  warning: 'var(--ui-color-warning-500)',
  neutral: 'var(--ui-color-neutral-400)'
}

/**
 * Where a bar's duration goes: inside when the bar has room for it, otherwise
 * beside it — after, unless that would run off the end of the timeline.
 */
function barLabelPlacement(row: WaterfallRow): 'inside' | 'after' | 'before' {
  if (row.widthPercent >= 14) return 'inside'
  return row.leftPercent + row.widthPercent <= 82 ? 'after' : 'before'
}

function offsetLabel(offsetMs: number): string {
  return offsetMs === 0 ? '+0 ms' : `+${formatDuration(offsetMs)}`
}

function previewLabel(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function spanOutcome(span: RuntimeTraceSpan): { title: string, body: string } {
  if (span.status === 'error') {
    const heading = [span.errorName, span.errorMessage].filter(Boolean).join(': ')
    return {
      title: 'Error',
      body: heading || previewLabel(span.result)
    }
  }
  return { title: 'Return value', body: previewLabel(span.result) }
}

function spanMetadataEntries(span: RuntimeTraceSpan): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ['Span ID', span.spanId],
    ['Parent span', span.parentSpanId ?? '—'],
    ['Order', String(span.order)],
    [
      'Awaited',
      span.metadata?.awaited === false
        ? 'No'
        : span.metadata?.awaited === true ? 'Yes' : '—'
    ]
  ]
  if (span.resource) entries.push(['Resource', span.resource])
  for (const [key, value] of Object.entries(span.metadata ?? {})) {
    if (key !== 'awaited') entries.push([key, String(value)])
  }
  return entries
}

function selectSpan(spanId: string): void {
  selectedSpanId.value = spanId
}

function toggleCollapsed(spanId: string): void {
  const next = new Set(collapsedSpanIds.value)
  if (!next.delete(spanId)) next.add(spanId)
  collapsedSpanIds.value = next
}

function collapseAll(): void {
  collapsedSpanIds.value = new Set(parentSpanIds.value)
}

function expandAll(): void {
  collapsedSpanIds.value = new Set()
}

async function copyValue(key: string, value: string): Promise<void> {
  copiedKey.value = key
  await copy(value)
}

function isCopied(key: string): boolean {
  return copied.value && copiedKey.value === key
}

function historyUrl(path: string): string {
  if (!props.directRunUrl) return ''
  return `${props.directRunUrl.replace(/\/$/, '')}/history/${path}.json`
}

async function fetchHistoryIndex(): Promise<void> {
  const url = historyUrl('index')
  if (!url) return

  historyIndexLoading.value = true
  try {
    const items = await $fetch<Array<string | RuntimeTraceHistoryItem>>(url, {
      headers: props.directRunHeaders
    })
    const latestFirstItems = [...items].map(normalizeHistoryItem).reverse()
    const selectedTrace = historyTraces.value[selectedTraceId.value]
    historyIndex.value = selectedTraceId.value
      ? [
          selectedTrace
            ? historySummary(selectedTrace)
            : normalizeHistoryItem(selectedTraceId.value),
          ...latestFirstItems.filter(
            item => item.traceId !== selectedTraceId.value
          )
        ]
      : latestFirstItems
    activeTraceId.value
      ||= selectedTraceId.value || historyIndex.value[0]?.traceId
    historyError.value = ''
  } catch (err) {
    historyError.value
      = err instanceof Error ? err.message : 'Failed to load history.'
  } finally {
    historyIndexLoading.value = false
  }
}

async function fetchHistoryTrace(traceId: string): Promise<void> {
  if (historyTraces.value[traceId] || isTraceLoading(traceId)) return

  const url = historyUrl(encodeURIComponent(traceId))
  if (!url) return

  loadingTraceIds.value = new Set([...loadingTraceIds.value, traceId])
  try {
    const trace = await $fetch<RuntimeTrace>(url, {
      headers: props.directRunHeaders
    })
    historyTraces.value = { ...historyTraces.value, [trace.traceId]: trace }
    historyError.value = ''
  } catch (err) {
    historyError.value
      = err instanceof Error ? err.message : 'Failed to load trace.'
  } finally {
    const nextLoadingTraceIds = new Set(loadingTraceIds.value)
    nextLoadingTraceIds.delete(traceId)
    loadingTraceIds.value = nextLoadingTraceIds
  }
}

async function rerunSpan(span: RuntimeTraceSpan): Promise<void> {
  if (!canRerunSpan(span) || isSpanRerunning(span.spanId)) return

  const { [span.spanId]: _previousError, ...otherErrors } = rerunErrors.value
  rerunErrors.value = otherErrors
  rerunningSpanIds.value = new Set([...rerunningSpanIds.value, span.spanId])
  try {
    const response = await $fetch<DirectRunResultPayload>(props.directRunUrl!, {
      method: 'POST',
      headers: props.directRunHeaders,
      body: buildDirectRunRequest({
        moduleName: span.moduleName!,
        // A trace span records no target type, so a re-run can only ever be
        // a provider one. canRerunSpan() lets through only spans the graph
        // knows solely as a provider of their module: re-sent as a provider,
        // a controller span would 404 — or run a same-named provider instead.
        targetType: 'provider',
        targetName: span.className!,
        methodName: span.methodName!,
        args: Array.isArray(span.args) ? span.args : []
      })
    })
    if (response.runtimeTrace) {
      adoptTrace(response.runtimeTrace)
    } else {
      await fetchHistoryIndex()
    }
  } catch (err) {
    const payload = (err as { data?: DirectRunResultPayload }).data
    // A run that failed was still traced; its trace is the clearest account
    // of what went wrong, so it is shown rather than summarised.
    if (payload?.runtimeTrace) {
      adoptTrace(payload.runtimeTrace)
    } else {
      rerunErrors.value = {
        ...rerunErrors.value,
        [span.spanId]: payload?.error
          || (err instanceof Error ? err.message : 'Failed to rerun span.')
      }
    }
  } finally {
    const nextRerunningSpanIds = new Set(rerunningSpanIds.value)
    nextRerunningSpanIds.delete(span.spanId)
    rerunningSpanIds.value = nextRerunningSpanIds
  }
}
</script>

<template>
  <div class="trace-waterfall space-y-4">
    <div
      v-if="running && !trace"
      class="flex items-center gap-2 rounded-xl border border-default p-3 text-sm text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      Running inspection…
    </div>

    <div
      v-if="historyIndexLoading && !historyIndex.length"
      class="flex min-h-[240px] items-center justify-center gap-2 rounded-xl border border-default text-sm text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      Loading trace history…
    </div>

    <template v-else-if="historyIndex.length">
      <!-- Selected trace summary and history switcher -->
      <section class="rounded-xl border border-default bg-default p-4">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0 flex-1 space-y-2">
            <p class="text-xs font-semibold uppercase tracking-wide text-muted">
              Trace
            </p>
            <h2
              class="truncate font-mono text-base font-semibold text-highlighted sm:text-lg"
              :title="activeSummary ? entrypointLabel(activeSummary) : undefined"
            >
              {{ activeSummary ? entrypointLabel(activeSummary) : 'Select a trace' }}
            </h2>
            <div
              v-if="activeSummary"
              class="flex flex-wrap items-center gap-1.5"
            >
              <UBadge
                v-if="activeTraceStatus"
                :color="activeTraceStatus.color"
                variant="subtle"
                :icon="activeTraceStatus.color === 'warning' ? 'i-lucide-triangle-alert' : undefined"
              >
                {{ activeTraceStatus.label }}
              </UBadge>
              <UBadge
                v-if="activeSummary.startedAt"
                color="neutral"
                variant="outline"
                icon="i-lucide-timer"
              >
                {{ formatDuration(activeSummary.totalDurationMs) }}
              </UBadge>
              <UBadge
                v-if="activeTrace"
                color="neutral"
                variant="outline"
                icon="i-lucide-layers"
              >
                {{ activeTrace.spans.length }} {{ activeTrace.spans.length === 1 ? 'span' : 'spans' }}
              </UBadge>
              <UBadge
                v-if="activeSummary.startedAt"
                color="neutral"
                variant="outline"
                icon="i-lucide-clock"
              >
                {{ startedAtLabel(activeSummary) }}
              </UBadge>
              <UBadge
                color="neutral"
                variant="soft"
                icon="i-lucide-hash"
                class="font-mono"
                :title="activeSummary.traceId"
              >
                {{ shortTraceId(activeSummary.traceId) }}
              </UBadge>
            </div>
          </div>

          <div class="flex w-full items-center gap-2 sm:w-auto">
            <USelectMenu
              v-model="activeTraceId"
              :items="historyOptions"
              value-key="value"
              icon="i-lucide-history"
              placeholder="Select a trace"
              :search-input="{ placeholder: 'Search traces…' }"
              class="min-w-0 flex-1 sm:w-80 sm:flex-none"
              aria-label="Trace history"
            />
            <UTooltip text="Reload trace history">
              <UButton
                icon="i-lucide-refresh-cw"
                color="neutral"
                variant="outline"
                :loading="historyIndexLoading"
                aria-label="Reload trace history"
                @click="fetchHistoryIndex()"
              />
            </UTooltip>
          </div>
        </div>
      </section>

      <UAlert
        v-if="historyError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="historyError"
      />

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <!-- Waterfall -->
        <section class="min-w-0 overflow-hidden rounded-xl border border-default bg-default">
          <div
            v-if="!activeTrace"
            class="flex min-h-[240px] items-center justify-center gap-2 text-sm text-muted"
          >
            <template v-if="activeTraceId && isTraceLoading(activeTraceId)">
              <UIcon
                name="i-lucide-loader-circle"
                class="size-4 animate-spin"
              />
              Loading trace…
            </template>
            <template v-else>
              Select a trace to see its spans.
            </template>
          </div>

          <div
            v-else
            class="overflow-x-auto"
          >
            <div class="trace-waterfall__grid">
              <div class="trace-waterfall__header">
                <div class="trace-waterfall__header-tree">
                  <span>Span</span>
                  <div
                    v-if="parentSpanIds.length"
                    class="flex items-center gap-0.5"
                  >
                    <UTooltip text="Expand all">
                      <UButton
                        icon="i-lucide-chevrons-up-down"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        aria-label="Expand all spans"
                        @click="expandAll"
                      />
                    </UTooltip>
                    <UTooltip text="Collapse all">
                      <UButton
                        icon="i-lucide-chevrons-down-up"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        aria-label="Collapse all spans"
                        @click="collapseAll"
                      />
                    </UTooltip>
                  </div>
                </div>
                <div class="trace-waterfall__ruler">
                  <span
                    v-for="tick in ticks"
                    :key="tick.valueMs"
                    class="trace-waterfall__tick"
                    :class="{
                      'trace-waterfall__tick--first': tick.percent === 0,
                      'trace-waterfall__tick--last': tick.percent > 92
                    }"
                    :style="{ left: `${tick.percent}%` }"
                  >{{ tick.label }}</span>
                  <span class="trace-waterfall__total">
                    {{ formatDuration(activeTrace.totalDurationMs) }}
                  </span>
                </div>
              </div>

              <div class="trace-waterfall__rows">
                <div
                  v-for="row in rows"
                  :key="row.span.spanId"
                  class="trace-waterfall__row"
                  :class="{
                    'trace-waterfall__row--selected': row.span.spanId === selectedSpanId
                  }"
                  role="button"
                  tabindex="0"
                  :aria-pressed="row.span.spanId === selectedSpanId"
                  :aria-label="`${row.label}, ${row.status.label}, ${formatDuration(row.span.durationMs)}`"
                  @click="selectSpan(row.span.spanId)"
                  @keydown.enter.prevent="selectSpan(row.span.spanId)"
                  @keydown.space.prevent="selectSpan(row.span.spanId)"
                >
                  <!-- Tree -->
                  <div class="trace-waterfall__tree">
                    <span
                      v-for="level in row.depth"
                      :key="level"
                      class="trace-waterfall__guide"
                      aria-hidden="true"
                    />
                    <button
                      v-if="row.hasChildren"
                      type="button"
                      class="trace-waterfall__caret"
                      :aria-expanded="!row.isCollapsed"
                      :aria-label="`${row.isCollapsed ? 'Expand' : 'Collapse'} ${row.label}`"
                      @click.stop="toggleCollapsed(row.span.spanId)"
                      @keydown.enter.stop
                      @keydown.space.stop
                    >
                      <UIcon
                        :name="row.isCollapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                        class="size-3.5"
                      />
                    </button>
                    <span
                      v-else
                      class="trace-waterfall__caret-spacer"
                      aria-hidden="true"
                    />

                    <!-- A failure or a missing await gets a word; the rest a dot. -->
                    <UBadge
                      v-if="row.status.color === 'error'"
                      color="error"
                      variant="subtle"
                      size="sm"
                      class="shrink-0"
                    >
                      Error
                    </UBadge>
                    <UBadge
                      v-if="row.status.isNotAwaited"
                      color="warning"
                      variant="subtle"
                      size="sm"
                      icon="i-lucide-triangle-alert"
                      class="shrink-0"
                    >
                      Not awaited
                    </UBadge>
                    <span
                      v-if="row.status.color === 'success' || row.status.color === 'neutral'"
                      class="trace-waterfall__dot"
                      :style="{ background: BAR_COLORS[row.status.color] }"
                      :title="row.status.label"
                      aria-hidden="true"
                    />

                    <UBadge
                      v-if="row.kind !== 'unknown'"
                      :color="row.kind === 'controller' ? 'secondary' : 'info'"
                      variant="soft"
                      size="sm"
                      class="shrink-0 font-mono"
                      :title="KIND_LABELS[row.kind]"
                    >
                      {{ row.kind === 'controller' ? 'C' : 'P' }}
                    </UBadge>

                    <span
                      class="trace-waterfall__label"
                      :title="row.label"
                    >{{ row.label }}</span>

                    <span class="trace-waterfall__duration">
                      {{ formatDuration(row.span.durationMs) }}
                    </span>
                  </div>

                  <!-- Timeline -->
                  <div class="trace-waterfall__track">
                    <span
                      v-for="tick in ticks"
                      :key="tick.valueMs"
                      class="trace-waterfall__gridline"
                      :style="{ left: `${tick.percent}%` }"
                      aria-hidden="true"
                    />
                    <div
                      class="trace-waterfall__bar"
                      :class="{ 'trace-waterfall__bar--warning': row.status.color === 'warning' }"
                      :style="{
                        left: `${row.leftPercent}%`,
                        width: `${row.widthPercent}%`,
                        background: BAR_COLORS[row.status.color]
                      }"
                    >
                      <span
                        v-if="barLabelPlacement(row) === 'inside'"
                        class="trace-waterfall__bar-label"
                      >{{ formatDuration(row.span.durationMs) }}</span>
                    </div>
                    <span
                      v-if="barLabelPlacement(row) === 'after'"
                      class="trace-waterfall__bar-aside"
                      :style="{ left: `calc(${row.leftPercent + row.widthPercent}% + 6px)` }"
                    >{{ formatDuration(row.span.durationMs) }}</span>
                    <span
                      v-else-if="barLabelPlacement(row) === 'before'"
                      class="trace-waterfall__bar-aside"
                      :style="{ right: `calc(${100 - row.leftPercent}% + 6px)` }"
                    >{{ formatDuration(row.span.durationMs) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Span inspector -->
        <aside class="min-w-0 self-start rounded-xl border border-default bg-default xl:sticky xl:top-0">
          <div
            v-if="selectedRow"
            class="divide-y divide-default"
          >
            <div class="flex items-start justify-between gap-2 p-4">
              <div class="min-w-0 space-y-1">
                <p class="text-xs font-medium text-muted">
                  {{ KIND_LABELS[spanKind(selectedRow.span)] }}
                  <template v-if="selectedRow.span.moduleName">
                    · {{ selectedRow.span.moduleName }}
                  </template>
                </p>
                <h3 class="break-all font-mono text-sm font-semibold text-highlighted">
                  {{ spanLabel(selectedRow.span) }}
                </h3>
              </div>
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="sm"
                aria-label="Close span details"
                @click="selectedSpanId = null"
              />
            </div>

            <dl class="grid grid-cols-3 gap-3 p-4 text-sm">
              <div class="space-y-1">
                <dt class="text-xs text-muted">
                  Status
                </dt>
                <dd>
                  <UBadge
                    :color="resolveSpanStatus(selectedRow.span).color"
                    variant="subtle"
                    :icon="resolveSpanStatus(selectedRow.span).color === 'warning' ? 'i-lucide-triangle-alert' : undefined"
                  >
                    {{ resolveSpanStatus(selectedRow.span).label }}
                  </UBadge>
                </dd>
              </div>
              <div class="space-y-1">
                <dt class="text-xs text-muted">
                  Duration
                </dt>
                <dd class="font-mono font-semibold text-highlighted">
                  {{ formatDuration(selectedRow.span.durationMs) }}
                </dd>
              </div>
              <div class="space-y-1">
                <dt class="text-xs text-muted">
                  Offset
                </dt>
                <dd class="font-mono font-semibold text-highlighted">
                  {{ offsetLabel(selectedRow.offsetMs) }}
                </dd>
              </div>
            </dl>

            <div class="space-y-2 p-4">
              <UButton
                icon="i-lucide-refresh-cw"
                label="Rerun"
                color="primary"
                variant="soft"
                size="sm"
                :loading="isSpanRerunning(selectedRow.span.spanId)"
                :disabled="!canRerunSpan(selectedRow.span)"
                @click="rerunSpan(selectedRow.span)"
              />
              <p
                v-if="!canRerunSpan(selectedRow.span)"
                class="text-xs text-muted"
              >
                {{ rerunUnavailableReason(selectedRow.span) }}
              </p>
              <p
                v-if="rerunErrors[selectedRow.span.spanId]"
                class="text-xs text-error"
                role="alert"
              >
                {{ rerunErrors[selectedRow.span.spanId] }}
              </p>
            </div>

            <div class="space-y-2 p-4">
              <div class="flex items-center justify-between gap-2">
                <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">
                  Parameters
                </h4>
                <UButton
                  v-if="canCopy"
                  :icon="isCopied('args') ? 'i-lucide-check' : 'i-lucide-copy'"
                  :label="isCopied('args') ? 'Copied' : 'Copy'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  @click="copyValue('args', previewLabel(selectedRow.span.args))"
                />
              </div>
              <pre class="trace-waterfall__code">{{ previewLabel(selectedRow.span.args) }}</pre>
            </div>

            <div class="space-y-2 p-4">
              <div class="flex items-center justify-between gap-2">
                <h4
                  class="text-xs font-semibold uppercase tracking-wide"
                  :class="selectedRow.span.status === 'error' ? 'text-error' : 'text-muted'"
                >
                  {{ spanOutcome(selectedRow.span).title }}
                </h4>
                <UButton
                  v-if="canCopy"
                  :icon="isCopied('result') ? 'i-lucide-check' : 'i-lucide-copy'"
                  :label="isCopied('result') ? 'Copied' : 'Copy'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  @click="copyValue('result', spanOutcome(selectedRow.span).body)"
                />
              </div>
              <pre
                class="trace-waterfall__code"
                :class="{ 'trace-waterfall__code--error': selectedRow.span.status === 'error' }"
              >{{ spanOutcome(selectedRow.span).body }}</pre>
            </div>

            <div class="space-y-2 p-4">
              <h4 class="text-xs font-semibold uppercase tracking-wide text-muted">
                Metadata
              </h4>
              <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                <template
                  v-for="[key, value] in spanMetadataEntries(selectedRow.span)"
                  :key="key"
                >
                  <dt class="text-muted">
                    {{ key }}
                  </dt>
                  <dd class="break-all font-mono text-highlighted">
                    {{ value }}
                  </dd>
                </template>
              </dl>
            </div>
          </div>

          <div
            v-else
            class="flex flex-col items-center justify-center gap-2 p-8 text-center"
          >
            <UIcon
              name="i-lucide-mouse-pointer-click"
              class="size-6 text-muted"
            />
            <p class="text-sm font-medium text-highlighted">
              Select a span
            </p>
            <p class="max-w-xs text-xs text-muted">
              Click a row or a bar to inspect its arguments, result, and timing.
            </p>
          </div>
        </aside>
      </div>
    </template>

    <template v-else>
      <UAlert
        v-if="historyError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="historyError"
      />
      <div class="flex min-h-[360px] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-default p-8 text-center">
        <div class="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
          <UIcon
            name="i-lucide-activity"
            class="size-8 text-primary"
          />
        </div>
        <div class="space-y-2">
          <p class="text-lg font-medium">
            No execution data yet
          </p>
          <p class="max-w-md text-sm text-muted">
            Run an inspection from Navigator to show trace history here.
          </p>
        </div>
        <UButton
          icon="i-lucide-navigation"
          label="Open Navigator"
          @click="emit('navigatorOpen')"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.trace-waterfall {
  --tw-row-height: 34px;
  --tw-indent: 16px;
  --tw-columns: minmax(18rem, 40%) minmax(0, 1fr);
  --tw-gridline: color-mix(in srgb, var(--ui-border) 70%, transparent);
}

/* A narrow screen scrolls the waterfall sideways rather than crushing the bars. */
.trace-waterfall__grid {
  min-width: 760px;
}

.trace-waterfall__header,
.trace-waterfall__row {
  display: grid;
  grid-template-columns: var(--tw-columns);
}

/* The header and the rows reserve the same scrollbar gutter, or the rows'
   vertical scrollbar would shift every bar against the ruler above it. */
.trace-waterfall__header,
.trace-waterfall__rows {
  scrollbar-gutter: stable;
}

.trace-waterfall__header {
  overflow-y: hidden;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}

.trace-waterfall__header-tree {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  border-right: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.trace-waterfall__ruler {
  position: relative;
  height: 36px;
  margin-inline: 12px 56px;
}

.trace-waterfall__tick {
  position: absolute;
  top: 50%;
  translate: -50% -50%;
  color: var(--ui-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.trace-waterfall__tick--first {
  translate: 0 -50%;
}

/* The last tick would collide with the total beside it. */
.trace-waterfall__tick--last {
  visibility: hidden;
}

.trace-waterfall__total {
  position: absolute;
  top: 50%;
  left: 100%;
  translate: 8px -50%;
  color: var(--ui-text-highlighted);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.trace-waterfall__rows {
  max-height: min(65vh, 640px);
  overflow-y: auto;
}

.trace-waterfall__row {
  min-height: var(--tw-row-height);
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 60%, transparent);
  cursor: pointer;
  outline: none;
  transition: background-color 0.12s;
}

.trace-waterfall__row:last-child {
  border-bottom: none;
}

.trace-waterfall__row:hover {
  background: color-mix(in srgb, var(--ui-bg-elevated) 70%, transparent);
}

.trace-waterfall__row:focus-visible {
  box-shadow: inset 0 0 0 2px var(--ui-primary);
}

.trace-waterfall__row--selected,
.trace-waterfall__row--selected:hover {
  background: color-mix(in srgb, var(--ui-primary) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--ui-primary);
}

.trace-waterfall__tree {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 10px 0 8px;
  border-right: 1px solid var(--ui-border);
}

/* One per ancestor: the line down the middle of each indent step. */
.trace-waterfall__guide {
  position: relative;
  flex: 0 0 var(--tw-indent);
  align-self: stretch;
  margin-right: -6px;
}

.trace-waterfall__guide::before {
  content: "";
  position: absolute;
  inset-block: 0;
  left: 50%;
  border-left: 1px solid var(--ui-border-accented);
}

.trace-waterfall__caret,
.trace-waterfall__caret-spacer {
  display: inline-flex;
  flex: 0 0 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
}

.trace-waterfall__caret {
  border-radius: 4px;
  color: var(--ui-text-muted);
  cursor: pointer;
}

.trace-waterfall__caret:hover {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

.trace-waterfall__caret:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 1px;
}

.trace-waterfall__dot {
  flex: 0 0 8px;
  height: 8px;
  border-radius: 9999px;
}

.trace-waterfall__label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ui-text-highlighted);
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-waterfall__duration {
  flex-shrink: 0;
  color: var(--ui-text-muted);
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.trace-waterfall__track {
  position: relative;
  min-height: var(--tw-row-height);
  margin-inline: 12px 56px;
}

.trace-waterfall__gridline {
  position: absolute;
  inset-block: 0;
  width: 1px;
  background: var(--tw-gridline);
  pointer-events: none;
}

.trace-waterfall__bar {
  position: absolute;
  top: 50%;
  display: flex;
  height: 16px;
  min-width: 3px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 9999px;
  translate: 0 -50%;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
  transition: filter 0.12s, box-shadow 0.12s;
}

.trace-waterfall__row:hover .trace-waterfall__bar {
  filter: brightness(1.08);
}

.trace-waterfall__row--selected .trace-waterfall__bar {
  box-shadow: 0 0 0 2px var(--ui-bg), 0 0 0 4px var(--ui-primary);
}

.trace-waterfall__bar-label {
  padding-inline: 6px;
  overflow: hidden;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* White on amber is hard to read in either theme. */
.trace-waterfall__bar--warning .trace-waterfall__bar-label {
  color: var(--ui-color-neutral-900);
}

.trace-waterfall__bar-aside {
  position: absolute;
  top: 50%;
  translate: 0 -50%;
  color: var(--ui-text-muted);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

.trace-waterfall__code {
  max-height: 16rem;
  margin: 0;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.trace-waterfall__code--error {
  border-color: color-mix(in srgb, var(--ui-color-error-500) 40%, transparent);
  background: color-mix(in srgb, var(--ui-color-error-500) 8%, transparent);
  color: var(--ui-color-error-600);
}

:root.dark .trace-waterfall__code--error,
.dark .trace-waterfall__code--error {
  color: var(--ui-color-error-400);
}
</style>
