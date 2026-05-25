<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { buildCircularIssueFlow } from '~/utils/circular-dependency-flow'
import { collectCircularDependencyIssues } from '~/utils/circular-dependency-issues'

definePageMeta({
  layout: 'viewer'
})

const route = useRoute()
const posthog = usePostHog()
const graphStore = useGraphInspectorStore()
const { decodedUrl, graphData, status, errorMessage } = storeToRefs(graphStore)

const urlBase64 = computed(() => {
  const param = route.params.url
  return Array.isArray(param) ? param[0] : param
})

const encodedUrl = computed(() => {
  if (!urlBase64.value) return ''
  try {
    return decodeURIComponent(urlBase64.value)
  } catch {
    return ''
  }
})

const issues = computed(() => collectCircularDependencyIssues(graphData.value))

useSeoMeta({
  title: 'Graph Issues',
  ogTitle: 'Graph Issues - Nest Graph Inspector',
  description: 'Circular dependencies found in the current NestJS graph.'
})

async function loadGraphResources(value: string) {
  if (!value) {
    navigateTo('/view')
    return
  }

  const graphLoaded = await graphStore.setEncodedUrl(value)
  if (graphLoaded) {
    await graphStore.fetchMarkdown()
  }

  if (graphLoaded) {
    posthog?.capture('Graph Loaded', {
      url: decodedUrl.value
    })
  } else {
    posthog?.capture('Graph Load Failed', {
      url: decodedUrl.value,
      error_message: errorMessage.value || 'Unknown error'
    })
  }

  if (!graphStore.decodedUrl) {
    navigateTo('/view')
  }
}

onMounted(() => {
  loadGraphResources(encodedUrl.value)
})

watch(encodedUrl, (value) => {
  loadGraphResources(value)
})

function handleRefresh() {
  graphStore.fetchGraph()
}
</script>

<template>
  <div class="h-full overflow-y-auto p-4 sm:p-6">
    <div
      v-if="status === 'pending'"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    >
      <div
        class="flex size-16 animate-pulse items-center justify-center rounded-2xl bg-primary/10"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="size-8 animate-spin text-primary"
        />
      </div>
      <div class="space-y-1 text-center">
        <p class="font-medium">
          Fetching graph data...
        </p>
        <p class="text-sm text-muted">
          Connecting to {{ decodedUrl }}
        </p>
      </div>
    </div>

    <div
      v-else-if="status === 'error'"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    >
      <div
        class="flex size-16 items-center justify-center rounded-2xl bg-red-500/10"
      >
        <UIcon
          name="i-lucide-alert-triangle"
          class="size-8 text-red-500"
        />
      </div>
      <div class="space-y-2 text-center">
        <p class="text-lg font-medium">
          Failed to fetch graph data
        </p>
        <p class="max-w-md text-sm text-muted">
          {{
            errorMessage
              || 'Could not connect to the provided URL. Make sure your NestJS app is running and the endpoint is accessible.'
          }}
        </p>
        <div class="mt-4 flex items-center justify-center gap-2">
          <UButton
            icon="i-lucide-refresh-cw"
            label="Retry"
            variant="outline"
            @click="handleRefresh()"
          />
          <UButton
            icon="i-lucide-link"
            label="Try Another URL"
            variant="soft"
            to="/view"
          />
        </div>
      </div>
    </div>

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
          @click="handleRefresh()"
        />
      </div>
    </div>
  </div>
</template>
