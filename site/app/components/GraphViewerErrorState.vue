<script setup lang="ts">
import { describeLoadFailure } from '~/utils/http-error'

const props = defineProps<{
  /**
   * HTTP status the load failed with, `0` when it got none. The only detail of
   * a failure this shows: no message — the transport's or the endpoint's — is
   * ever displayed, since either can quote the URL and what it carries.
   */
  status?: number
  /**
   * The endpoint answered 401. The token is no longer in the URL, so the only
   * way back is the link the application prints.
   */
  requiresAccessToken?: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()

const failure = computed(() =>
  describeLoadFailure(props.status ?? 0, props.requiresAccessToken)
)
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
        {{ failure.title }}
      </p>
      <p class="max-w-md text-sm text-muted">
        {{ failure.description }}
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
          to="/view?autoload=false"
        />
      </div>
    </div>
  </div>
</template>
