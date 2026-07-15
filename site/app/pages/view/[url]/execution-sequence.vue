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
const { decodedUrl, graphIsStatic, status, errorMessage } = storeToRefs(graphStore)
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

const directRunUrl = computed(() => {
  if (!decodedUrl.value) return undefined
  try {
    const url = new URL(decodedUrl.value)
    url.pathname = graphIsStatic.value
      ? `${url.pathname.replace(/\/$/, '')}/direct-run`
      : '/direct-run'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
})

useSeoMeta({
  title: 'Execution Sequence',
  ogTitle: 'Execution Sequence - Nest Graph Inspector',
  description: 'Runtime direct-run execution history for the current NestJS graph.'
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

async function loadGraphResources(
  value: string,
  loadSource: 'initial_mount' | 'route_change' | 'manual_refresh',
  isRetry = false
) {
  if (!value) {
    navigateTo('/view')
    return
  }

  trackGraphViewerEvent('graph_viewer_load_started', { loadSource, isRetry })

  const graphLoaded = await graphStore.setEncodedUrl(value)
  if (graphLoaded) {
    await graphStore.fetchMarkdown()
    trackGraphViewerEvent('graph_viewer_load_succeeded', { loadSource, isRetry })
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

function openNavigator() {
  navigateTo(`/view/${urlBase64.value}`)
}
</script>

<template>
  <div class="h-full overflow-y-auto p-4 sm:p-6">
    <div
      v-if="status === 'pending'"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    >
      <div class="flex size-16 animate-pulse items-center justify-center rounded-2xl bg-primary/10">
        <UIcon name="i-lucide-loader-2" class="size-8 animate-spin text-primary" />
      </div>
      <div class="space-y-1 text-center">
        <p class="font-medium">Fetching graph data...</p>
        <p class="text-sm text-muted">Connecting to {{ decodedUrl }}</p>
      </div>
    </div>

    <div
      v-else-if="status === 'error'"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    >
      <div class="flex size-16 items-center justify-center rounded-2xl bg-red-500/10">
        <UIcon name="i-lucide-alert-triangle" class="size-8 text-red-500" />
      </div>
      <div class="space-y-2 text-center">
        <p class="text-lg font-medium">Failed to fetch graph data</p>
        <p class="max-w-md text-sm text-muted">
          {{ errorMessage || 'Could not connect to the provided URL.' }}
        </p>
        <UButton icon="i-lucide-refresh-cw" label="Retry" variant="outline" @click="handleRefresh()" />
      </div>
    </div>

    <ExecutionSequence
      v-else
      :direct-run-url="directRunUrl"
      @navigator-open="openNavigator"
    />
  </div>
</template>
