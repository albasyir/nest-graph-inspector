<script setup lang="ts">
import type { JsDocPreviewBlock } from '~/utils/jsdoc-preview'

/**
 * The JSDoc of one graph node, shown while the pointer rests on it.
 *
 * Purely presentational: the graph decides what is hovered and where the card
 * goes, this decides how a comment reads once it is there.
 */
const props = defineProps<{
  title: string
  kind: 'module' | 'provider' | 'controller'
  blocks: JsDocPreviewBlock[]
  /** The owning module, for a provider or a controller. */
  subtitle?: string
}>()

const KIND_LABELS: Record<typeof props.kind, string> = {
  module: 'Module',
  provider: 'Provider',
  controller: 'Controller'
}

const KIND_ICONS: Record<typeof props.kind, string> = {
  module: 'i-lucide-package',
  provider: 'i-lucide-cog',
  controller: 'i-lucide-route'
}
</script>

<template>
  <div
    class="jsdoc-hover-card"
    role="tooltip"
  >
    <div class="jsdoc-hover-card__header">
      <UIcon
        :name="KIND_ICONS[props.kind]"
        class="jsdoc-hover-card__icon"
        aria-hidden="true"
      />
      <div class="min-w-0">
        <p class="jsdoc-hover-card__title">
          {{ props.title }}
        </p>
        <p class="jsdoc-hover-card__subtitle">
          {{ props.subtitle ? `${KIND_LABELS[props.kind]} · ${props.subtitle}` : KIND_LABELS[props.kind] }}
        </p>
      </div>
    </div>

    <div class="jsdoc-hover-card__body">
      <template
        v-for="(block, index) in props.blocks"
        :key="index"
      >
        <p
          v-if="block.kind === 'paragraph'"
          class="jsdoc-hover-card__paragraph"
        >
          {{ block.text }}
        </p>

        <ul
          v-else
          class="jsdoc-hover-card__list"
        >
          <li
            v-for="(item, itemIndex) in block.items"
            :key="itemIndex"
          >
            {{ item }}
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped>
.jsdoc-hover-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-bg);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
  font-family: "Public Sans", system-ui, sans-serif;
}

.jsdoc-hover-card__header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.jsdoc-hover-card__icon {
  flex: 0 0 auto;
  margin-top: 2px;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}

.jsdoc-hover-card__title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.jsdoc-hover-card__subtitle {
  margin: 0;
  color: var(--ui-text-muted);
  font-size: 11px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.jsdoc-hover-card__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text);
  font-size: 12px;
  line-height: 1.5;
}

.jsdoc-hover-card__paragraph {
  margin: 0;
  overflow-wrap: anywhere;
}

.jsdoc-hover-card__list {
  margin: 0;
  padding-left: 16px;
  list-style: disc;
  overflow-wrap: anywhere;
}
</style>
