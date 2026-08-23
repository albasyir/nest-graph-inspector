<script setup lang="ts">
import { storeToRefs } from 'pinia'
import {
  createGraphViewerEventProperties,
  resolveGraphViewerLoadSource,
  type LoadSource
} from '~/utils/graph-viewer-analytics'
import { withAccessToken } from '~/utils/inspector-access-token'
import { resolveInspectorMountBase } from '~/utils/nodepod-demo-endpoint'

definePageMeta({
  layout: 'viewer'
})

const route = useRoute()
const posthog = usePostHog()
const graphStore = useGraphInspectorStore()
const { decodedUrl, graphIsStatic, status, errorMessage } = storeToRefs(graphStore)
const isGraphLoading = ref(false)
const { startupMessage, resolveEncodedUrl } = useNodepodDemoRoute()
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
    // A static endpoint serves direct-run history as files below the graph
    // output, while a running application mounts the live endpoint at the root
    // of its own server — the origin, or the demo's mount path in this tab.
    url.pathname = graphIsStatic.value
      ? `${url.pathname.replace(/\/$/, '')}/direct-run`
      : `${resolveInspectorMountBase(decodedUrl.value)}/direct-run`
    url.search = ''
    url.hash = ''
    return withAccessToken(url, decodedUrl.value).toString()
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

  isGraphLoading.value = true

  try {
    trackGraphViewerEvent('graph_viewer_load_started', { loadSource, isRetry })

    // A demo endpoint only answers inside the tab that started the demo, so an
    // arriving link may need one started — and then it is a different URL.
    const endpoint = await resolveEncodedUrl(value, '/execution-sequence')
    if (!endpoint) {
      return
    }

    const graphLoaded = await graphStore.setEncodedUrl(endpoint)
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
  } finally {
    isGraphLoading.value = false
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
    <GraphViewerLoadingState
      v-if="isGraphLoading || status === 'pending'"
      :endpoint="decodedUrl"
      :message="startupMessage"
    />

    <div
      v-else-if="status === 'error'"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
      role="alert"
    >
      <div class="flex size-16 items-center justify-center rounded-2xl bg-red-500/10">
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
          {{ errorMessage || 'Could not connect to the provided URL.' }}
        </p>
        <UButton
          icon="i-lucide-refresh-cw"
          label="Retry"
          variant="outline"
          @click="handleRefresh()"
        />
      </div>
    </div>

    <ExecutionSequence
      v-else
      :direct-run-url="directRunUrl"
      @navigator-open="openNavigator"
    />
  </div>
</template>
