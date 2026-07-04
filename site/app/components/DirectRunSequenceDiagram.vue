<script setup lang="ts">
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import type { RuntimeTrace } from '~/utils/direct-run-provider'
import { buildRuntimeTraceSequenceDiagram } from '~/utils/direct-run-sequence'

const props = defineProps<{
  trace: RuntimeTrace
}>()

const diagram = computed(() => buildRuntimeTraceSequenceDiagram(props.trace))
const statusColorMap = {
  success: 'success',
  error: 'error',
  cancelled: 'warning',
  partial: 'warning',
  unknown: 'neutral'
} as const

function getStatusColor(status?: keyof typeof statusColorMap) {
  return status ? statusColorMap[status] : statusColorMap.unknown
}
</script>

<template>
  <div class="direct-run-sequence">
    <VueFlow
      :nodes="diagram.nodes"
      :edges="diagram.edges"
      :default-viewport="{ zoom: 1, x: 0, y: 0 }"
      :fit-view-on-init="true"
      :fit-view-on-init-options="{ padding: 0.15 }"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="false"
      :pan-on-drag="true"
      :pan-on-scroll="true"
      :zoom-on-scroll="true"
      :zoom-on-double-click="false"
      :min-zoom="0.4"
      :max-zoom="1.6"
      class="direct-run-sequence__flow"
    >
      <template #node-input="participantProps">
        <div class="direct-run-sequence__participant">
          <p class="direct-run-sequence__participant-title">
            {{ participantProps.data.label }}
          </p>
          <p class="direct-run-sequence__participant-subtitle">
            {{ participantProps.data.subtitle }}
          </p>
        </div>
      </template>

      <template #node-default="stepProps">
        <div
          class="direct-run-sequence__step"
          :class="`direct-run-sequence__step--${stepProps.data.status || 'unknown'}`"
        >
          <div class="direct-run-sequence__step-header">
            <p class="direct-run-sequence__step-title">
              {{ stepProps.data.label }}
            </p>
            <UBadge
              :label="`${stepProps.data.durationMs || 0} ms`"
              :color="getStatusColor(stepProps.data.status)"
              variant="soft"
            />
          </div>
          <p class="direct-run-sequence__step-subtitle">
            {{ stepProps.data.subtitle }}
          </p>
        </div>
      </template>

      <Background pattern-color="rgba(148, 163, 184, 0.22)" :gap="18" :size="1" />
    </VueFlow>
  </div>
</template>

<style>
.direct-run-sequence {
  height: 440px;
  border: 1px solid var(--mg-trace-border);
  border-radius: 12px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ui-bg) 92%, transparent);
}

.direct-run-sequence__flow {
  width: 100%;
  height: 100%;
}

.direct-run-sequence__participant,
.direct-run-sequence__step {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--mg-trace-border);
  background: var(--mg-trace-card-bg);
  box-sizing: border-box;
}

.direct-run-sequence__participant {
  justify-content: center;
  background: color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);
}

.direct-run-sequence__participant-title,
.direct-run-sequence__participant-subtitle,
.direct-run-sequence__step-title,
.direct-run-sequence__step-subtitle {
  margin: 0;
}

.direct-run-sequence__participant-title,
.direct-run-sequence__step-title {
  color: var(--ui-text-highlighted);
  font-size: 13px;
  font-weight: 700;
}

.direct-run-sequence__participant-subtitle,
.direct-run-sequence__step-subtitle {
  color: var(--ui-text-muted);
  font-size: 11px;
  line-height: 1.4;
}

.direct-run-sequence__step-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.direct-run-sequence__step--error {
  border-color: var(--mg-trace-error-border);
}

.direct-run-sequence__step--partial,
.direct-run-sequence__step--cancelled {
  border-color: var(--mg-trace-slow-border);
}

.direct-run-sequence .vue-flow__edge-text {
  fill: var(--ui-text-muted);
  font-size: 11px;
}

.direct-run-sequence .vue-flow__edge-path {
  stroke: color-mix(in srgb, var(--ui-primary) 48%, var(--mg-trace-border));
  stroke-width: 2;
}
</style>
