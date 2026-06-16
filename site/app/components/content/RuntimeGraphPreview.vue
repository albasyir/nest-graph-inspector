<script setup lang="ts">
import type { GraphOutput } from '@library/libs/nest-graph-inspector/src/types/graph-output.type'

const config = useRuntimeConfig()
let base = config.app.baseURL || '/'
if (!base.endsWith('/')) {
  base += '/'
}

const { data, status, error } = await useLazyAsyncData(
  'runtime-graph-preview',
  () => $fetch<GraphOutput>(`${base}mock-graph/output.json`),
  { server: false }
)
</script>

<template>
  <div class="space-y-3">
    <ClientOnly>
      <GraphViewer
        v-if="status === 'success' && data"
        :data="data"
        height="clamp(14rem, 52vh, 28rem)"
        :interactive="false"
        default-open-module-detail
      />
      <UAlert
        v-else-if="status === 'error'"
        icon="i-lucide-triangle-alert"
        color="error"
        variant="subtle"
        title="Could not load preview graph"
        :description="error?.message || 'The mock graph endpoint is unavailable.'"
      />
      <USkeleton
        v-else
        class="h-[clamp(14rem,52vh,28rem)] w-full rounded-xl"
      />

      <template #fallback>
        <USkeleton class="h-[clamp(14rem,52vh,28rem)] w-full rounded-xl" />
      </template>
    </ClientOnly>

    <p class="text-sm text-muted">
      Interactive preview from the built-in mock graph.
      <NuxtLink
        to="/view?preview=true"
        class="text-primary font-medium"
      >
        Open full-screen demo
      </NuxtLink>
    </p>
  </div>
</template>
