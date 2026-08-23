<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { buildCircularIssueFlow } from '~/utils/circular-dependency-flow'
import { collectCircularDependencyIssues } from '~/utils/circular-dependency-issues'

definePageMeta({
  layout: 'viewer'
})

const graphStore = useGraphInspectorStore()
const {
  graphData,
  status,
  errorMessage,
  endpointRequiresAccessToken,
  endpointUnreachable
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, refresh } = useGraphViewerPage()

const issues = computed(() => collectCircularDependencyIssues(graphData.value))

useSeoMeta({
  title: 'Graph Issues',
  ogTitle: 'Graph Issues - Nest Graph Inspector',
  description: 'Circular dependencies found in the current NestJS graph.'
})
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

    <div
      v-else-if="graphData"
      class="mx-auto w-full max-w-5xl space-y-4"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="space-y-1">
          <h1 class="text-lg font-semibold">
            Circular Dependencies
          </h1>
          <p class="text-sm text-muted">
            {{ issues.length }} issue{{ issues.length === 1 ? '' : 's' }} found
          </p>
        </div>
      </div>

      <UAlert
        v-if="issues.length === 0"
        icon="i-lucide-circle-check"
        color="success"
        variant="subtle"
        title="No circular dependencies found"
        description="Your current graph has no module, provider, or controller cycles."
      />

      <div
        v-else
        class="space-y-3"
      >
        <CircularDependencyIssueCard
          v-for="issue in issues"
          :key="issue.id"
          :issue="issue"
          :flow="buildCircularIssueFlow(issue)"
          :flow-id="`circular-issue-list-${issue.id}`"
        />
      </div>
    </div>

    <div
      v-else
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    >
      <div
        class="flex size-16 items-center justify-center rounded-2xl bg-primary/10"
      >
        <UIcon
          name="i-lucide-file-json"
          class="size-8 text-primary"
        />
      </div>
      <div class="space-y-2 text-center">
        <p class="text-lg font-medium">
          No data received
        </p>
        <p class="text-sm text-muted">
          The endpoint returned an empty response.
        </p>
        <UButton
          icon="i-lucide-refresh-cw"
          label="Retry"
          variant="outline"
          class="mt-2"
          @click="refresh()"
        />
      </div>
    </div>
  </div>
</template>
