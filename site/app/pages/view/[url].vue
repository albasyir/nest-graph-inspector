<script setup lang="ts">
import type { ModuleMap } from '@library/libs/nest-graph-inspector/src/types/module-map.type'

const route = useRoute()
const posthog = usePostHog()

const urlBase64 = computed(() => {
  const param = route.params.url
  return Array.isArray(param) ? param[0] : param
})

const decodedUrl = computed(() => {
  if (!urlBase64.value) return ''
  try {
    return atob(urlBase64.value)
  } catch {
    return ''
  }
})

useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'Viewing NestJS dependency graph data.'
})

// Redirect to /view if no valid URL
if (!decodedUrl.value) {
  navigateTo('/view')
}

const { data: graphData, status, error, refresh } = await useFetch<ModuleMap>(() => decodedUrl.value, {
  key: `graph-${urlBase64.value}`,
  server: false,
  onResponse({ response }) {
    if (response.ok) {
      posthog?.capture('Graph Loaded', {
        url: decodedUrl.value
      })
    }
  },
  onResponseError({ error: fetchError }) {
    posthog?.capture('Graph Load Failed', {
      url: decodedUrl.value,
      error_message: fetchError?.message || 'Unknown error'
    })
  }
})

function handleRefresh() {
  posthog?.capture('Graph Refreshed', {
    url: decodedUrl.value
  })
  refresh()
}

function openNewUrl() {
  posthog?.capture('Graph New URL Requested', {
    url: decodedUrl.value
  })
  navigateTo('/view')
}
</script>

<template>
  <UContainer class="py-6">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
      <div class="space-y-1 min-w-0">
        <p class="text-sm text-muted font-mono truncate max-w-lg">
          {{ decodedUrl }}
        </p>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <UButton
          icon="i-lucide-refresh-cw"
          label="Reload"
          variant="outline"
          size="sm"
          :loading="status === 'pending'"
          @click="handleRefresh()"
        />
        <UButton
          icon="i-lucide-link"
          label="New URL"
          variant="soft"
          size="sm"
          @click="openNewUrl"
        />
      </div>
    </div>

    <!-- Loading State -->
    <div
      v-if="status === 'pending'"
      class="flex flex-col items-center justify-center min-h-[60vh] gap-4"
    >
      <div class="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center animate-pulse">
        <UIcon
          name="i-lucide-loader-2"
          class="w-8 h-8 text-primary animate-spin"
        />
      </div>
      <div class="text-center space-y-1">
        <p class="font-medium">
          Fetching graph data...
        </p>
        <p class="text-sm text-muted">
          Connecting to {{ decodedUrl }}
        </p>
      </div>
    </div>

    <!-- Error State -->
    <div
      v-else-if="error"
      class="flex flex-col items-center justify-center min-h-[60vh] gap-4"
    >
      <div class="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center">
        <UIcon
          name="i-lucide-alert-triangle"
          class="w-8 h-8 text-red-500"
        />
      </div>
      <div class="text-center space-y-2">
        <p class="font-medium text-lg">
          Failed to fetch graph data
        </p>
        <p class="text-sm text-muted max-w-md">
          {{ error.message || 'Could not connect to the provided URL. Make sure your NestJS app is running and the endpoint is accessible.' }}
        </p>
        <div class="flex items-center justify-center gap-2 mt-4">
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
            @click="openNewUrl"
          />
        </div>
      </div>
    </div>

    <!-- Graph -->
    <ClientOnly v-else-if="graphData">
      <GraphViewer :data="graphData" />
    </ClientOnly>

    <!-- Empty State -->
    <div
      v-else
      class="flex flex-col items-center justify-center min-h-[60vh] gap-4"
    >
      <div class="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <UIcon
          name="i-lucide-file-json"
          class="w-8 h-8 text-primary"
        />
      </div>
      <div class="text-center space-y-2">
        <p class="font-medium text-lg">
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
  </UContainer>
</template>
