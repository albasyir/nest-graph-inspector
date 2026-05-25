<script setup lang="ts">
import {
  VueFlow,
  Handle,
  Position,
  BaseEdge,
  getSmoothStepPath
} from '@vue-flow/core'
import { useDebounceFn, useElementVisibility, useResizeObserver } from '@vueuse/core'
import type { EdgeProps } from '@vue-flow/core'
import type { CircularDependencyIssue } from '~/utils/circular-dependency-issues'
import type { CircularIssueFlow } from '~/utils/circular-dependency-flow'
import { circularDependencyCategoryLabel } from '~/utils/circular-dependency-issues'

const props = withDefaults(
  defineProps<{
    issue: CircularDependencyIssue
    flow: CircularIssueFlow
    flowId?: string
    showId?: boolean
    showCategory?: boolean
  }>(),
  {
    flowId: undefined,
    showId: true,
    showCategory: true
  }
)

function cycleTypeLabel(type: CircularDependencyIssue['type']) {
  return type === 'direct' ? 'Direct' : 'Indirect'
}

function cycleTypeColor(type: CircularDependencyIssue['type']) {
  return type === 'direct' ? 'warning' : 'neutral'
}

type IssuePathEdgeData = { isBackwardEdge: boolean }
type IssuePathEdgeProps = EdgeProps<IssuePathEdgeData>

function getIssuePathEdgePath(edgeProps: IssuePathEdgeProps): string {
  const backwardCenterY
    = Math.max(edgeProps.sourceY, edgeProps.targetY) + 88
  const [path] = getSmoothStepPath({
    sourceX: edgeProps.sourceX,
    sourceY: edgeProps.sourceY,
    sourcePosition: edgeProps.sourcePosition,
    targetX: edgeProps.targetX,
    targetY: edgeProps.targetY,
    targetPosition: edgeProps.targetPosition,
    borderRadius: 8,
    offset: 22,
    centerY: edgeProps.data?.isBackwardEdge ? backwardCenterY : undefined
  })

  return path
}

const flowWrapRef = ref<HTMLElement | null>(null)
const resolvedFlowId = computed(
  () => props.flowId || `circular-issue-flow-${props.issue.id}`
)
type FlowViewportInstance = {
  fitView: (options?: { padding?: number, duration?: number }) => unknown
}
const flowInstance = ref<FlowViewportInstance | null>(null)

function handlePaneReady(instance: FlowViewportInstance): void {
  flowInstance.value = instance
  void fitIssueFlow(0)
  setTimeout(() => {
    void fitIssueFlow(0)
  }, 180)
}

async function fitIssueFlow(duration = 0): Promise<void> {
  if (!import.meta.client) {
    return
  }

  if (!flowInstance.value) {
    return
  }

  await nextTick()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await flowInstance.value.fitView({
    padding: 0.25,
    duration
  })
}

const debouncedFitIssueFlow = useDebounceFn(() => {
  void fitIssueFlow(140)
}, 120)

onMounted(() => {
  void fitIssueFlow(0)
})

watch(
  () => props.flow,
  () => {
    void fitIssueFlow(0)
  },
  { deep: true }
)

useResizeObserver(flowWrapRef, () => {
  debouncedFitIssueFlow()
})

const isFlowVisible = useElementVisibility(flowWrapRef)
watch(isFlowVisible, (isVisible) => {
  if (!isVisible) {
    return
  }

  void fitIssueFlow(0)
  setTimeout(() => {
    void fitIssueFlow(0)
  }, 180)
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          v-if="props.showId"
          :label="`#${props.issue.id}`"
          variant="soft"
        />
        <UBadge
          v-if="props.showCategory"
          :label="circularDependencyCategoryLabel[props.issue.category]"
          color="neutral"
          variant="soft"
        />
        <UBadge
          :label="cycleTypeLabel(props.issue.type)"
          :color="cycleTypeColor(props.issue.type)"
          variant="soft"
        />
      </div>
    </template>

    <div class="space-y-2">
      <p class="font-medium">
        {{ props.issue.from }} -> {{ props.issue.to }}
      </p>
      <div
        ref="flowWrapRef"
        class="issue-path-flow-wrap"
      >
        <VueFlow
          :id="resolvedFlowId"
          :nodes="props.flow.nodes"
          :edges="props.flow.edges"
          :default-viewport="{ zoom: 1, x: 0, y: 0 }"
          fit-view-on-init
          :fit-view-on-init-options="{ padding: 0.25 }"
          :min-zoom="0.6"
          :max-zoom="1.5"
          :nodes-draggable="false"
          :nodes-connectable="false"
          :elements-selectable="false"
          :pan-on-drag="false"
          :pan-on-scroll="false"
          :zoom-on-scroll="false"
          :zoom-on-pinch="false"
          :zoom-on-double-click="false"
          class="issue-path-flow"
          @pane-ready="handlePaneReady"
        >
          <template #edge-issuePath="edgeProps">
            <BaseEdge
              :id="edgeProps.id"
              :path="getIssuePathEdgePath(edgeProps)"
              :marker-end="edgeProps.markerEnd"
              :style="edgeProps.style"
              :interaction-width="edgeProps.interactionWidth"
            />
          </template>

          <template #node-issuePath="nodeProps">
            <div
              class="issue-path-flow-node"
              :class="{ 'issue-path-flow-node--endpoint': nodeProps.data.isEndpoint }"
            >
              <Handle
                id="target-left"
                type="target"
                :position="Position.Left"
              />
              <Handle
                id="target-bottom"
                type="target"
                :position="Position.Bottom"
              />
              {{ nodeProps.data.label }}
              <Handle
                id="source-right"
                type="source"
                :position="Position.Right"
              />
              <Handle
                id="source-bottom"
                type="source"
                :position="Position.Bottom"
              />
            </div>
          </template>
        </VueFlow>
      </div>
    </div>
  </UCard>
</template>

<style>
@import '@vue-flow/core/dist/style.css';
@import '@vue-flow/core/dist/theme-default.css';
</style>

<style scoped>
.issue-path-flow-wrap {
  height: 170px;
  border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
  border-radius: 8px;
  overflow: hidden;
}

.issue-path-flow {
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, var(--ui-bg-muted) 70%, transparent);
}

.issue-path-flow-node {
  width: 100%;
  height: 100%;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 8px 10px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
}

.issue-path-flow-node--endpoint {
  border-color: #f59e0b;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #f59e0b 55%, transparent);
}

.issue-path-flow :deep(.vue-flow__handle) {
  width: 6px;
  height: 6px;
  min-width: 0;
  min-height: 0;
  opacity: 0;
  border: none;
  pointer-events: none;
}
</style>
