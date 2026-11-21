<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { findDirectRunTarget } from '~/utils/direct-run-provider'
import { buildModulePageLocation } from '~/utils/module-page-route'

definePageMeta({
  layout: 'viewer'
})

const route = useRoute()
const graphStore = useGraphInspectorStore()
const {
  graphData,
  errorStatus,
  endpointRequiresAccessToken,
  hasLoadError,
  graphRevision,
  showCircularDependencies,
  showBrightLine,
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

// Direct Run lives on a module's page now. A link from before — the navigator
// open on a provider or controller (`direct-run-on`, a graph node id, never a
// bare class name) — goes on to its module's page, open on it, in place of
// this one; one naming nothing in the graph is dropped from the address.
watch(
  [() => route.query['direct-run-on'], graphData],
  ([value, graph]) => {
    const nodeId = Array.isArray(value) ? value[0] : value
    if (!nodeId || !graph) {
      return
    }

    const target = findDirectRunTarget(graph, nodeId)
    const { 'direct-run-on': _directRunOn, ...query } = route.query
    void navigateTo(
      target
        ? buildModulePageLocation(target.moduleName, { view: 'inside', directRunOn: target.nodeId })
        : { query },
      { replace: true }
    )
  },
  { immediate: true }
)

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

// Asked for at once: GraphViewer's focus waits for the canvas to be laid out,
// measured and fitted — the fit it would otherwise undo — and the viewer only
// re-centres after that when it is resized.
watch(
  [graphViewerRef, focusModuleName],
  ([viewer, moduleName]) => {
    if (viewer && moduleName) {
      void viewer.focusModule(moduleName)
    }
  },
  { immediate: true }
)
</script>

<template>
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

  <ClientOnly v-else-if="graphData">
    <!-- Keyed on the graph, so opening another one starts the canvas over
         instead of carrying the last one's unsaved arrangement onto it. -->
    <GraphViewer
      :key="graphRevision"
      ref="graphViewerRef"
      v-model:show-circular-dependencies="showCircularDependencies"
      v-model:show-bright-line="showBrightLine"
      :data="graphData"
      :default-open-module-detail="openModuleDetail"
      :layout-data="layoutData"
      can-save-layout
      :layout-dirty="isLayoutDirty"
      :layout-saving="isLayoutSaving"
      :layout-save-error="layoutSaveError"
      :layout-saved-at="layoutSavedAt"
      :layout-persistence="layoutPersistence"
      can-open-module-deep-dive
      module-page-navigation="viewer"
      height="100%"
      flush
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
