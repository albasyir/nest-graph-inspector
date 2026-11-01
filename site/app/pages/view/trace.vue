<script setup lang="ts">
import { storeToRefs } from 'pinia'

definePageMeta({
  layout: 'viewer'
})

const graphStore = useGraphInspectorStore()
const {
  directRunUrl,
  requestHeaders,
  graphData,
  errorStatus,
  endpointRequiresAccessToken,
  hasLoadError,
  isFileSource
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, startupMessage, refresh }
  = useGraphViewerPage()

useSeoMeta({
  title: 'Trace',
  ogTitle: 'Trace - Nest Graph Inspector',
  description: 'Runtime direct-run execution trace for the current NestJS graph.'
})

function openNavigator() {
  navigateTo('/view/navigator')
}
</script>

<template>
  <div class="h-full overflow-y-auto p-4 sm:p-6">
    <GraphViewerLoadingState
      v-if="isGraphLoading"
      :endpoint="endpointUrl"
      :message="startupMessage"
    />

    <GraphViewerErrorState
      v-else-if="hasLoadError"
      :status="errorStatus"
      :requires-access-token="endpointRequiresAccessToken"
      @retry="refresh()"
    />

    <!-- A trace is what Direct Run recorded against a running application,
         and a graph file has none behind it: there is nothing to show, and
         the page says so rather than an empty history. -->
    <div
      v-else-if="isFileSource"
      class="flex h-full min-h-0 items-center justify-center"
    >
      <UAlert
        class="max-w-lg"
        color="neutral"
        variant="subtle"
        icon="i-lucide-activity"
        title="No trace for a graph file"
        description="A trace records the calls Direct Run makes to a running application. A graph file has no application behind it, so there is nothing to record."
        :actions="[
          {
            label: 'Back to Navigator',
            icon: 'i-lucide-map',
            color: 'neutral',
            variant: 'outline',
            to: '/view/navigator'
          }
        ]"
      />
    </div>

    <TraceWaterfall
      v-else
      :direct-run-url="directRunUrl"
      :direct-run-headers="requestHeaders"
      :graph="graphData"
      @navigator-open="openNavigator"
    />
  </div>
</template>
