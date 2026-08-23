<script setup lang="ts">
type BooleanProp = boolean | string
type ModuleListProp = string[] | string

const props = withDefaults(defineProps<{
  previewId?: string
  fixBightline?: boolean | string
  height?: string
  excludeModules?: ModuleListProp
  showCircularDependencies?: BooleanProp
  showBrightLine?: BooleanProp
  collapsedModules?: ModuleListProp
  caption?: string
}>(), {
  previewId: undefined,
  fixBightline: false,
  height: 'clamp(14rem, 52vh, 28rem)',
  excludeModules: () => [],
  showCircularDependencies: true,
  showBrightLine: true,
  collapsedModules: () => [],
  caption: 'Live graph of the demo application running in your browser.'
})

function parseBooleanProp(value: BooleanProp | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback
  }

  return value !== false && value !== 'false'
}

const generatedPreviewId = useId()

const previewId = computed(() => {
  const explicitId = props.previewId?.trim()
  return explicitId || generatedPreviewId
})

const viewerFlowId = computed(() => `runtime-graph-preview-${previewId.value}`)

const shouldShowCircularDependencies = computed(() =>
  parseBooleanProp(props.showCircularDependencies, true)
)

const shouldShowBrightLine = computed(() =>
  parseBooleanProp(props.showBrightLine, true)
)

const previewCaption = computed(() => {
  if (fixedBrightLineLabel.value) {
    return null
  }

  return props.caption
})

const fixedBrightLineLabel = computed(() => {
  const fixedTarget = props.fixBightline
  if (fixedTarget === false || fixedTarget === undefined) {
    return null
  }

  if (typeof fixedTarget === 'string') {
    const label = fixedTarget.trim()
    return label || 'UserRepository'
  }

  return 'UserRepository'
})

const {
  previewRef,
  graph,
  isReady,
  isFailed,
  needsManualStart,
  statusLabel,
  start,
  retry
} = useNodepodDemoGraph()
</script>

<template>
  <div
    ref="previewRef"
    class="space-y-3"
  >
    <ClientOnly>
      <GraphViewer
        v-if="isReady && graph"
        :data="graph"
        :flow-id="viewerFlowId"
        :height="props.height"
        :interactive="false"
        :fix-bightline="props.fixBightline"
        :exclude-modules="props.excludeModules"
        :collapsed-modules="props.collapsedModules"
        :show-circular-dependencies="shouldShowCircularDependencies"
        :enable-bright-line="shouldShowBrightLine"
        default-open-module-detail
      />
      <UAlert
        v-else-if="isFailed"
        icon="i-lucide-triangle-alert"
        color="error"
        variant="subtle"
        title="Could not start the demo application"
        :description="statusLabel || 'The demo application could not be started in this browser.'"
        :actions="[{ label: 'Try again', color: 'neutral', variant: 'subtle', onClick: retry }]"
      />
      <div
        v-else
        class="relative"
      >
        <USkeleton
          class="runtime-graph-preview__skeleton w-full rounded-xl"
          :style="{ height: props.height }"
        />
        <div class="absolute inset-x-0 bottom-4 flex justify-center">
          <UButton
            v-if="needsManualStart"
            icon="i-lucide-play"
            label="Run the demo application"
            color="neutral"
            variant="subtle"
            class="cursor-pointer"
            @click="start"
          />
          <p
            v-else
            class="text-sm text-muted"
          >
            {{ statusLabel }}
          </p>
        </div>
      </div>

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
        {{ previewCaption }}
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
