<script setup lang="ts">
import type { GraphOutput } from '@library/libs/nest-graph-inspector/src/types/graph-output.type'

const config = useRuntimeConfig()
let base = config.app.baseURL || '/'
if (!base.endsWith('/')) {
  base += '/'
}

const { data, status, error } = await useLazyAsyncData(
  'runtime-graph-direct-run-preview',
  () => $fetch<GraphOutput>(`${base}mock-graph/output.json`),
  { server: false }
)

const previewData = computed<GraphOutput | null>(() => {
  const userModule = data.value?.modules.UserModule
  const userService = userModule?.providers.find(provider => provider.name === 'UserService')

  if (!data.value || !userModule || !userService) {
    return null
  }

  return {
    ...data.value,
    root: 'UserModule',
    modules: {
      UserModule: {
        ...userModule,
        imports: [],
        exports: ['UserService'],
        providers: [
          {
            ...userService,
            dependencies: []
          }
        ],
        controllers: []
      }
    },
    cycles: {
      modules: [],
      providers: [],
      controllers: []
    }
  }
})

const methods = computed(() => {
  const provider = previewData.value?.modules.UserModule?.providers[0]
  return provider?.directRun?.methods.slice(0, 3) || []
})

const directRunUrl = computed(() => `${base}mock-graph/direct-run`)
</script>

<template>
  <div class="grid gap-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div class="min-h-80 border-b border-default lg:border-r lg:border-b-0">
        <ClientOnly>
          <GraphViewer
            v-if="status === 'success' && previewData"
            :data="previewData"
            flow-id="runtime-graph-preview-direct-run"
            height="clamp(18rem, 58vh, 34rem)"
            :direct-run-disabled="true"
            :direct-run-url="directRunUrl"
            :show-circular-dependencies="false"
            :enable-bright-line="false"
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
            class="h-80 w-full rounded-none"
          />

          <template #fallback>
            <USkeleton class="h-80 w-full rounded-none" />
          </template>
        </ClientOnly>
      </div>
    </div>
</template>
