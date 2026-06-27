<script setup lang="ts">
import { storeToRefs } from 'pinia'
import {
  createGraphViewerEventProperties,
  resolveGraphViewerLoadSource,
  type LoadSource
} from '~/utils/graph-viewer-analytics'

definePageMeta({
  layout: 'viewer'
})

const route = useRoute()
const posthog = usePostHog()
const graphStore = useGraphInspectorStore()
const {
  decodedUrl,
  graphData,
  status,
  errorMessage,
  showCircularDependencies,
  openModuleDetail
} = storeToRefs(graphStore)

let hasTrackedInitialMount = false

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

useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'Viewing NestJS dependency graph data.'
})

function trackGraphViewerEvent(event: string, options: {
  loadSource: LoadSource
  isRetry?: boolean
  errorMessage?: string
}) {
  posthog?.capture(event, createGraphViewerEventProperties({
    graphUrl: decodedUrl.value,
    viewerRoute: route.path,
    loadSource: options.loadSource,
    isRetry: options.isRetry,
    errorMessage: options.errorMessage
  }))
}

// Redirect to /view if no valid URL
async function loadGraphResources(
  value: string,
  loadSource: 'initial_mount' | 'route_change' | 'manual_refresh',
  isRetry = false
) {
  if (!value) {
    navigateTo('/view')
    return
  }

  trackGraphViewerEvent('graph_viewer_load_started', {
    loadSource,
    isRetry
  })

  const graphLoaded = await graphStore.setEncodedUrl(value)
  if (graphLoaded) {
    await graphStore.fetchMarkdown()
  }

  if (graphLoaded) {
    trackGraphViewerEvent('graph_viewer_load_succeeded', {
      loadSource,
      isRetry
    })
  } else {
    trackGraphViewerEvent('graph_viewer_load_failed', {
      loadSource,
      isRetry,
      errorMessage: errorMessage.value || 'Unknown error'
    })
  }

  if (!graphStore.decodedUrl) {
    navigateTo('/view')
  }
}

watch(encodedUrl, (value) => {
  const loadSource = resolveGraphViewerLoadSource(hasTrackedInitialMount)
  hasTrackedInitialMount = true
  loadGraphResources(value, loadSource)
}, { immediate: true })

function handleRefresh() {
  loadGraphResources(encodedUrl.value, 'manual_refresh', true)
}
</script>

<template>
  <!-- Loading State -->
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

  <!-- Error State -->
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

  <!-- Graph -->
  <ClientOnly v-else-if="graphData">
    <GraphViewer
      v-model:show-circular-dependencies="showCircularDependencies"
      :data="graphData"
      :default-open-module-detail="openModuleDetail"
      height="100%"
      flush
    />
  </ClientOnly>

  <!-- Empty State -->
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
</template>
