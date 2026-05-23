<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { storeToRefs } from 'pinia'

type NavigationBadge = NonNullable<NavigationMenuItem['badge']>

const posthog = usePostHog()
const graphStore = useGraphInspectorStore()
const {
  decodedUrl,
  status,
  dependencyTraceEnabled
} = storeToRefs(graphStore)
const aiChatOpen = ref(false)

function getFeatureBadge(enabled: boolean): NavigationBadge {
  return {
    label: enabled ? 'Enabled' : 'Disabled',
    color: enabled ? 'success' : 'neutral',
    variant: enabled ? 'subtle' : 'outline'
  }
}

const dependencyTraceBadge = computed(() => getFeatureBadge(dependencyTraceEnabled.value))
const enabledNavigatorFeatureCount = computed(() => dependencyTraceEnabled.value ? 1 : 0)
const navigatorBadge = computed<NavigationBadge>(() => ({
  label: enabledNavigatorFeatureCount.value,
  color: enabledNavigatorFeatureCount.value ? 'success' : 'neutral',
  variant: enabledNavigatorFeatureCount.value ? 'subtle' : 'outline'
}))
const comingSoonBadge: NavigationBadge = {
  label: 'Coming soon',
  color: 'neutral',
  variant: 'outline'
}

function handleRefresh(event?: Event) {
  event?.preventDefault()
  posthog?.capture('Graph Refreshed', {
    url: decodedUrl.value
  })
  graphStore.fetchGraph()
}

function handleAskAi(event?: Event) {
  event?.preventDefault()
  aiChatOpen.value = true
}

function handleToggleDependencyTrace() {
  graphStore.toggleDependencyTrace()
}

const navigatorFeatures = computed(() => [
  {
    value: 'dependency-trace',
    label: 'Dependency Trace',
    icon: 'i-lucide-plug',
    description: 'Trace how injected modules or providers connect to others.',
    badge: dependencyTraceBadge.value,
    active: dependencyTraceEnabled.value,
    onSelect: handleToggleDependencyTrace
  },
  {
    value: 'circular-dependencies',
    label: 'Show Circular Dependencies',
    icon: 'i-lucide-refresh-ccw-dot',
    description: 'Highlight modules or providers that depend on each other in a cycle.',
    badge: comingSoonBadge,
    disabled: true
  },
  {
    value: 'process-sequence',
    label: 'Process Sequence',
    icon: 'i-lucide-list-ordered',
    description: 'Visualize runtime flow so requests, handlers, and providers are easier to follow.',
    badge: comingSoonBadge,
    disabled: true
  },
  {
    value: 'ignore-system-module',
    label: 'Ignore System Module',
    icon: 'i-lucide-filter-x',
    description: 'Hide framework/system nodes so only your application graph is shown.',
    badge: comingSoonBadge,
    disabled: true
  }
] satisfies NavigationMenuItem[])

const viewerMenuItems = computed(() => [
  {
    label: 'Navigator',
    icon: 'i-lucide-map',
    badge: navigatorBadge.value,
    slot: 'navigator',
    children: navigatorFeatures.value,
    disabled: true,
  },
  {
    label: 'Repl',
    icon: 'i-lucide-terminal',
    disabled: true
  },
  {
    label: 'Issues',
    icon: 'i-lucide-bug',
    disabled: true
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
                    to="/view"
                    icon="i-lucide-arrow-left"
                    color="neutral"
                    variant="ghost"
                    aria-label="Back to graph input"
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
              :ui="{
                viewport: 'sm:w-(--reka-navigation-menu-viewport-width)',
                content: 'sm:w-auto',
                childList: 'sm:w-80',
                childLinkDescription: 'text-balance line-clamp-2'
              }"
              class="w-full justify-center"
            >
              <template #navigator-content="{ item }">
                <ul class="w-80 max-w-[calc(100vw-2rem)] space-y-1 p-2">
                  <li
                    v-for="feature in item.children"
                    :key="feature.value || feature.label"
                  >
                    <ULink
                      class="flex min-w-0 items-start gap-3 rounded-md p-3 text-left text-sm transition-colors hover:bg-elevated/50"
                      :class="feature.disabled && 'pointer-events-none opacity-75'"
                      @click="feature.onSelect"
                    >
                      <UIcon
                        v-if="feature.icon"
                        :name="feature.icon"
                        class="mt-0.5 size-5 shrink-0"
                        :class="feature.active ? 'text-success' : 'text-dimmed'"
                      />

                      <div class="min-w-0 flex-1 space-y-1">
                        <div class="flex min-w-0 items-start justify-between gap-2">
                          <p class="min-w-0 flex-1 font-medium text-default line-clamp-2">
                            {{ feature.label }}
                          </p>

                          <UBadge
                            v-if="feature.badge"
                            size="sm"
                            class="mt-0.5 shrink-0"
                            v-bind="typeof feature.badge === 'object' ? feature.badge : { label: feature.badge }"
                          />
                        </div>

                        <p class="text-muted line-clamp-2">
                          {{ feature.description }}
                        </p>
                      </div>
                    </ULink>
                  </li>
                </ul>
              </template>
            </UNavigationMenu>

            <div class="flex items-center justify-end gap-1">
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
