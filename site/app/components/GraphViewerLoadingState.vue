<script setup lang="ts">
defineProps<{
  endpoint?: string
  /** Replaces the default sentence when something more specific is known. */
  message?: string
}>()
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col items-center justify-center gap-4 px-4"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <div class="flex size-16 animate-pulse items-center justify-center rounded-2xl bg-primary/10">
      <UIcon
        name="i-lucide-loader-2"
        class="size-8 animate-spin text-primary"
        aria-hidden="true"
      />
    </div>

    <div class="max-w-xl space-y-1 text-center">
      <p class="font-medium">
        Preparing graph data...
      </p>
      <p class="text-sm text-muted">
        {{ message || 'Fetching graph resources. The first visit can take a moment while your graph is generated.' }}
      </p>
      <p
        v-if="endpoint"
        class="break-all text-sm text-muted"
      >
        Connecting to {{ endpoint }}
      </p>
    </div>
  </div>
</template>
