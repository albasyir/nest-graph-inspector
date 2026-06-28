<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { storeToRefs } from 'pinia'

const route = useRoute()
const router = useRouter()
const graphStore = useGraphInspectorStore()
const {
  encodedUrl,
  decodedUrl,
  status
} = storeToRefs(graphStore)
const aiChatOpen = ref(false)

const navigatorPath = computed(() =>
  encodedUrl.value ? `/view/${encodedUrl.value}` : '/view'
)
const issuesPath = computed(() => `${navigatorPath.value}/issues`)

function handleRefresh(event?: Event) {
  event?.preventDefault()
  graphStore.fetchGraph()
}

function handleAskAi(event?: Event) {
  event?.preventDefault()
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
    to: navigatorPath.value,
    active: route.path === navigatorPath.value,
    disabled: !encodedUrl.value
  },
  {
    label: 'Direct Run',
    icon: 'i-lucide-terminal',
    disabled: true
  },
  {
    label: 'Issues',
    icon: 'i-lucide-bug',
    to: issuesPath.value,
    active: route.path === issuesPath.value,
    disabled: !encodedUrl.value
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

                <p class="max-w-full truncate font-mono text-xs text-muted sm:max-w-xl">
                  {{ decodedUrl || 'No graph endpoint selected' }}
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
                  :disabled="!decodedUrl || status === 'pending'"
                  :loading="status === 'pending'"
                  @click="handleRefresh"
                />
              </UTooltip>

              <UButton
                icon="i-lucide-bot"
                label="Ask AI"
                color="neutral"
                variant="ghost"
                :disabled="!decodedUrl"
                @click="handleAskAi"
              />
            </div>
          </UContainer>
        </header>

        <main class="relative z-0 min-h-0 flex-1 overflow-hidden">
          <div class="h-full min-h-0 w-full">
            <GraphInspectorUpdateModal />
            <slot />
          </div>
        </main>
      </div>
    </UDashboardPanel>

    <AiChatDrawer v-model:open="aiChatOpen" />
  </UDashboardGroup>
</template>
