<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })

defineProps<{
  disabled?: boolean
}>()

function closePanel() {
  open.value = false
}
</script>

<template>
  <UDashboardPanel
    v-if="open"
    id="graph-ai-chat"
    resizable
    :default-size="32"
    :min-size="24"
    :max-size="48"
    class="order-3 fixed inset-0 z-50 h-dvh max-h-dvh min-h-0 overflow-hidden bg-default lg:relative lg:inset-auto lg:z-auto lg:border-s lg:border-default lg:not-last:border-e-0"
  >
    <AiChatPanel
      :active="open"
      :disabled="disabled"
      @close="closePanel"
    />

    <template #resize-handle="{ onMouseDown, onTouchStart, onDoubleClick }">
      <UDashboardResizeHandle
        class="order-2 hidden lg:block"
        @mousedown="onMouseDown"
        @touchstart="onTouchStart"
        @dblclick="onDoubleClick"
      />
    </template>
  </UDashboardPanel>
</template>
