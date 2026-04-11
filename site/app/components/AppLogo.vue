<script setup lang="ts">
const config = useRuntimeConfig()
const logoUrl = computed(() => {
  let base = config.app.baseURL || '/'
  if (base.endsWith('/')) base = base.slice(0, -1)
  return base + '/logo.png'
})
</script>

<template>
  <div class="flex items-center gap-2">
    <img
      :src="logoUrl"
      alt="Nest Graph Inspector"
      class="h-full w-auto"
    >
  </div>
</template>
