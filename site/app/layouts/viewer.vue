<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { useMediaQuery } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import {
  MOBILE_DISCLAIMER_MESSAGE,
  MOBILE_DRAWER_BANNER_MESSAGE,
  MOBILE_DRAWER_BANNER_TITLE
} from '~/utils/device-detection'
import type { ViewerPage } from '~/utils/viewer-bootstrap-link'
import {
  describeViewerGraphStatus,
  resolveAiChatAvailability,
  resolveViewerHeaderPage,
  type ViewerGraphStatusTone
} from '~/utils/viewer-header'

const route = useRoute()
const router = useRouter()
const graphStore = useGraphInspectorStore()
const {
  endpointUrl,
  endpointRequiresAccessToken,
  endpointUnreachable,
  graphData,
  graphIsStatic,
  hasLoadError,
  isDemo,
  isLoading
} = storeToRefs(graphStore)
const { isBusy: isDemoStarting } = storeToRefs(useNodepodDemoStore())
const aiChatOpen = ref(false)
const { isMobile } = useMobileDevice()

// The graph being viewed is no longer in the URL, so these paths are fixed and
// the endpoint shown in the header comes from the store.
const NAVIGATOR_PATH = '/view/navigator'
const ISSUES_PATH = '/view/issues'
const TRACE_PATH = '/view/trace'

/**
 * The page the route is on. The layout outlives the pages under it, so this is
 * read from the path alone and follows the browser's back and forward too.
 */
const currentPage = computed(() => resolveViewerHeaderPage(route.path))

/** What the compact header shows in place of the endpoint's full address. */
const graphStatus = computed(() => describeViewerGraphStatus({
  endpointUrl: endpointUrl.value,
  isDemo: isDemo.value,
  isDemoStarting: isDemoStarting.value,
  isLoading: isLoading.value,
  hasGraph: Boolean(graphData.value),
  graphVersion: graphData.value?.version,
  isStatic: graphIsStatic.value,
  requiresAccessToken: endpointRequiresAccessToken.value,
  isUnreachable: endpointUnreachable.value,
  hasLoadError: hasLoadError.value
}))

const GRAPH_STATUS_TONE_CLASS: Record<ViewerGraphStatusTone, string> = {
  neutral: 'text-dimmed',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error'
}

const aiChatAvailability = computed(() => resolveAiChatAvailability({
  hasGraphEndpoint: Boolean(endpointUrl.value),
  isRestricted: isMobile.value
}))

// The header stays put while the pages under it change, and both popovers
// hang off controls that can go away: the status one is the compact header's
// only, and the chat notice shows only while the chat is restricted. Each
// closes when its control does, rather than float over a page it no longer
// belongs to, or reopen on its own when the control comes back.
const graphStatusOpen = ref(false)
const aiChatNoticeOpen = ref(false)
const isDesktopHeader = useMediaQuery('(min-width: 64rem)')

watch([() => route.fullPath, isDesktopHeader], () => {
  graphStatusOpen.value = false
  aiChatNoticeOpen.value = false
})

watch(aiChatAvailability, () => {
  aiChatNoticeOpen.value = false
})

function handleRefresh(event?: Event) {
  event?.preventDefault()
  graphStore.fetchGraph()
}

function handleAskAi(event?: Event) {
  event?.preventDefault()

  // Asked again at the click: a window narrowed or a tablet turned since the
  // button was drawn restricts the chat as well.
  if (aiChatAvailability.value !== 'available') {
    return
  }

  aiChatOpen.value = true
}

function handleBack(event?: Event) {
  event?.preventDefault()

  if (!import.meta.client) {
    return
  }

  if (window.history.state?.back) {
    router.back()
    return
  }

  void navigateTo('/')
}

/**
 * Between 35rem and 40rem — a small phone on its side — the pages share the
 * header's one row with everything else, and with every label drawn the
 * graph's status is left a few letters wide. There only the current page shows
 * its label; the others are 40px icons that keep it for assistive technology.
 */
function pageLinkUi(page: ViewerPage) {
  return currentPage.value === page
    ? undefined
    : {
        link: 'min-[35rem]:max-[40rem]:w-10',
        linkLabel: 'min-[35rem]:max-[40rem]:sr-only'
      }
}

/** Top-level actions shown in the graph viewer header. */
const viewerMenuItems = computed(() => [
  {
    label: 'Navigator',
    icon: 'i-lucide-map',
    to: NAVIGATOR_PATH,
    // A module deep dive (`/view/navigator/modules/<id>`) is still the navigator.
    active: currentPage.value === 'navigator',
    disabled: !endpointUrl.value,
    ui: pageLinkUi('navigator')
  },
  {
    label: 'Issues',
    icon: 'i-lucide-bug',
    to: ISSUES_PATH,
    active: currentPage.value === 'issues',
    disabled: !endpointUrl.value,
    ui: pageLinkUi('issues')
  },
  {
    label: 'Trace',
    icon: 'i-lucide-activity',
    to: TRACE_PATH,
    // Its address before the rename, `/view/execution-sequence`, is still it.
    active: currentPage.value === 'trace',
    disabled: !endpointUrl.value,
    ui: pageLinkUi('trace')
  }
] satisfies NavigationMenuItem[])
</script>

<template>
  <UDashboardGroup
    storage-key="graph-view"
    class="relative min-h-screen"
  >
    <UDashboardPanel
      id="graph-viewer"
      class="min-h-0"
    >
      <div class="flex h-screen min-h-0 flex-col">
        <!-- From `lg` this is the desktop header it always was, except that it
             names the endpoint by its host alone. Below it every control is a
             40px touch target, and the endpoint's address gives way to the
             state of the graph. The pages take a row of their own on
             a phone held upright, and share the one row from 35rem, so a phone
             on its side — short of height, not of width — leaves the graph as
             much of the screen as it can. On a row of their own the pages still
             sit between the graph and the tools in the document, so focus moves
             through the header in the same order at every width. The insets
             keep the controls clear of a notch once the page is drawn edge to
             edge; until then they are zero. -->
        <header class="relative z-90 shrink-0 border-b border-default bg-default/95 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur">
          <UContainer class="grid min-h-16 w-full px-2 sm:px-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center max-lg:min-h-0 max-lg:items-center max-lg:gap-x-2 max-lg:py-1 max-[35rem]:grid-cols-[minmax(0,1fr)_auto] max-[35rem]:gap-y-1 min-[35rem]:max-lg:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div class="flex min-w-0 items-center gap-3 max-lg:gap-1">
              <div class="shrink-0">
                <!-- It steps back through the tab's history, which is the
                     graph input only when that is where the visitor came from. -->
                <UTooltip text="Back">
                  <UButton
                    icon="i-lucide-arrow-left"
                    color="neutral"
                    variant="ghost"
                    aria-label="Back"
                    class="max-lg:size-10 max-lg:justify-center"
                    @click="handleBack"
                  />
                </UTooltip>
              </div>

              <div class="min-w-0 space-y-1 max-lg:hidden">
                <div class="flex min-w-0 items-center gap-2">
                  <NuxtLink
                    to="/"
                    class="inline-flex items-center gap-2 text-sm font-semibold"
                  >
                    <UIcon
                      name="i-lucide-network"
                      class="size-4 text-primary"
                    />
                    Graph Viewer
                  </NuxtLink>

                  <UBadge
                    v-if="isDemo"
                    label="Demo"
                    color="primary"
                    variant="subtle"
                    size="xs"
                    class="shrink-0"
                  />
                </div>

                <!-- The second line keeps the header's shape either way: a host
                     is what identifies somebody's application, and the demo has
                     none worth showing outside the tab that made it. As below
                     `lg`, the host is all of an address it shows — the rest can
                     carry user info, or a token left in the query — and an
                     address with no host to read gets a neutral name. -->
                <p
                  v-if="isDemo"
                  class="text-xs text-muted"
                >
                  Running in this browser
                </p>
                <p
                  v-else
                  class="max-w-full truncate font-mono text-xs text-muted sm:max-w-xl"
                >
                  {{ graphStatus.title }}
                </p>
              </div>

              <!-- An address cut to fit a phone says less than the state of the
                   graph does, so the compact header names the host and says
                   that, and keeps the whole host — however long — one tap away.
                   The host is all of the address it shows: the rest can carry
                   user info, or a token left in the query. -->
              <UPopover
                v-model:open="graphStatusOpen"
                :content="{ align: 'start' }"
                :ui="{ content: 'z-[100] w-80 max-w-[calc(100vw-1rem)]' }"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  trailing-icon="i-lucide-chevron-down"
                  class="h-10 min-w-0 flex-1 gap-1 px-1.5 py-0 lg:hidden"
                  :ui="{ trailingIcon: 'size-4 text-dimmed max-[22.5rem]:hidden' }"
                >
                  <span class="min-w-0 flex-1 text-start">
                    <span class="sr-only">Graph source:</span>
                    <span class="block truncate text-sm font-medium text-highlighted">
                      {{ graphStatus.title }}
                    </span>
                    <span class="flex min-w-0 items-center gap-1 text-xs font-normal text-muted">
                      <UIcon
                        :name="graphStatus.icon"
                        class="size-3.5 shrink-0"
                        :class="[GRAPH_STATUS_TONE_CLASS[graphStatus.tone], { 'animate-spin': graphStatus.busy }]"
                      />
                      <span class="truncate">
                        {{ graphStatus.label }}
                      </span>
                    </span>
                  </span>
                </UButton>

                <template #content>
                  <div class="space-y-3 p-3 text-sm">
                    <div class="flex items-start gap-2">
                      <UIcon
                        :name="graphStatus.icon"
                        class="mt-0.5 size-4 shrink-0"
                        :class="[GRAPH_STATUS_TONE_CLASS[graphStatus.tone], { 'animate-spin': graphStatus.busy }]"
                      />
                      <div class="min-w-0 space-y-0.5">
                        <p class="font-medium text-highlighted">
                          {{ graphStatus.label }}
                        </p>
                        <p class="text-muted">
                          {{ graphStatus.description }}
                        </p>
                      </div>
                    </div>

                    <p
                      v-if="graphStatus.host"
                      class="break-all rounded-md bg-elevated px-2 py-1.5 font-mono text-xs text-default"
                    >
                      {{ graphStatus.host }}
                    </p>
                  </div>
                </template>
              </UPopover>
            </div>

            <UNavigationMenu
              :items="viewerMenuItems"
              variant="pill"
              orientation="horizontal"
              aria-label="Viewer pages"
              class="w-full justify-center max-[35rem]:order-last max-[35rem]:col-span-2"
              :ui="{
                list: 'max-lg:gap-1 max-[35rem]:w-full',
                item: 'max-lg:py-0 max-[35rem]:flex-auto',
                link: 'max-lg:h-10 max-lg:justify-center max-lg:gap-1 max-lg:px-2'
              }"
            />

            <div class="flex min-w-0 items-center justify-end gap-1">
              <UColorModeButton class="max-lg:size-10 max-lg:justify-center" />

              <UTooltip text="Reload graph">
                <UButton
                  icon="i-lucide-refresh-cw"
                  color="neutral"
                  variant="ghost"
                  aria-label="Reload graph"
                  class="max-lg:size-10 max-lg:justify-center"
                  :disabled="!endpointUrl || isLoading"
                  :loading="isLoading"
                  @click="handleRefresh"
                />
              </UTooltip>

              <!-- The chat runs its model on this device's GPU, which a phone
                   cannot spare, so what shows follows the device state rather
                   than a breakpoint: `sm` is in rem and moves with the browser's
                   font size while the restriction's 768px does not, and a tablet
                   is wider than `sm` and still cannot run the chat. Where it is
                   restricted the button stays disabled and never opens the chat,
                   but it is `aria-disabled` rather than `disabled`: a disabled
                   button can be neither focused nor tapped, so it could never
                   say why, and a tooltip does not open on touch. -->
              <UButton
                v-if="aiChatAvailability !== 'restricted'"
                icon="i-lucide-bot"
                label="AI Chat"
                color="neutral"
                variant="ghost"
                class="max-lg:h-10"
                :disabled="aiChatAvailability === 'no-graph'"
                @click="handleAskAi"
              />
              <UPopover
                v-else
                v-model:open="aiChatNoticeOpen"
                :content="{ align: 'end' }"
                :ui="{ content: 'z-[100] w-72 max-w-[calc(100vw-1rem)]' }"
              >
                <UButton
                  icon="i-lucide-bot-off"
                  label="AI Chat"
                  color="neutral"
                  variant="ghost"
                  aria-disabled="true"
                  :aria-label="`AI Chat — ${MOBILE_DISCLAIMER_MESSAGE}`"
                  class="max-lg:h-10 max-md:w-10 max-md:justify-center"
                  :ui="{ label: 'max-md:sr-only' }"
                />

                <template #content>
                  <div class="space-y-1.5 p-3 text-sm">
                    <p class="flex items-center gap-1.5 text-xs font-medium text-muted">
                      <UIcon
                        name="i-lucide-bot-off"
                        class="size-4 shrink-0"
                      />
                      AI Chat
                    </p>
                    <p class="font-medium text-highlighted">
                      {{ MOBILE_DRAWER_BANNER_TITLE }}
                    </p>
                    <p class="text-muted">
                      {{ MOBILE_DRAWER_BANNER_MESSAGE }}
                    </p>
                  </div>
                </template>
              </UPopover>
            </div>
          </UContainer>
        </header>

        <main class="relative z-0 min-h-0 flex-1 overflow-hidden">
          <div class="h-full min-h-0 w-full">
            <GraphInspectorUpdateModal />
            <GraphInspectorVersionAcknowledgementModal />
            <slot />
          </div>
        </main>
      </div>
    </UDashboardPanel>

    <AiChatDrawer v-model:open="aiChatOpen" />
  </UDashboardGroup>
</template>
