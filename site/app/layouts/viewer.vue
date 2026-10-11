<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { storeToRefs } from 'pinia'
import { MOBILE_BREAKPOINT_PX, MOBILE_DISCLAIMER_MESSAGE } from '~/utils/device-detection'

const route = useRoute()
const router = useRouter()
const graphStore = useGraphInspectorStore()
const {
  endpointUrl,
  isDemo,
  isLoading
} = storeToRefs(graphStore)
const aiChatOpen = ref(false)
const { isMobile } = useMobileDevice()

// The graph being viewed is no longer in the URL, so these paths are fixed and
// the endpoint shown in the header comes from the store.
const NAVIGATOR_PATH = '/view/navigator'
const ISSUES_PATH = '/view/issues'
const TRACE_PATH = '/view/trace'
// The trace page's address before it was renamed; the middleware redirects it.
const LEGACY_TRACE_PATH = '/view/execution-sequence'

// What a phone's header prints in place of "Ask AI": short enough for the row,
// and naming the width as well as the device, because a desktop window narrower
// than the breakpoint is turned away too.
const COMPACT_ASK_AI_LABEL = `AI: desktop, ${MOBILE_BREAKPOINT_PX}px+`

function handleRefresh(event?: Event) {
  event?.preventDefault()
  graphStore.fetchGraph()
}

function handleAskAi(event?: Event) {
  event?.preventDefault()

  if (isMobile.value) {
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

/** Top-level actions shown in the graph viewer header. */
const viewerMenuItems = computed(() => [
  {
    label: 'Navigator',
    icon: 'i-lucide-map',
    to: NAVIGATOR_PATH,
    // A module deep dive (`/view/navigator/modules/<id>`) is still the navigator.
    active: route.path === NAVIGATOR_PATH || route.path.startsWith(`${NAVIGATOR_PATH}/`),
    disabled: !endpointUrl.value
  },
  {
    label: 'Issues',
    icon: 'i-lucide-bug',
    to: ISSUES_PATH,
    active: route.path === ISSUES_PATH,
    disabled: !endpointUrl.value
  },
  {
    label: 'Trace',
    icon: 'i-lucide-activity',
    to: TRACE_PATH,
    active: route.path === TRACE_PATH || route.path === LEGACY_TRACE_PATH,
    disabled: !endpointUrl.value
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
        <header class="relative z-90 shrink-0 border-b border-default bg-default/95 backdrop-blur">
          <UContainer class="grid min-h-16 w-full lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center">
            <div class="flex min-w-0 items-center gap-3">
              <div class="shrink-0">
                <UTooltip text="Back to graph input">
                  <UButton
                    icon="i-lucide-arrow-left"
                    color="neutral"
                    variant="ghost"
                    aria-label="Back to graph input"
                    @click="handleBack"
                  />
                </UTooltip>
              </div>

              <div class="min-w-0 space-y-1">
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

                <!-- The second line keeps the header's shape either way: an
                     address is what identifies somebody's application, and the
                     demo has none worth showing outside the tab that made it. -->
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
                  {{ endpointUrl || 'No graph endpoint selected' }}
                </p>
              </div>
            </div>

            <UNavigationMenu
              :items="viewerMenuItems"
              variant="pill"
              orientation="horizontal"
              class="w-full justify-center"
            />

            <div class="flex items-center justify-end gap-1">
              <UColorModeButton />

              <UTooltip text="Reload graph">
                <UButton
                  icon="i-lucide-refresh-cw"
                  color="neutral"
                  variant="ghost"
                  aria-label="Reload graph"
                  :disabled="!endpointUrl || isLoading"
                  :loading="isLoading"
                  @click="handleRefresh"
                />
              </UTooltip>

              <!-- The chat runs its model on this device's GPU, which a phone
                   cannot spare, so on mobile the button stays visible from
                   `sm` up, disabled, with the reason in its tooltip and its
                   accessible name. -->
              <UTooltip
                :text="MOBILE_DISCLAIMER_MESSAGE"
                :disabled="!isMobile"
              >
                <UButton
                  icon="i-lucide-bot"
                  label="Ask AI"
                  color="neutral"
                  variant="ghost"
                  class="hidden sm:inline-flex"
                  :aria-label="isMobile ? `Ask AI — ${MOBILE_DISCLAIMER_MESSAGE}` : 'Ask AI'"
                  :disabled="!endpointUrl || isMobile"
                  @click="handleAskAi"
                />
              </UTooltip>

              <!-- Below `sm` the window is under the breakpoint, so the chat is
                   always off there; the requirement is printed rather than left
                   to a tooltip, which a tap on a disabled button never opens.
                   Below `lg` this row has the header's full width to itself, so
                   the label fits a 320px phone with room to spare. -->
              <UButton
                v-if="isMobile"
                icon="i-lucide-bot"
                :label="COMPACT_ASK_AI_LABEL"
                color="neutral"
                variant="ghost"
                size="sm"
                class="min-w-0 sm:hidden"
                :aria-label="`${COMPACT_ASK_AI_LABEL} — ${MOBILE_DISCLAIMER_MESSAGE}`"
                disabled
              />
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
