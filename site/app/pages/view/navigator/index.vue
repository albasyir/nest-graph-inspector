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
  errorMessage,
  endpointRequiresAccessToken,
  hasLoadError,
  showCircularDependencies,
  openModuleDetail,
  layoutData,
  layoutPersistence,
  isLayoutDirty,
  isLayoutSaving,
  layoutSaveError,
  layoutSavedAt
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, startupMessage, refresh }
  = useGraphViewerPage()

useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'Viewing NestJS dependency graph data.'
})

// A graph node id (`controller-UserModule-UserController`), never a bare class
// name: only the id says whether it is a provider or a controller.
const directRunOn = computed(() => {
  const value = route.query['direct-run-on']
  const nodeId = Array.isArray(value) ? value[0] : value
  return nodeId || undefined
})

function handleDirectRunDrawerOpen(nodeId: string) {
  if (route.query['direct-run-on'] === nodeId) return

  router.push({
    query: {
      ...route.query,
      'direct-run-on': nodeId
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

// A module name, as the issues page links to it.
const focusModuleName = computed(() => {
  const value = route.query['focus-module']
  const moduleName = Array.isArray(value) ? value[0] : value
  return moduleName || undefined
})

type GraphViewerInstance = {
  focusModule: (moduleName: string, duration?: number) => Promise<void>
}
const graphViewerRef = ref<GraphViewerInstance | null>(null)

// GraphViewer centres the whole graph once after mounting (200 ms) and again
// on its first resize (debounced 250 ms, animated 200 ms); focusing before
// both have run would be undone by them.
const FOCUS_MODULE_SETTLE_MS = 600
let focusModuleTimer: ReturnType<typeof setTimeout> | undefined

watch(
  [graphViewerRef, focusModuleName],
  ([viewer, moduleName]) => {
    clearTimeout(focusModuleTimer)
    if (!viewer || !moduleName) {
      return
    }

    focusModuleTimer = setTimeout(() => {
      void viewer.focusModule(moduleName)
    }, FOCUS_MODULE_SETTLE_MS)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  clearTimeout(focusModuleTimer)
})
</script>

<template>
  <GraphViewerLoadingState
    v-if="isGraphLoading"
    :endpoint="endpointUrl"
    :message="startupMessage"
  />

  <GraphViewerErrorState
    v-else-if="hasLoadError"
    :message="errorMessage"
    :requires-access-token="endpointRequiresAccessToken"
    @retry="refresh()"
  />

  <ClientOnly v-else-if="graphData">
    <GraphViewer
      ref="graphViewerRef"
      v-model:show-circular-dependencies="showCircularDependencies"
      :data="graphData"
      :default-open-module-detail="openModuleDetail"
      :direct-run-disabled="graphIsStatic"
      :direct-run-on="directRunOn"
      :direct-run-url="directRunUrl"
      :direct-run-headers="requestHeaders"
      :layout-data="layoutData"
      can-save-layout
      :layout-dirty="isLayoutDirty"
      :layout-saving="isLayoutSaving"
      :layout-save-error="layoutSaveError"
      :layout-saved-at="layoutSavedAt"
      :layout-persistence="layoutPersistence"
      can-open-module-deep-dive
      height="100%"
      flush
      @direct-run-drawer-open="handleDirectRunDrawerOpen"
      @direct-run-drawer-close="handleDirectRunDrawerClose"
      @execution-sequence-open="handleExecutionSequenceOpen"
      @layout-change="graphStore.markLayoutDirty()"
      @layout-save="graphStore.saveLayout"
      @layout-download="graphStore.downloadLayout"
    />
  </ClientOnly>

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
