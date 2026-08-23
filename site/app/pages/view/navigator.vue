<script setup lang="ts">
import { storeToRefs } from 'pinia'

definePageMeta({
  layout: 'viewer'
})

const route = useRoute()
const router = useRouter()
const graphStore = useGraphInspectorStore()
const {
  directRunUrl,
  requestHeaders,
  graphData,
  graphIsStatic,
  status,
  errorMessage,
  endpointRequiresAccessToken,
  endpointUnreachable,
  showCircularDependencies,
  openModuleDetail
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, refresh } = useGraphViewerPage()

useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'Viewing NestJS dependency graph data.'
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
  router.push('/view/execution-sequence')
}
</script>

<template>
  <GraphViewerLoadingState
    v-if="isGraphLoading || status === 'pending'"
    :endpoint="endpointUrl"
  />

  <!-- Error State -->
  <GraphViewerErrorState
    v-else-if="endpointRequiresAccessToken || endpointUnreachable || status === 'error'"
    :message="errorMessage"
    :requires-access-token="endpointRequiresAccessToken"
    @retry="refresh()"
  />

  <!-- Graph -->
  <ClientOnly v-else-if="graphData">
    <GraphViewer
      v-model:show-circular-dependencies="showCircularDependencies"
      :data="graphData"
      :default-open-module-detail="openModuleDetail"
      :direct-run-disabled="graphIsStatic"
      :direct-run-on="directRunOn"
      :direct-run-url="directRunUrl"
      :direct-run-headers="requestHeaders"
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
        @click="refresh()"
      />
    </div>
  </div>
</template>
