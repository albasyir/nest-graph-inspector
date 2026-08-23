<script setup lang="ts">
import { storeToRefs } from 'pinia'

definePageMeta({
  layout: 'viewer'
})

const graphStore = useGraphInspectorStore()
const {
  directRunUrl,
  requestHeaders,
  status,
  errorMessage,
  endpointRequiresAccessToken,
  endpointUnreachable
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, refresh } = useGraphViewerPage()

useSeoMeta({
  title: 'Execution Sequence',
  ogTitle: 'Execution Sequence - Nest Graph Inspector',
  description: 'Runtime direct-run execution history for the current NestJS graph.'
})

function openNavigator() {
  navigateTo('/view/navigator')
}
</script>

<template>
  <div class="h-full overflow-y-auto p-4 sm:p-6">
    <GraphViewerLoadingState
      v-if="isGraphLoading || status === 'pending'"
      :endpoint="endpointUrl"
    />

    <GraphViewerErrorState
      v-else-if="endpointRequiresAccessToken || endpointUnreachable || status === 'error'"
      :message="errorMessage"
      :requires-access-token="endpointRequiresAccessToken"
      @retry="refresh()"
    />

    <ExecutionSequence
      v-else
      :direct-run-url="directRunUrl"
      :direct-run-headers="requestHeaders"
      @navigator-open="openNavigator"
    />
  </div>
</template>
