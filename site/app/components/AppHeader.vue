<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'

const navigation = inject<Ref<ContentNavigationItem[]>>('navigation')

const { header } = useAppConfig()
const config = useRuntimeConfig()

function resolveAsset(path: string | undefined) {
  if (!path) return ''
  if (path.startsWith('http') || path.startsWith('//')) return path
  let base = config.app.baseURL || '/'
  if (base.endsWith('/')) base = base.slice(0, -1)
  if (!path.startsWith('/')) path = '/' + path
  return base + path
}
</script>

<template>
  <UHeader
    :ui="{ center: 'flex-1' }"
    :to="header?.to || '/'"
  >
    <div class="flex items-center gap-3 w-full max-w-sm lg:max-w-md">
      <UButton
        to="/view"
        icon="i-lucide-network"
        label="View Graph and Inspect"
        color="neutral"
        variant="subtle"
        size="md"
        class="flex-1 justify-center"
      />

      <UContentSearchButton
        v-if="header?.search"
        :collapsed="false"
        class="flex-1"
      />
    </div>

    <template
      v-if="header?.logo?.dark || header?.logo?.light || header?.title"
      #title
    >
      <div class="flex items-center gap-2">
        <template v-if="header?.logo?.light && header?.logo?.dark">
          <img
            :src="resolveAsset(header.logo.light)"
            :alt="header?.logo?.alt"
            class="h-6 w-auto shrink-0 dark:hidden"
          >
          <img
            :src="resolveAsset(header.logo.dark)"
            :alt="header?.logo?.alt"
            class="h-6 w-auto shrink-0 hidden dark:block"
          >
        </template>
        <template v-else-if="header?.logo?.light || header?.logo?.dark">
          <img
            :src="resolveAsset(header?.logo?.light || header?.logo?.dark)"
            :alt="header?.logo?.alt"
            class="h-6 w-auto shrink-0"
          >
        </template>

        <span v-if="header?.title">
          {{ header.title }}
        </span>
      </div>
    </template>

    <template
      v-else
      #left
    >
      <NuxtLink :to="header?.to || '/'">
        <AppLogo class="w-auto h-6 shrink-0" />
      </NuxtLink>

      <TemplateMenu />
    </template>

    <template #right>
      <UContentSearchButton
        v-if="header?.search"
        class="lg:hidden"
      />

      <UColorModeButton v-if="header?.colorMode" />

      <template v-if="header?.links">
        <UButton
          v-for="(link, index) of header.links"
          :key="index"
          v-bind="{ color: 'neutral', variant: 'ghost', ...link }"
        />
      </template>
    </template>

    <template #body>
      <UContentNavigation
        highlight
        :navigation="navigation"
      />
    </template>
  </UHeader>
</template>
