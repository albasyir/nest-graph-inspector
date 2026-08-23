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
const router = useRouter()
const posthog = usePostHog()
const graphStore = useGraphInspectorStore()
const {
  decodedUrl,
  graphData,
  graphIsStatic,
  status,
  errorMessage,
  showCircularDependencies,
  openModuleDetail
} = storeToRefs(graphStore)
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

  isGraphLoading.value = true

  try {
    trackGraphViewerEvent('graph_viewer_load_started', {
      loadSource,
      isRetry
    })

    // A demo endpoint only answers inside the tab that started the demo, so an
    // arriving link may need one started — and then it is a different URL.
    const endpoint = await resolveEncodedUrl(value, '')
    if (!endpoint) {
      return
    }

    const graphLoaded = await graphStore.setEncodedUrl(endpoint)
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

const directRunOn = computed(() => {
  const value = route.query['direct-run-on']
  const providerName = Array.isArray(value) ? value[0] : value
  return providerName || undefined
})

function handleDirectRunDrawerOpen(providerName: string) {
  if (route.query['direct-run-on'] === providerName) return

  router.push({
    query: {
      ...route.query,
      'direct-run-on': providerName
    }
  })
}

function handleDirectRunDrawerClose() {
  const { 'direct-run-on': _directRunOn, ...query } = route.query
  router.push({ query })
}

function handleExecutionSequenceOpen() {
  router.push({
    path: `/view/${encodedUrl.value}/execution-sequence`
  })
}
</script>

<template>
  <GraphViewerLoadingState
    v-if="isGraphLoading || status === 'pending'"
    :endpoint="decodedUrl"
    :message="startupMessage"
  />

  <!-- Error State -->
  <div
    v-else-if="status === 'error'"
    class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    role="alert"
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
      :direct-run-disabled="graphIsStatic"
      :direct-run-on="directRunOn"
      :direct-run-url="directRunUrl"
      height="100%"
      flush
      @direct-run-drawer-open="handleDirectRunDrawerOpen"
      @direct-run-drawer-close="handleDirectRunDrawerClose"
      @execution-sequence-open="handleExecutionSequenceOpen"
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
