<script setup lang="ts">
const { header } = useAppConfig()

const githubCtaUrl = computed(() => {
  const links = Array.isArray(header?.links) ? header.links : []
  const githubLink = links.find(link => typeof link?.to === 'string' && link.to.includes('github.com'))
  return githubLink?.to || 'https://github.com/albasyir/nest-graph-inspector'
})
</script>

<template>
  <div class="contents">
    <div class="relative overflow-hidden border-b border-amber-400/40 bg-gradient-to-r from-rose-500/25 via-amber-300/35 to-sky-500/25">
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(255,255,255,0.45),transparent_35%),radial-gradient(circle_at_80%_10%,rgba(255,255,255,0.35),transparent_30%)]" />
      <UContainer class="relative flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-xs font-semibold text-slate-900 dark:text-slate-100 sm:text-sm">
          <span class="mr-2 inline-flex rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 dark:bg-white/20 dark:text-rose-200">
            Community
          </span>
          Help us grow sustainably: contribute or leave a star on GitHub.
        </p>
        <UButton
          :to="githubCtaUrl"
          target="_blank"
          icon="i-simple-icons-github"
          label="Support on GitHub"
          color="neutral"
          variant="solid"
          size="sm"
          class="bg-slate-900 text-white ring-2 ring-white/75 shadow-md hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
        />
      </UContainer>
    </div>

    <AppHeader />

    <UMain>
      <slot />
    </UMain>

    <AppFooter />
  </div>
</template>
