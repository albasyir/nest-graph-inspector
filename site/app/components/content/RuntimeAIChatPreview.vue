<template>
  <div class="space-y-3">
    <div class="h-[clamp(22rem,58vh,34rem)] overflow-hidden rounded-xl border border-default bg-default shadow-sm">
      <ClientOnly>
        <AiChatPanel
          preview
          title="Ask AI"
          :show-close="false"
          initial-message="Hi, ask me about a NestJS module, provider, controller, or dependency path."
          preview-reply="Hai!, load real project to chat with me!"
          content-class="min-h-0 px-4 sm:px-5 py-4 bg-muted/20"
          prompt-class="px-4 sm:px-5 py-4 bg-default border-t border-default"
        />

        <template #fallback>
          <USkeleton class="h-full w-full rounded-xl" />
        </template>
      </ClientOnly>
    </div>

    <p class="text-sm text-muted">
      The real viewer grounds every answer in your loaded runtime graph.
      <NuxtLink
        to="/view"
        class="text-primary font-medium"
      >
        Load your project
      </NuxtLink>
    </p>
  </div>
</template>
