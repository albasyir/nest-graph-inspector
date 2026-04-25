<script lang="ts">
import theme from '#build/ui/prose/code-group'
</script>

<script setup lang="ts">
import type { VNode } from 'vue'
import { computed, onBeforeUpdate, onMounted, ref, watch } from 'vue'
import { TabsContent, TabsIndicator, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import { useAppConfig, useState } from '#imports'
import ProseCodeIcon from '@nuxt/ui/components/prose/CodeIcon.vue'
import { useComponentUI } from '@nuxt/ui/composables/useComponentUI'
import { tv } from '@nuxt/ui/utils/tv'
import { usePackageManagerStore } from '~/stores/package-manager'
import { isSupportedPackageManager } from '~/utils/supported-runtime'
import type { PackageManager } from '~/utils/supported-runtime'

type CodeGroupItem = {
  label: string
  icon?: string
  component: VNode
}

type CodeGroupUi = Record<'root' | 'list' | 'indicator' | 'trigger' | 'triggerIcon' | 'triggerLabel', (options?: { class?: unknown }) => string>

const props = withDefaults(defineProps<{
  defaultValue?: string
  sync?: string
  class?: unknown
  ui?: Record<string, unknown>
}>(), {
  defaultValue: '0'
})

const slots = defineSlots()
const model = defineModel<string>()
const appConfig = useAppConfig() as ReturnType<typeof useAppConfig> & {
  ui?: {
    prose?: {
      codeGroup?: Record<string, unknown>
    }
  }
}
const packageManagerStore = usePackageManagerStore()
const uiProp = useComponentUI('prose.codeGroup', props)
const codeGroupUi = computed<CodeGroupUi>(() => {
  return tv({ extend: tv(theme), ...appConfig.ui?.prose?.codeGroup || {} })() as unknown as CodeGroupUi
})
const rerenderCount = ref(1)

const items = computed(() => {
  void rerenderCount.value
  return slots.default?.()
    ?.flatMap(transformSlot)
    .filter(Boolean) as CodeGroupItem[] || []
})

const packageManagerLabels = computed(() => {
  return items.value.map(item => normalizePackageManager(item.label))
})

const isPackageManagerGroup = computed(() => {
  return packageManagerLabels.value.length > 0 && packageManagerLabels.value.every(Boolean)
})

function transformSlot(slot: VNode, index: number): CodeGroupItem | CodeGroupItem[] | undefined {
  if (typeof slot.type === 'symbol') {
    return slot.children instanceof Array
      ? slot.children.map((child, childIndex) => transformSlot(child as VNode, childIndex)).flat().filter(Boolean) as CodeGroupItem[]
      : undefined
  }

  return {
    label: getSlotLabel(slot, index),
    icon: typeof slot.props?.icon === 'string' ? slot.props.icon : undefined,
    component: slot
  }
}

function getSlotLabel(slot: VNode, index: number) {
  const label = slot.props?.filename || slot.props?.label
  return typeof label === 'string' ? label : `${index}`
}

function normalizePackageManager(label: string): PackageManager | undefined {
  const value = label.trim().toLowerCase()
  return isSupportedPackageManager(value) ? value : undefined
}

function syncModelFromPackageManager() {
  if (!isPackageManagerGroup.value) {
    return
  }

  const selectedIndex = packageManagerLabels.value.findIndex(label => label === packageManagerStore.selectedPackageManager)
  model.value = selectedIndex >= 0 ? String(selectedIndex) : props.defaultValue
}

watch(
  () => packageManagerStore.selectedPackageManager,
  syncModelFromPackageManager,
  { immediate: true }
)

watch(items, syncModelFromPackageManager, { immediate: true })

watch(model, (value) => {
  if (!isPackageManagerGroup.value || value === undefined) {
    return
  }

  const packageManager = packageManagerLabels.value[Number(value)]
  if (packageManager) {
    packageManagerStore.setPackageManager(packageManager)
  }
})

onMounted(() => {
  packageManagerStore.hydrateFromStorage()
  syncModelFromPackageManager()

  if (props.sync && !isPackageManagerGroup.value) {
    const syncKey = `code-group-${props.sync}`
    const syncValue = useState<string | null>(syncKey, () => localStorage.getItem(syncKey))

    watch(syncValue, () => {
      if (!syncValue.value) {
        return
      }

      model.value = syncValue.value
    }, { immediate: true })

    watch(model, () => {
      if (!model.value) {
        return
      }

      syncValue.value = model.value
      localStorage.setItem(syncKey, model.value)
    })
  }
})

onBeforeUpdate(() => rerenderCount.value++)
</script>

<template>
  <TabsRoot
    v-model="model"
    :default-value="defaultValue"
    :unmount-on-hide="false"
    :class="codeGroupUi.root({ class: [uiProp?.root, props.class] })"
  >
    <TabsList :class="codeGroupUi.list({ class: uiProp?.list })">
      <TabsIndicator :class="codeGroupUi.indicator({ class: uiProp?.indicator })" />

      <TabsTrigger
        v-for="(item, index) of items"
        :key="index"
        :value="String(index)"
        :class="codeGroupUi.trigger({ class: uiProp?.trigger })"
      >
        <ProseCodeIcon
          :icon="item.icon"
          :filename="item.label"
          :class="codeGroupUi.triggerIcon({ class: uiProp?.triggerIcon })"
        />

        <span :class="codeGroupUi.triggerLabel({ class: uiProp?.triggerLabel })">{{ item.label }}</span>
      </TabsTrigger>
    </TabsList>

    <TabsContent
      v-for="(item, index) of items"
      :key="index"
      :value="String(index)"
      as-child
    >
      <component
        :is="item.component"
        hide-header
        tabindex="-1"
      />
    </TabsContent>
  </TabsRoot>
</template>
