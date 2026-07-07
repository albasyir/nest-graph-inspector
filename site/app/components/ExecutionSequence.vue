<script setup lang="ts">
import type { RuntimeTrace, RuntimeTraceSpan } from '~/utils/direct-run-provider'

const props = defineProps<{ trace: RuntimeTrace }>()

const LABEL_COL = 180
const BAR_MIN_W = 4
const ROW_COLORS = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#f97316', '#ec4899', '#8b5cf6']

const spans = computed(() => {
  const traceStart = new Date(props.trace.startedAt).getTime()
  const total = props.trace.totalDurationMs || 1
  return [...props.trace.spans]
    .sort((a, b) => {
      const startedDiff = new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      return startedDiff || a.order - b.order
    })
    .map((span) => {
      const spanStart = new Date(span.startedAt).getTime()
      const offsetMs = Math.max(0, spanStart - traceStart)
      const left = (offsetMs / total) * 100
      const width = Math.max(BAR_MIN_W / total * 100, (span.durationMs / total) * 100)
      return { span, left, width }
    })
})

const TICK_COUNT = 5
const ticks = computed(() => {
  const total = props.trace.totalDurationMs || 1
  return Array.from({ length: TICK_COUNT + 1 }, (_, i) => ({
    pct: (i / TICK_COUNT) * 100,
    label: `${Math.round((i / TICK_COUNT) * total)} ms`
  }))
})

function barColor(span: RuntimeTraceSpan, index: number): string {
  if (span.status === 'error') return 'var(--mg-trace-error-border)'
  if (span.status === 'cancelled' || span.status === 'partial') return 'var(--mg-trace-slow-border)'
  return ROW_COLORS[index % ROW_COLORS.length] ?? '#94a3b8'
}

function spanLabel(span: RuntimeTraceSpan): string {
  return span.methodName ? `${span.className ?? span.name}.${span.methodName}()` : span.name
}

const statusColorMap = {
  success: 'success',
  error: 'error',
  cancelled: 'warning',
  partial: 'warning',
} as const

function badgeColor(status: string) {
  return statusColorMap[status as keyof typeof statusColorMap] ?? 'neutral'
}
</script>

<template>
  <div class="exec-seq">
    <!-- Header -->
    <div class="exec-seq__header">
      <div>
        <p class="exec-seq__title">Execution Sequence</p>
        <p class="exec-seq__subtitle">Runtime Trace · run {{ trace.runId }}</p>
      </div>
      <UBadge
        :label="trace.status"
        :color="badgeColor(trace.status)"
        variant="soft"
      />
    </div>

    <!-- Summary cards -->
    <div class="exec-seq__summary">
      <div class="exec-seq__card">
        <span class="exec-seq__card-label">Duration</span>
        <span class="exec-seq__card-value">{{ trace.totalDurationMs }} ms</span>
      </div>
      <div class="exec-seq__card">
        <span class="exec-seq__card-label">Spans</span>
        <span class="exec-seq__card-value">{{ trace.totalSpans }}</span>
      </div>
      <div class="exec-seq__card">
        <span class="exec-seq__card-label">Slowest</span>
        <span class="exec-seq__card-value">
          {{ trace.spans.find(s => s.spanId === trace.slowestSpanId)?.name ?? '—' }}
        </span>
      </div>
      <div class="exec-seq__card">
        <span class="exec-seq__card-label">Failed</span>
        <span class="exec-seq__card-value">
          {{ trace.spans.find(s => s.spanId === trace.failedSpanId)?.name ?? '—' }}
        </span>
      </div>
    </div>

    <!-- Gantt chart -->
    <div class="exec-seq__gantt">
      <!-- Tick axis -->
      <div class="exec-seq__axis" :style="{ paddingLeft: LABEL_COL + 'px' }">
        <div
          v-for="tick in ticks"
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
          v-for="({ span, left, width }, i) in spans"
          :key="span.spanId"
          class="exec-seq__row"
          :class="{ 'exec-seq__row--error': span.status === 'error' }"
        >
          <!-- Label column -->
          <div class="exec-seq__row-label" :style="{ width: LABEL_COL + 'px' }">
            <span class="exec-seq__row-name" :title="spanLabel(span)">{{ spanLabel(span) }}</span>
            <span class="exec-seq__row-type">{{ span.type }}</span>
          </div>

          <!-- Bar column -->
          <div class="exec-seq__bar-track">
            <!-- Grid lines -->
            <div
              v-for="tick in ticks"
              :key="tick.pct"
              class="exec-seq__gridline"
              :style="{ left: tick.pct + '%' }"
            />
            <!-- Bar -->
            <div
              class="exec-seq__bar"
              :style="{
                left: left + '%',
                width: width + '%',
                background: barColor(span, i)
              }"
              :title="`${spanLabel(span)} · ${span.durationMs} ms · ${span.status}`"
            >
              <span v-if="width > 8" class="exec-seq__bar-label">{{ span.durationMs }} ms</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.exec-seq {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--mg-trace-border);
  border-radius: 12px;
  background: var(--mg-trace-bg);
  font-family: ui-sans-serif, system-ui, sans-serif;
}

.exec-seq__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.exec-seq__title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--ui-text-highlighted);
}

.exec-seq__subtitle {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--ui-text-muted);
}

/* Summary cards */
.exec-seq__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
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
  border-bottom: 1px solid color-mix(in srgb, var(--mg-trace-border) 50%, transparent);
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
  font-family: ui-monospace, 'SF Mono', monospace;
  color: var(--ui-text-highlighted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exec-seq__row-type {
  font-size: 10px;
  color: var(--ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
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

</style>
