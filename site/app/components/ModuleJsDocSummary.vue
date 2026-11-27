<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { parseJsDocPreview } from '~/utils/jsdoc-preview'

/**
 * A module's JSDoc, one line until asked for the rest, so a long comment never
 * pushes the page's graph down. Nothing at all for a module with none.
 */
const props = defineProps<{
  jsdoc?: string
}>()

const blocks = computed(() => parseJsDocPreview(props.jsdoc))
const bodyId = `module-jsdoc-${useId()}`
const bodyRef = ref<HTMLElement | null>(null)
const isExpanded = ref(false)
const isClipped = ref(false)

/** Whether the one collapsed line hides any of the comment. */
function measureClipping(): void {
  const body = bodyRef.value
  if (!body || isExpanded.value) {
    return
  }

  const firstBlock = body.firstElementChild
  isClipped.value = body.scrollHeight > body.clientHeight + 1
    || (firstBlock instanceof HTMLElement
      && firstBlock.scrollWidth > firstBlock.clientWidth + 1)
}

useResizeObserver(bodyRef, measureClipping)

watch(blocks, () => {
  isExpanded.value = false
  void nextTick(measureClipping)
})
</script>

<template>
  <div
    v-if="blocks.length"
    class="module-jsdoc text-sm text-muted"
    :class="{ 'module-jsdoc--expanded': isExpanded }"
  >
    <div
      :id="bodyId"
      ref="bodyRef"
      class="module-jsdoc__body"
    >
      <template
        v-for="(block, index) in blocks"
        :key="index"
      >
        <p v-if="block.kind === 'paragraph'">
          {{ block.text }}
        </p>
        <ul
          v-else
          class="list-disc ps-5"
        >
          <li
            v-for="(listItem, itemIndex) in block.items"
            :key="itemIndex"
          >
            {{ listItem }}
          </li>
        </ul>
      </template>
    </div>
    <UButton
      v-if="isExpanded || isClipped"
      :label="isExpanded ? 'Show less' : 'Show more'"
      color="neutral"
      variant="link"
      size="xs"
      class="shrink-0 py-0"
      :aria-expanded="isExpanded"
      :aria-controls="bodyId"
      @click="isExpanded = !isExpanded"
    />
  </div>
</template>

<style scoped>
.module-jsdoc {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  line-height: 1.25rem;
}

/* Collapsed, the comment is its first line; the button opens the rest. */
.module-jsdoc__body {
  flex: 1;
  min-width: 0;
  max-height: 1.25rem;
  overflow: hidden;
}

.module-jsdoc:not(.module-jsdoc--expanded) .module-jsdoc__body > p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-jsdoc--expanded .module-jsdoc__body {
  max-height: 6.5rem;
  overflow-y: auto;
}

.module-jsdoc__body > * + * {
  margin-top: 0.375rem;
}
</style>
