<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'
import { useMediaQuery } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { hasJsDocPreview } from '~/utils/jsdoc-preview'
import type { BracketSide } from '~/utils/module-dependency-bracket'
import { decodeModuleId } from '~/utils/module-id'
import {
  buildModulePageLocation,
  parseModulePageQuery,
  type ModulePageStateInput
} from '~/utils/module-page-route'

definePageMeta({
  layout: 'viewer',
  // One page for every module. Moving to another module — clicked in the
  // bracket, or Back and Forward — keeps the page and the graph it loaded and
  // re-centres on the module, instead of loading the graph again and drawing
  // the canvas from nothing for every step.
  key: 'view-navigator-module'
})

const NAVIGATOR_PATH = '/view/navigator'

const route = useRoute()
const router = useRouter()
const graphStore = useGraphInspectorStore()
const {
  directRunUrl,
  directRunDisabledReason,
  requestHeaders,
  graphData,
  graphIsStatic,
  graphRevision,
  errorStatus,
  endpointRequiresAccessToken,
  hasLoadError
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, startupMessage, refresh, reload }
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

const graphModule = computed(() =>
  moduleName.value !== null
  && graphData.value
  && Object.hasOwn(graphData.value.modules, moduleName.value)
    ? graphData.value.modules[moduleName.value]
    : undefined
)
const isRoot = computed(() => graphData.value?.root === moduleName.value)
// As `ModuleJsDocSummary` decides it: a comment with nothing in it, such as
// `/** */`, shows nothing, so the about button would open nothing.
const hasJsDoc = computed(() => hasJsDocPreview(graphModule.value?.jsdoc))

// On a phone the header keeps to two rows — the module with its back and
// about buttons, then the view switch — and the module's JSDoc opens from the
// about button, so the canvas starts high enough to be the screen.
const isPhone = useMediaQuery('(max-width: 639.98px)')
const isAboutOpen = ref(false)
const aboutId = `module-about-${useId()}`
watch(moduleName, () => {
  isAboutOpen.value = false
})

/** The view, each side's depth and the Direct Run target, as the address says them. */
const pageState = computed(() => parseModulePageQuery(route.query))

// The title names no module: it is the one part of a viewer page outside the
// `ph-no-capture` the layout puts on the body, so a session replay would carry
// it, and the module is the visitor's graph.
useSeoMeta({
  title: 'Module Deep Dive',
  ogTitle: 'Module Deep Dive - Nest Graph Inspector',
  description: 'One NestJS module: what it needs, what needs it, and what it declares.'
})

// What Direct Run ran, kept by the page so it outlives a switch of view and a
// move to another module and back.
const directRunRecords = useDirectRunRecords()

// The page stays mounted from one module to the next, so it loads a graph the
// tab moved to on the way — the running demo, which the bootstrap middleware
// puts in place of the demo's static graph — itself. What Direct Run recorded
// stays with the graph it was recorded on: a node id in the next one can name
// another class.
watch(graphRevision, () => {
  directRunRecords.clear()
  if (!graphData.value && !isGraphLoading.value) {
    reload()
  }
})

const breadcrumbItems = computed<BreadcrumbItem[]>(() => [
  { label: 'Navigator', icon: 'i-lucide-map', to: NAVIGATOR_PATH },
  { label: 'Modules' },
  { label: moduleName.value ?? '' }
])

/** The two views, each a link to this module's page open on it. */
const viewOptions = computed(() => {
  const name = moduleName.value ?? ''
  const { view, depth, directRunOn } = pageState.value

  return ([
    { view: 'dependencies', label: 'Dependencies', icon: 'i-lucide-git-fork' },
    { view: 'inside', label: 'Inside Module', icon: 'i-lucide-boxes' }
  ] as const).map(option => ({
    ...option,
    isActive: option.view === view,
    to: buildModulePageLocation(name, {
      view: option.view,
      depth,
      directRunOn: option.view === 'inside' ? directRunOn : null
    })
  }))
})

function go(state: ModulePageStateInput): void {
  if (moduleName.value !== null) {
    void router.push(buildModulePageLocation(moduleName.value, state))
  }
}

function setDepth(side: BracketSide, depth: number): void {
  const { view, depth: current } = pageState.value
  go({ view, depth: { ...current, [side]: depth } })
}

function openDirectRun(nodeId: string): void {
  const state = pageState.value
  if (state.directRunOn !== nodeId) {
    go({ ...state, view: 'inside', directRunOn: nodeId })
  }
}

function closeDirectRun(): void {
  go({ ...pageState.value, directRunOn: null })
}

function handleTraceOpen() {
  router.push('/view/trace')
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
    :status="errorStatus"
    :requires-access-token="endpointRequiresAccessToken"
    @retry="refresh()"
  />

  <ClientOnly v-else-if="graphData && graphModule && moduleName !== null">
    <div class="flex h-full min-h-0 flex-col">
      <header class="module-page__header">
        <div class="module-page__crumbs">
          <UBreadcrumb
            :items="breadcrumbItems"
            color="neutral"
            class="min-w-0"
          />
          <UButton
            icon="i-lucide-arrow-left"
            label="Back to Application Graph"
            color="neutral"
            variant="outline"
            size="xs"
            class="shrink-0"
            :to="NAVIGATOR_PATH"
          />
        </div>

        <div class="module-page__title-row">
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <UButton
              icon="i-lucide-arrow-left"
              color="neutral"
              variant="ghost"
              square
              aria-label="Back to Application Graph"
              class="module-page__phone-only size-10 shrink-0 justify-center"
              :to="NAVIGATOR_PATH"
            />
            <UIcon
              name="i-lucide-package"
              class="size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <h1
              class="truncate font-mono text-base font-semibold"
              translate="no"
            >
              {{ moduleName }}
            </h1>
            <UBadge
              v-if="isRoot"
              label="Root"
              color="neutral"
              variant="outline"
              size="sm"
              class="shrink-0"
            />
            <UButton
              v-if="hasJsDoc"
              icon="i-lucide-info"
              color="neutral"
              variant="ghost"
              square
              :aria-label="`About ${moduleName}`"
              :aria-expanded="isAboutOpen"
              :aria-controls="aboutId"
              class="module-page__phone-only ms-auto size-10 shrink-0 justify-center"
              @click="isAboutOpen = !isAboutOpen"
            />
          </div>

          <!-- Links, not tabs: each view has an address of its own, which
               Back and Forward step through. -->
          <nav
            aria-label="Module views"
            class="module-page__views"
          >
            <NuxtLink
              v-for="option in viewOptions"
              :key="option.view"
              v-slot="{ href, navigate }"
              :to="option.to"
              custom
            >
              <a
                :href="href"
                class="module-page__view"
                :class="{ 'module-page__view--active': option.isActive }"
                :aria-current="option.isActive ? 'page' : undefined"
                @click="navigate"
              >
                <UIcon
                  :name="option.icon"
                  class="size-4 shrink-0"
                  aria-hidden="true"
                />
                {{ option.label }}
              </a>
            </NuxtLink>
          </nav>
        </div>

        <ModuleJsDocSummary
          v-show="!isPhone || isAboutOpen"
          :id="aboutId"
          :jsdoc="graphModule.jsdoc"
          class="mt-1"
        />
      </header>

      <ModuleDependencyBracket
        v-if="pageState.view === 'dependencies'"
        class="min-h-0 flex-1"
        :graph-data="graphData"
        :module-name="moduleName"
        :depth="pageState.depth"
        @depth-change="setDepth"
      />

      <ModuleGraphViewer
        v-else
        class="min-h-0 flex-1"
        :module-name="moduleName"
        :graph-data="graphData"
        :direct-run-url="directRunUrl"
        :direct-run-headers="requestHeaders"
        :direct-run-disabled="graphIsStatic"
        :direct-run-disabled-reason="directRunDisabledReason"
        :direct-run-on="pageState.directRunOn ?? undefined"
        :direct-run-records="directRunRecords"
        @direct-run-open="openDirectRun"
        @direct-run-close="closeDirectRun"
        @trace-open="handleTraceOpen"
      />
    </div>
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
          to: NAVIGATOR_PATH
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

<style scoped>
.module-page__header {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.module-page__crumbs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* The trail's other steps in a grey that holds 4.5:1, not the faint default. */
.module-page__crumbs :deep(.text-muted) {
  color: var(--ui-text-toned);
}

.module-page__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin-top: 6px;
}

.module-page__phone-only {
  display: none;
}

/*
 * On a phone: no breadcrumb row — the back button joins the module's name —
 * and the JSDoc behind the about button, so the header is two rows.
 */
@media (max-width: 639.98px) {
  .module-page__header {
    padding: 4px 12px 8px;
  }

  .module-page__crumbs {
    display: none;
  }

  .module-page__title-row {
    gap: 4px;
    margin-top: 0;
  }

  .module-page__phone-only {
    display: inline-flex;
  }
}

/*
 * The view switch: a track with the current view lifted out of it, as wide as
 * its two options — the whole row on a phone, where each is a 40px target.
 */
.module-page__views {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: var(--ui-bg-elevated);
}

.module-page__view {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--ui-text-toned);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  text-decoration: none;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}

.module-page__view:hover {
  color: var(--ui-text-highlighted);
}

.module-page__view:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 1px;
}

/* Lifted out of the track by a tone step and a hairline, never a shadow. */
.module-page__view--active {
  border-color: var(--ui-border);
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
}

@media (max-width: 639.98px) {
  .module-page__views {
    display: flex;
    width: 100%;
  }

  .module-page__view {
    flex: 1 1 0;
    height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .module-page__view {
    transition: none;
  }
}
</style>
