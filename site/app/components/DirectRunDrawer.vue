<script setup lang="ts">
import type { GraphOutput } from 'nest-graph-inspector'
import { findDirectRunTarget } from '~/utils/direct-run-provider'

/**
 * `DirectRunPanel` in a drawer, for a graph with no room beside it for the
 * panel — the documentation's previews.
 *
 * The drawer is open whenever its node id names a provider or controller of
 * the graph. It unmounts the panel as it closes, so what each target ran, and
 * the arguments typed for it, are kept here, and reopening a target shows its
 * last run.
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
    /** Why Direct Run is off, for a graph with no trace history either. */
    directRunDisabledReason?: string
  }>(),
  {
    directRunUrl: undefined,
    directRunHeaders: undefined,
    directRunDisabled: false,
    directRunDisabledReason: undefined
  }
)

const emit = defineEmits<{
  close: []
  /** An inspection recorded a trace, or the visitor asked for the trace history. */
  traceOpen: []
}>()

const records = useDirectRunRecords()
const target = computed(() => findDirectRunTarget(props.graph, props.nodeId))

const isOpen = computed({
  get: () => Boolean(target.value),
  set: (open: boolean) => {
    if (!open) {
      emit('close')
    }
  }
})
</script>

<template>
  <UDrawer
    v-model:open="isOpen"
    direction="right"
    :title="target ? `Direct Run: ${target.targetName}` : 'Direct Run'"
    :description="target ? `${target.targetType === 'controller' ? 'Controller' : 'Provider'} in ${target.moduleName}` : undefined"
    :ui="{ content: 'w-screen max-w-md' }"
  >
    <template #content>
      <DirectRunPanel
        :graph="props.graph"
        :node-id="props.nodeId"
        :direct-run-url="props.directRunUrl"
        :direct-run-headers="props.directRunHeaders"
        :direct-run-disabled="props.directRunDisabled"
        :direct-run-disabled-reason="props.directRunDisabledReason"
        :records="records"
        class="h-full w-full"
        @close="isOpen = false"
        @trace-open="emit('traceOpen')"
      />
    </template>
  </UDrawer>
</template>
