<script setup lang="ts">
import type {
  RuntimeTrace,
  RuntimeTraceSpan,
} from "~/utils/direct-run-provider";
import type { AccordionItem } from "@nuxt/ui";

const props = defineProps<{
  trace?: RuntimeTrace | null;
  result?: string;
  resultType?: string;
  directRunUrl?: string;
  running?: boolean;
}>();

const LABEL_COL = 180;
const BAR_MIN_W = 4;
const ROW_COLORS = [
  "#6366f1",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#f97316",
  "#ec4899",
  "#8b5cf6",
];
const activeTooltipSpanId = ref<string | null>(null);
const historyTraceIds = ref<string[]>([]);
const historyTraces = ref<Record<string, RuntimeTrace>>({});
const historyError = ref("");
const historyIndexLoading = ref(false);
const loadingTraceIds = ref<Set<string>>(new Set());
const activeHistoryTraceId = ref<string>();

const selectedTraceId = computed(() => props.trace?.traceId ?? "");
const historyItems = computed<AccordionItem[]>(() =>
  historyTraceIds.value.map((traceId) => {
    const trace = historyTraces.value[traceId];

    return {
      label: trace ? entrypointLabel(trace) : traceId,
      value: traceId,
      icon: isTraceLoading(traceId)
        ? "i-lucide-loader-circle"
        : traceId === selectedTraceId.value
          ? "i-lucide-circle-check"
          : "i-lucide-history",
    };
  }),
);

watch(
  () => props.trace,
  (trace) => {
    if (!trace) return;

    historyTraces.value = { ...historyTraces.value, [trace.traceId]: trace };
    if (historyTraceIds.value[0] !== trace.traceId) {
      historyTraceIds.value = [
        trace.traceId,
        ...historyTraceIds.value.filter((traceId) => traceId !== trace.traceId),
      ];
    }
    activeHistoryTraceId.value = trace.traceId;
  },
  { immediate: true },
);

function traceSpans(trace: RuntimeTrace) {
  const traceStart = new Date(trace.startedAt).getTime();
  const total = trace.totalDurationMs || 1;
  return [...trace.spans]
    .sort((a, b) => {
      const startedDiff =
        new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      return startedDiff || a.order - b.order;
    })
    .map((span) => {
      const spanStart = new Date(span.startedAt).getTime();
      const offsetMs = Math.max(0, spanStart - traceStart);
      const left = (offsetMs / total) * 100;
      const width = Math.max(
        (BAR_MIN_W / total) * 100,
        (span.durationMs / total) * 100,
      );
      return { span, left, width };
    });
}

const TICK_COUNT = 5;
function traceTicks(trace: RuntimeTrace) {
  const total = trace.totalDurationMs || 1;
  return Array.from({ length: TICK_COUNT + 1 }, (_, i) => ({
    pct: (i / TICK_COUNT) * 100,
    label: `${Math.round((i / TICK_COUNT) * total)} ms`,
  }));
}

function accordionTrace(item: AccordionItem): RuntimeTrace | undefined {
  return historyTraces.value[String(item.value)];
}

function accordionTraceSpans(item: AccordionItem) {
  const trace = accordionTrace(item);
  return trace ? traceSpans(trace) : [];
}

function accordionTraceTicks(item: AccordionItem) {
  const trace = accordionTrace(item);
  return trace ? traceTicks(trace) : [];
}

function entrypointLabel(trace: RuntimeTrace): string {
  const className = trace.entrypoint.className;
  const methodName = trace.entrypoint.methodName;
  return className ? `${className}.${methodName}()` : `${methodName}()`;
}

function startedAtLabel(trace: RuntimeTrace): string {
  return new Date(trace.startedAt).toLocaleString();
}

function durationLabel(trace: RuntimeTrace): string {
  return `${trace.totalDurationMs} ms`;
}

function shortTraceId(traceId: string): string {
  return traceId.slice(0, 8);
}

function isTraceLoading(traceId: string): boolean {
  return loadingTraceIds.value.has(traceId);
}

function barColor(span: RuntimeTraceSpan, index: number): string {
  if (span.status === "error") return "var(--mg-trace-error-border)";
  if (span.status === "cancelled" || span.status === "partial")
    return "var(--mg-trace-slow-border)";
  return ROW_COLORS[index % ROW_COLORS.length] ?? "#94a3b8";
}

function spanLabel(span: RuntimeTraceSpan): string {
  return span.methodName
    ? `${span.className ?? span.name}.${span.methodName}()`
    : span.name;
}

function toggleTooltip(spanId: string): void {
  activeTooltipSpanId.value =
    activeTooltipSpanId.value === spanId ? null : spanId;
}

function historyUrl(path: string): string {
  if (!props.directRunUrl) return "";
  return `${props.directRunUrl.replace(/\/$/, "")}/history/${path}`;
}

async function fetchHistoryIndex(): Promise<void> {
  const url = historyUrl("index");
  if (!url) return;

  historyIndexLoading.value = true;
  try {
    const ids = await $fetch<string[]>(url);
    const latestFirstIds = [...ids].reverse();
    historyTraceIds.value = selectedTraceId.value
      ? [
          selectedTraceId.value,
          ...latestFirstIds.filter(
            (traceId) => traceId !== selectedTraceId.value,
          ),
        ]
      : latestFirstIds;
    activeHistoryTraceId.value ||=
      selectedTraceId.value || historyTraceIds.value[0];
    historyError.value = "";
  } catch (err) {
    historyError.value =
      err instanceof Error ? err.message : "Failed to load history.";
  } finally {
    historyIndexLoading.value = false;
  }
}

async function fetchHistoryTrace(traceId: string): Promise<void> {
  if (historyTraces.value[traceId] || isTraceLoading(traceId)) return;

  const url = historyUrl(encodeURIComponent(traceId));
  if (!url) return;

  loadingTraceIds.value = new Set([...loadingTraceIds.value, traceId]);
  try {
    const trace = await $fetch<RuntimeTrace>(url);
    historyTraces.value = { ...historyTraces.value, [trace.traceId]: trace };
    activeTooltipSpanId.value = null;
    historyError.value = "";
  } catch (err) {
    historyError.value =
      err instanceof Error ? err.message : "Failed to load trace.";
  } finally {
    const nextLoadingTraceIds = new Set(loadingTraceIds.value);
    nextLoadingTraceIds.delete(traceId);
    loadingTraceIds.value = nextLoadingTraceIds;
  }
}

watch(
  () => props.directRunUrl,
  () => {
    void fetchHistoryIndex();
  },
  { immediate: true },
);

watch(activeHistoryTraceId, (traceId) => {
  if (traceId && !historyTraces.value[traceId]) {
    void fetchHistoryTrace(traceId);
  }
});

watch(historyTraceIds, (traceIds) => {
  for (const traceId of traceIds) {
    void fetchHistoryTrace(traceId);
  }
});
</script>

<template>
  <div class="exec-seq">
    <div
      v-if="running && !trace"
      class="flex items-center gap-2 p-3 text-sm text-muted"
    >
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      Running inspection…
    </div>
    <section
      v-if="historyIndexLoading || historyTraceIds.length || historyError"
      class="space-y-2"
    >
      <div
        v-if="historyIndexLoading && !historyItems.length"
        class="flex items-center gap-2 p-3 text-sm text-muted"
      >
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Loading execution history…
      </div>
      <UAccordion
        v-if="historyItems.length"
        v-model="activeHistoryTraceId"
        :items="historyItems"
      >
        <template #trailing="{ item }">
          <div class="ms-auto flex flex-wrap justify-end gap-2">
            <template v-if="accordionTrace(item)">
              <UBadge variant="soft" color="neutral">
                {{ shortTraceId(String(item.value)) }}
              </UBadge>
              <UBadge variant="soft" color="neutral">
                {{ startedAtLabel(accordionTrace(item)!) }}
              </UBadge>
              <UBadge variant="soft" color="neutral">
                {{ durationLabel(accordionTrace(item)!) }}
              </UBadge>
            </template>
            <UBadge v-else variant="soft" color="neutral">
              {{ shortTraceId(String(item.value)) }}
            </UBadge>
            <UBadge
              v-if="isTraceLoading(String(item.value))"
              variant="soft"
              color="primary"
            >
              Loading
            </UBadge>
          </div>
        </template>

        <template #content="{ item }">
          <!-- Gantt chart -->
          <div v-if="accordionTrace(item)" class="exec-seq__gantt">
            <!-- Tick axis -->
            <div
              class="exec-seq__axis"
              :style="{ paddingLeft: LABEL_COL + 'px' }"
            >
              <div
                v-for="tick in accordionTraceTicks(item)"
                :key="tick.pct"
                class="exec-seq__tick"
                :style="{ left: tick.pct + '%' }"
              >
                {{ tick.label }}
              </div>
            </div>

            <!-- Rows -->
            <div class="exec-seq__rows">
              <div
                v-for="({ span, left, width }, i) in accordionTraceSpans(item)"
                :key="span.spanId"
                class="exec-seq__row"
                :class="{ 'exec-seq__row--error': span.status === 'error' }"
              >
                <!-- Label column -->
                <div
                  class="exec-seq__row-label"
                  :style="{ width: LABEL_COL + 'px' }"
                >
                  <span class="exec-seq__row-name" :title="spanLabel(span)">{{
                    spanLabel(span)
                  }}</span>
                </div>

                <!-- Bar column -->
                <div class="exec-seq__bar-track">
                  <!-- Grid lines -->
                  <div
                    v-for="tick in accordionTraceTicks(item)"
                    :key="tick.pct"
                    class="exec-seq__gridline"
                    :style="{ left: tick.pct + '%' }"
                  />
                  <!-- Bar -->
                  <UTooltip
                    :open="activeTooltipSpanId === span.spanId"
                    :delay-duration="0"
                    :content="{ side: 'top', align: 'center', sideOffset: 8 }"
                    :ui="{
                      content:
                        '!h-auto !items-stretch !flex-col !gap-2 !p-2 w-[min(80vw,720px)] whitespace-normal',
                    }"
                    :disable-hoverable-content="true"
                    :ignore-non-keyboard-focus="true"
                    arrow
                    @update:open="
                      (value) => {
                        if (!value && activeTooltipSpanId === span.spanId)
                          activeTooltipSpanId = null;
                      }
                    "
                  >
                    <div
                      class="exec-seq__bar"
                      :style="{
                        left: left + '%',
                        width: width + '%',
                        background: barColor(span, i),
                      }"
                      role="button"
                      tabindex="0"
                      @click.stop="toggleTooltip(span.spanId)"
                      @keydown.enter.prevent="toggleTooltip(span.spanId)"
                      @keydown.space.prevent="toggleTooltip(span.spanId)"
                    >
                      <span v-if="width > 8" class="exec-seq__bar-label"
                        >{{ span.durationMs }} ms</span
                      >
                    </div>

                    <template #content>
                      <div class="exec-seq__tooltip">
                        <div class="exec-seq__tooltip-summary">
                          <div class="exec-seq__tooltip-card">
                            <span class="exec-seq__card-label">Duration</span>
                            <span class="exec-seq__card-value"
                              >{{ span.durationMs }} ms</span
                            >
                          </div>
                          <div class="exec-seq__tooltip-card">
                            <span class="exec-seq__card-label">Status</span>
                            <span
                              class="exec-seq__card-value"
                              :class="
                                span.status === 'error'
                                  ? 'exec-seq__card-value--fail'
                                  : 'exec-seq__card-value--success'
                              "
                            >
                              {{ span.status === "error" ? "Fail" : "Success" }}
                            </span>
                          </div>
                        </div>
                        <div class="exec-seq__tooltip-card">
                          <span class="exec-seq__card-label">Parameters</span>
                          <pre>{{ span.metadata?.argsPreview ?? "—" }}</pre>
                        </div>
                        <div class="exec-seq__tooltip-card">
                          <span class="exec-seq__card-label">Return</span>
                          <pre>{{
                            span.metadata?.resultPreview ??
                            span.errorMessage ??
                            "—"
                          }}</pre>
                        </div>
                      </div>
                    </template>
                  </UTooltip>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="flex items-center gap-2 p-3 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            Loading trace…
          </div>
        </template>
      </UAccordion>
      <p v-if="historyError" class="text-sm text-error">{{ historyError }}</p>
    </section>
  </div>
</template>

<style scoped>
.exec-seq {
  font-family: ui-sans-serif, system-ui, sans-serif;
}

.exec-seq__card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--mg-trace-border);
  border-radius: 8px;
  background: var(--mg-trace-card-bg);
}

.exec-seq__card-label {
  font-size: 10px;
  color: var(--ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.exec-seq__card-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}

.exec-seq__card-value--success {
  color: var(--ui-color-success-500);
}

.exec-seq__card-value--fail {
  color: var(--ui-color-error-500);
}

/* Gantt */
.exec-seq__gantt {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--mg-trace-border);
  border-radius: 8px;
  overflow: hidden;
}

/* Tick axis */
.exec-seq__axis {
  position: relative;
  height: 24px;
  border-bottom: 1px solid var(--mg-trace-border);
  background: var(--mg-trace-card-bg);
  flex-shrink: 0;
}

.exec-seq__tick {
  position: absolute;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--ui-text-muted);
  top: 50%;
  translate: 0 -50%;
  white-space: nowrap;
}

/* Rows */
.exec-seq__rows {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  max-height: 380px;
}

.exec-seq__row {
  display: flex;
  align-items: center;
  min-height: 36px;
  border-bottom: 1px solid
    color-mix(in srgb, var(--mg-trace-border) 50%, transparent);
}

.exec-seq__row:last-child {
  border-bottom: none;
}

.exec-seq__row--error .exec-seq__row-label {
  color: var(--ui-color-error-500);
}

.exec-seq__row-label {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 4px 10px 4px 12px;
  gap: 1px;
  flex-shrink: 0;
  border-right: 1px solid var(--mg-trace-border);
  background: var(--mg-trace-card-bg);
}

.exec-seq__row-name {
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, "SF Mono", monospace;
  color: var(--ui-text-highlighted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Bar track */
.exec-seq__bar-track {
  position: relative;
  flex: 1;
  height: 100%;
  min-height: 36px;
  overflow: hidden;
}

.exec-seq__gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--mg-trace-border) 60%, transparent);
  pointer-events: none;
}

.exec-seq__bar {
  position: absolute;
  top: 50%;
  translate: 0 -50%;
  height: 18px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  padding: 0 5px;
  min-width: 4px;
  transition: filter 0.1s;
  cursor: default;
}

.exec-seq__bar:hover {
  filter: brightness(1.15);
}

.exec-seq__bar-label {
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
}

.exec-seq__tooltip {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 11px;
  white-space: normal !important;
  overflow-wrap: anywhere;
}

.exec-seq__tooltip-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.exec-seq__tooltip-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--mg-trace-border);
  border-radius: 8px;
  background: var(--mg-trace-card-bg);
  overflow-wrap: anywhere;
}

.exec-seq__tooltip-card pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ui-text-highlighted);
  font-family: ui-monospace, "SF Mono", monospace;
}
</style>
