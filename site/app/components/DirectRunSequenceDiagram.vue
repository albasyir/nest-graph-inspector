<script setup lang="ts">
import VueApexCharts from 'vue3-apexcharts'
import type { ApexOptions } from 'apexcharts'
import type { RuntimeTrace, RuntimeTraceSpanStatus } from '~/utils/direct-run-provider'

const props = defineProps<{
  trace: RuntimeTrace
}>()

type TimelinePoint = {
  x: string
  y: [number, number]
  fillColor: string
  span: RuntimeTrace['spans'][number]
}

const STATUS_COLORS: Record<RuntimeTraceSpanStatus, string> = {
  success: '#22c55e',
  error: '#ef4444',
  cancelled: '#f59e0b',
  partial: '#f59e0b',
  unknown: '#64748b'
}

const chartId = useId()

function getSpanLabel(span: RuntimeTrace['spans'][number]): string {
  const owner = span.className || span.resource || span.type
  const action = span.methodName ? `${span.methodName}()` : span.name
  return `${owner}.${action}`
}

function toMs(value: string): number {
  return new Date(value).getTime()
}

const timelineSeries = computed(() => {
  const fallbackStart = toMs(props.trace.startedAt)
  const data = [...props.trace.spans]
    .sort((left, right) => left.order - right.order)
    .map<TimelinePoint>((span) => {
      const start = Number.isFinite(toMs(span.startedAt)) ? toMs(span.startedAt) : fallbackStart
      const end = span.endedAt ? toMs(span.endedAt) : start + span.durationMs
      return {
        x: getSpanLabel(span),
        y: [start, Math.max(end, start + 1)],
        fillColor: STATUS_COLORS[span.status],
        span
      }
    })

  return [{ name: 'Execution', data }]
})

const chartHeight = computed(() => Math.max(260, props.trace.spans.length * 48 + 96))

const chartOptions = computed<ApexOptions>(() => ({
  chart: {
    id: chartId,
    type: 'rangeBar',
    background: 'transparent',
    toolbar: { show: false },
    animations: { enabled: false },
    fontFamily: 'Public Sans, system-ui, sans-serif'
  },
  plotOptions: {
    bar: {
      horizontal: true,
      barHeight: '52%',
      rangeBarGroupRows: true,
      borderRadius: 6
    }
  },
  grid: {
    borderColor: 'color-mix(in srgb, var(--mg-trace-border) 70%, transparent)',
    strokeDashArray: 4,
    xaxis: { lines: { show: true } },
    yaxis: { lines: { show: false } },
    padding: { left: 8, right: 16, top: 4, bottom: 0 }
  },
  xaxis: {
    type: 'datetime',
    labels: {
      style: { colors: 'var(--ui-text-muted)', fontSize: '11px' },
      datetimeUTC: false,
      formatter: value => `${Math.max(0, Number(value) - toMs(props.trace.startedAt))} ms`
    },
    axisBorder: { color: 'var(--mg-trace-border)' },
    axisTicks: { color: 'var(--mg-trace-border)' }
  },
  yaxis: {
    labels: {
      maxWidth: 190,
      style: { colors: 'var(--ui-text-highlighted)', fontSize: '12px', fontWeight: 600 }
    }
  },
  dataLabels: {
    enabled: true,
    formatter: (_value, options) => {
      const point = options ? timelineSeries.value[0]?.data[options.dataPointIndex] : null
      return point ? `${point.span.durationMs} ms` : ''
    },
    style: { colors: ['#fff'], fontSize: '11px', fontWeight: 700 }
  },
  fill: { opacity: 0.88 },
  tooltip: {
    theme: 'dark',
    custom: ({ dataPointIndex }) => {
      const point = timelineSeries.value[0]?.data[dataPointIndex]
      if (!point) return ''
      const span = point.span
      const subtitle = span.errorMessage || `${span.moduleName || 'Unknown module'} · ${span.type}`
      return `<div class="execution-sequence-tooltip"><strong>${getSpanLabel(span)}</strong><span>${subtitle}</span><span>${span.status} · ${span.durationMs} ms</span></div>`
    }
  },
  legend: { show: false },
  states: {
    hover: { filter: { type: 'lighten', value: 0.08 } },
    active: { filter: { type: 'none' } }
  }
}))
</script>

<template>
  <div class="direct-run-sequence">
    <ClientOnly>
      <VueApexCharts
        type="rangeBar"
        width="100%"
        :height="chartHeight"
        :options="chartOptions"
        :series="timelineSeries"
      />
    </ClientOnly>
  </div>
</template>

<style>
.direct-run-sequence {
  min-height: 260px;
  border: 1px solid var(--mg-trace-border);
  border-radius: 12px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ui-bg) 92%, transparent);
}

.direct-run-sequence .apexcharts-canvas,
.direct-run-sequence .apexcharts-svg {
  background: transparent !important;
}

.direct-run-sequence-tooltip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  max-width: 320px;
  font-size: 12px;
}

.direct-run-sequence-tooltip span {
  color: #cbd5e1;
}
</style>
