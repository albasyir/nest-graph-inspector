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
  interactive?: BooleanProp
  autoload?: BooleanProp
  showControls?: BooleanProp
  showMiniMap?: BooleanProp
}>(), {
  previewId: undefined,
  fixBightline: false,
  height: 'clamp(14rem, 52vh, 28rem)',
  excludeModules: () => [],
  showCircularDependencies: true,
  showBrightLine: true,
  collapsedModules: () => [],
  caption: 'Live graph of the demo application running in your browser.',
  interactive: true,
  autoload: true,
  showControls: false,
  showMiniMap: false
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

const isInteractive = computed(() => parseBooleanProp(props.interactive, true))
const shouldAutoload = computed(() => parseBooleanProp(props.autoload, true))
const shouldShowControls = computed(() => parseBooleanProp(props.showControls, false))
const shouldShowMiniMap = computed(() => parseBooleanProp(props.showMiniMap, false))

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

// Read once: whether to start on mount is decided when the preview mounts.
const { graph, isReady, isIdle, hasError, statusLabel, start, retry } = useNodepodDemoGraph({
  autoload: shouldAutoload.value
})
</script>

<template>
  <div class="space-y-3">
    <ClientOnly>
      <GraphViewer
        v-if="isReady && graph"
        :data="graph"
        :flow-id="viewerFlowId"
        :height="props.height"
        :interactive="isInteractive"
        :show-controls="shouldShowControls"
        :show-mini-map="shouldShowMiniMap"
        :fix-bightline="props.fixBightline"
        :exclude-modules="props.excludeModules"
        :collapsed-modules="props.collapsedModules"
        :show-circular-dependencies="shouldShowCircularDependencies"
        :enable-bright-line="shouldShowBrightLine"
        default-open-module-detail
      />
      <div
        v-else
        class="relative"
      >
        <USkeleton
          class="runtime-graph-preview__skeleton w-full rounded-xl"
          :class="{ 'animate-none': hasError }"
          :style="{ height: props.height }"
        />
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
          <div
            v-if="hasError"
            role="alert"
            class="flex max-w-sm flex-col items-center gap-3"
          >
            <UIcon
              name="i-lucide-circle-alert"
              class="size-6 text-error"
              aria-hidden="true"
            />
            <p class="text-sm text-highlighted">
              The live demo could not load.
            </p>
            <p
              v-if="statusLabel"
              class="text-sm text-muted text-pretty"
            >
              {{ statusLabel }}
            </p>
            <UButton
              icon="i-lucide-refresh-cw"
              label="Try again"
              color="neutral"
              variant="subtle"
              class="cursor-pointer"
              @click="retry"
            />
          </div>
          <template v-else-if="isIdle">
            <UButton
              icon="i-lucide-play"
              label="Run the demo application"
              color="neutral"
              variant="subtle"
              class="cursor-pointer"
              @click="start"
            />
            <p class="max-w-sm text-sm text-muted">
              Starts this repository's NestJS application in your browser and
              graphs it live.
            </p>
          </template>
          <div
            v-else
            role="status"
            aria-live="polite"
            class="flex flex-col items-center gap-3"
          >
            <UIcon
              name="i-lucide-loader-2"
              class="size-6 animate-spin text-primary"
              aria-hidden="true"
            />
            <p class="text-sm text-muted tabular-nums">
              {{ statusLabel }}
            </p>
          </div>
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
