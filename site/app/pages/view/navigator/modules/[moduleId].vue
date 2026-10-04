<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { decodeModuleId } from '~/utils/module-id'

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
  hasLoadError
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, startupMessage, refresh }
  = useGraphViewerPage()

/**
 * The module this page is about, or `null` for an id that does not decode.
 *
 * Read from `route.path`, not `route.params`: the router has already decoded
 * a param once, so decoding it again would turn `Already%2520Encoded` into
 * `Already Encoded` and make `100%25` throw. The path keeps the segment
 * exactly as `encodeModuleId` wrote it.
 */
const moduleName = computed(() => {
  const segment = route.path.replace(/\/+$/, '').split('/').pop() ?? ''

  try {
    return decodeModuleId(segment)
  } catch (error) {
    if (error instanceof URIError) {
      return null
    }
    throw error
  }
})

const moduleExists = computed(() =>
  Boolean(
    moduleName.value !== null
    && graphData.value
    && Object.hasOwn(graphData.value.modules, moduleName.value)
  )
)

useSeoMeta({
  title: () => `${moduleName.value ?? 'Unknown module'} - Module Deep Dive - Nest Graph Inspector`,
  description: 'One NestJS module, its providers, controllers, and dependencies.'
})

// A graph node id, kept in the query like the navigator's so a reload reopens
// the drawer on the same provider or controller.
const directRunOn = computed(() => {
  const value = route.query['direct-run-on']
  const nodeId = Array.isArray(value) ? value[0] : value
  return nodeId || undefined
})

function handleDirectRunDrawerOpen(nodeId: string) {
  if (route.query['direct-run-on'] === nodeId) return

  router.push({ query: { ...route.query, 'direct-run-on': nodeId } })
}

function handleDirectRunDrawerClose() {
  const { 'direct-run-on': _directRunOn, ...query } = route.query
  router.push({ query })
}
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

  <ClientOnly v-else-if="graphData && moduleExists && moduleName !== null">
    <ModuleGraphViewer
      :module-name="moduleName"
      :graph-data="graphData"
      :direct-run-url="directRunUrl"
      :direct-run-headers="requestHeaders"
      :direct-run-disabled="graphIsStatic"
      :direct-run-on="directRunOn"
      @direct-run-drawer-open="handleDirectRunDrawerOpen"
      @direct-run-drawer-close="handleDirectRunDrawerClose"
    />
  </ClientOnly>

  <div
    v-else-if="graphData"
    class="flex h-full min-h-0 items-center justify-center p-6"
  >
    <UAlert
      class="max-w-lg"
      color="warning"
      variant="subtle"
      icon="i-lucide-search-x"
      title="Module not found"
      :description="
        moduleName === null
          ? 'This link does not name a module.'
          : `This graph has no module named “${moduleName}”. It may have been renamed or removed since the link was made.`
      "
      :actions="[
        {
          label: 'Back to Application Graph',
          icon: 'i-lucide-arrow-left',
          color: 'neutral',
          variant: 'outline',
          to: '/view/navigator'
        }
      ]"
    />
  </div>

  <div
    v-else
    class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
  >
    <p class="text-lg font-medium">
      No data received
    </p>
    <UButton
      icon="i-lucide-refresh-cw"
      label="Retry"
      variant="outline"
      @click="refresh()"
    />
  </div>
</template>
