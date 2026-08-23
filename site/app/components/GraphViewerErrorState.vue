<script setup lang="ts">
const props = defineProps<{
  /** Message the inspector or the transport reported. */
  message?: string
  /**
   * The endpoint answered 401. The token is no longer in the URL, so the only
   * way back is the link the application prints.
   */
  requiresAccessToken?: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()

const title = computed(() =>
  props.requiresAccessToken
    ? 'Access token required'
    : 'Failed to fetch graph data'
)

const description = computed(() => {
  if (props.requiresAccessToken) {
    return (
      props.message
      || 'This inspector is gated behind a short-lived access token. Open the Graph Viewer link printed in your application console to load it again.'
    )
  }

  return (
    props.message
    || 'Could not connect to the provided URL. Make sure your NestJS app is running and the endpoint is accessible.'
  )
})
</script>

<template>
  <div
    class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    role="alert"
  >
    <div
      class="flex size-16 items-center justify-center rounded-2xl"
      :class="requiresAccessToken ? 'bg-amber-500/10' : 'bg-red-500/10'"
    >
      <UIcon
        :name="requiresAccessToken ? 'i-lucide-key-round' : 'i-lucide-alert-triangle'"
        class="size-8"
        :class="requiresAccessToken ? 'text-amber-500' : 'text-red-500'"
      />
    </div>
    <div class="space-y-2 text-center">
      <p class="text-lg font-medium">
        {{ title }}
      </p>
      <p class="max-w-md text-sm text-muted">
        {{ description }}
      </p>
      <div class="mt-4 flex items-center justify-center gap-2">
        <UButton
          icon="i-lucide-refresh-cw"
          label="Retry"
          variant="outline"
          @click="emit('retry')"
        />
        <UButton
          icon="i-lucide-link"
          label="Try Another URL"
          variant="soft"
          to="/view"
        />
      </div>
    </div>
  </div>
</template>
