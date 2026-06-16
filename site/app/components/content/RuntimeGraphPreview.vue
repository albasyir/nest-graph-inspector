<script setup lang="ts">
import type { GraphOutput } from '@library/libs/nest-graph-inspector/src/types/graph-output.type'

const props = withDefaults(
  defineProps<{
    fixBightline?: boolean | string
    height?: string
    excludeModules?: string[] | string
  }>(),
  {
    fixBightline: false,
    height: 'clamp(14rem, 52vh, 28rem)',
    excludeModules: () => []
  }
)

const fixedBrightLineLabel = computed(() => {
  if (props.fixBightline === false || props.fixBightline === undefined) {
    return null
  }

  if (typeof props.fixBightline === 'string') {
    const label = props.fixBightline.trim()
    return label || 'UserRepository'
  }

  return 'UserRepository'
})

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
        :height="props.height"
        :interactive="false"
        :fix-bightline="props.fixBightline"
        :exclude-modules="props.excludeModules"
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
        class="runtime-graph-preview__skeleton w-full rounded-xl"
        :style="{ height: props.height }"
      />

      <template #fallback>
        <USkeleton
          class="runtime-graph-preview__skeleton w-full rounded-xl"
          :style="{ height: props.height }"
        />
      </template>
    </ClientOnly>

    <p class="text-sm text-muted">
      <template v-if="fixedBrightLineLabel">
        This example shows what happens when you hover
        <span class="font-medium text-highlighted">{{ fixedBrightLineLabel }}</span>.
      </template>
      <template v-else>
        Interactive preview from the built-in mock graph.
      </template>
      <NuxtLink
        to="/view?preview=true"
        class="text-primary font-medium"
      >
        Open full-screen demo
      </NuxtLink>
    </p>
  </div>
</template>
