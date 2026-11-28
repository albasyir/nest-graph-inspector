<script setup lang="ts">
import {
  measureBlastRadius,
  type BracketSide
} from '~/utils/module-dependency-bracket'
import {
  BLAST_DEMO_MODULE,
  describeBlastRadius,
  isBlastDemoAtStart,
  recenterBlastDemo,
  resolveBlastDemoCenter,
  setBlastDemoDepth,
  startBlastDemo
} from '~/utils/landing-blast-demo'
import {
  buildPreviewModulePageLocation,
  type BracketNavigation
} from '~/utils/module-page-route'

/**
 * The landing page's blast-effect section's picture: a module of the demo
 * application in the middle of its dependency bracket — what it needs on the
 * left, and on the right every module a change to it would hit — drawn from
 * the demo's graph as every preview draws it (the static export, or the live
 * demo once it runs), and kept in place. The section says what a blast effect
 * is; this shows it, and under it, as the neighbouring previews' captions do,
 * how far a change reaches and the ways out. The steppers, a "+N more" stub
 * and a click on another module all change the demo here; only its two exits
 * leave the page.
 */
const {
  view,
  graph,
  staticGraphError,
  statusLabel,
  loadExample,
  reloadStaticGraph
} = useNodepodDemoGraph()

/**
 * Where the visitor has taken the demo: kept for the document, not in the
 * address — the landing page stays `/` — so Back from a module opened in the
 * viewer finds the demo as it was left.
 */
const state = useState('landing-blast-demo', startBlastDemo)

const center = computed(() =>
  graph.value ? resolveBlastDemoCenter(graph.value, state.value.center) : null
)
const finding = computed(() => {
  const radius = graph.value && center.value
    ? measureBlastRadius(graph.value, center.value)
    : null
  return radius ? describeBlastRadius(radius) : null
})
// With no graph drawn there is nothing to reset.
const isAtStart = computed(() => !graph.value || isBlastDemoAtStart(graph.value, state.value))

/**
 * In place: another module is put in the middle here, and Direct Run leaves
 * for the module's page through `/view`, which hands it the demo's graph —
 * the way the full graph's previews open a module. Framed whole wherever all
 * of it reads: a section's column is narrower than that, so it opens compact,
 * on the module and the first level of each side, as a module's page on a
 * phone does — hung below the chips along the canvas top and clear of its
 * zoom controls — the rest a chip or a step away.
 */
const navigation: BracketNavigation = {
  kind: 'in-place',
  leaveFor: buildPreviewModulePageLocation,
  framing: 'whole'
}

/** The module in the middle, opened on its own page in the viewer as the demo shows it. */
const moduleLocation = computed(() =>
  center.value
    ? buildPreviewModulePageLocation(center.value, { depth: state.value.depth })
    : undefined
)

/**
 * Whether the bracket on screen has been framed: set by the bracket's own
 * `framed`, once Vue Flow has taken the viewport it opens at, and cleared by
 * its `framing`, which it says the moment a frame is owed — as it opens, a new
 * one for another graph included, and as its module, a depth or its size
 * changes. With a graph to draw, it is what the root's `data-ready` says — a
 * signal from the canvas, never a timer.
 */
const isFramed = ref(false)
const isReady = computed(() => Boolean(graph.value && center.value) && isFramed.value)

/** The demo itself: where keyboard focus goes when a move takes away the control it was on. */
const demoRef = ref<HTMLElement | null>(null)

/**
 * Makes a move, keeping keyboard focus in the demo. The control a move is
 * made from can be gone once it is made — a module card now in the middle, a
 * "+N more" stub whose level is shown, Reset once the demo is back where it
 * opened — and focus would fall back to the start of the page. It goes to
 * the demo instead, whose finding says what changed; a stepper, still there,
 * keeps it.
 */
async function move(change: () => void): Promise<void> {
  const hadFocus = demoRef.value?.contains(document.activeElement) ?? false
  change()
  await nextTick()
  if (hadFocus && demoRef.value && !demoRef.value.contains(document.activeElement)) {
    demoRef.value.focus({ preventScroll: true })
  }
}

function recenter(moduleName: string): void {
  void move(() => {
    state.value = recenterBlastDemo(state.value, moduleName)
  })
}

function setDepth(side: BracketSide, depth: number): void {
  void move(() => {
    state.value = setBlastDemoDepth(state.value, side, depth)
  })
}

function reset(): void {
  void move(() => {
    state.value = startBlastDemo()
  })
}
</script>

<template>
  <section
    ref="demoRef"
    class="blast-demo space-y-3"
    aria-label="Blast effect"
    tabindex="-1"
    data-ui
    :data-ready="isReady ? 'true' : 'false'"
  >
    <div class="blast-demo__panel">
      <ClientOnly>
        <ModuleDependencyBracket
          v-if="graph && center"
          :key="view.source ?? undefined"
          :graph-data="graph"
          :module-name="center"
          :depth="state.depth"
          :navigation="navigation"
          @recenter="recenter"
          @depth-change="setDepth"
          @framing="isFramed = false"
          @framed="isFramed = true"
        />
        <div
          v-else
          class="relative size-full"
        >
          <USkeleton
            class="size-full rounded-none"
            :class="{ 'animate-none': view.placeholder === 'error' }"
          />
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <div
              v-if="view.placeholder === 'error'"
              role="alert"
              class="flex max-w-sm flex-col items-center gap-3"
            >
              <UIcon
                name="i-lucide-circle-alert"
                class="size-6 text-error"
                aria-hidden="true"
              />
              <p class="text-sm text-highlighted">
                The example graph could not be loaded.
              </p>
              <p
                v-if="staticGraphError"
                class="text-sm text-muted text-pretty"
              >
                {{ staticGraphError }}
              </p>
              <div class="flex flex-wrap items-center justify-center gap-2">
                <UButton
                  icon="i-lucide-refresh-cw"
                  label="Try Again"
                  color="neutral"
                  variant="subtle"
                  class="cursor-pointer"
                  @click="reloadStaticGraph"
                />
                <UButton
                  icon="i-lucide-play"
                  label="Load Example"
                  color="neutral"
                  variant="outline"
                  class="cursor-pointer"
                  @click="loadExample"
                />
              </div>
            </div>
            <div
              v-else
              role="status"
              aria-live="polite"
              class="flex flex-col items-center gap-3"
            >
              <UIcon
                name="i-lucide-loader-2"
                class="size-6 animate-spin text-primary"
                aria-hidden="true"
              />
              <p class="text-sm text-muted tabular-nums">
                {{ view.liveDemo === 'starting' ? statusLabel : 'Loading the example graph…' }}
              </p>
            </div>
          </div>
        </div>

        <template #fallback>
          <USkeleton class="size-full rounded-none" />
        </template>
      </ClientOnly>
    </div>

    <!-- A caption, as the neighbouring previews have under theirs: what the
         picture says, on a line of its own, then its ways out on a row
         beneath — quiet, so the page's accent stays on the hero's call to
         action. Reset comes last, so the exits never move under the pointer
         as it comes and goes. -->
    <div class="space-y-2">
      <p
        class="text-sm text-muted text-pretty tabular-nums"
        aria-live="polite"
      >
        <template v-if="center && finding?.kind === 'reaches'">
          A change to
          <span
            class="font-medium text-highlighted"
            translate="no"
          >{{ center }}</span>
          reaches <span class="font-medium text-highlighted">{{ finding.modules }}</span>, {{ finding.distance }}.
        </template>
        <template v-else-if="center && finding?.kind === 'contained'">
          No module depends on
          <span
            class="font-medium text-highlighted"
            translate="no"
          >{{ center }}</span>: a change to it stays inside it.
        </template>
      </p>

      <div class="blast-demo__actions">
        <UButton
          v-if="moduleLocation"
          :to="moduleLocation"
          icon="i-lucide-panel-top-open"
          label="Open this module in the viewer"
          color="neutral"
          variant="outline"
          size="sm"
        />
        <UButton
          to="/view?preview=true"
          icon="i-lucide-network"
          label="Open full graph"
          color="neutral"
          variant="outline"
          size="sm"
        />
        <UButton
          v-if="!isAtStart"
          icon="i-lucide-rotate-ccw"
          label="Reset"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="`Reset to ${BLAST_DEMO_MODULE}`"
          class="cursor-pointer"
          @click="reset"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * The demo reads as the neighbouring previews do: the picture in a bordered,
 * rounded frame filling the section's column, then a caption row under it.
 */
.blast-demo {
  min-width: 0;
}

/*
 * The bracket fills the frame: its depth steppers, the canvas, and its key.
 * The frame is the neighbouring graphs' own — GraphViewer's 12px corners and
 * its --mg-subgraph-border, light and dark — and as tall as their pictures,
 * never shorter than the bracket needs to open clear of what is drawn over
 * its canvas: 88px down to below the chips, 239px for the module and its
 * first levels with the Root mark riding the top card — at their own size,
 * or as small as their names read at — and 4px at the foot, on top of the
 * 132px the steppers and the key take in a desktop column. In a desktop
 * column the canvas keeps the bracket's own 16px margin.
 */
.blast-demo__panel {
  height: clamp(29rem, 58vh, 34rem);
  overflow: hidden;
  border: 1px solid #bbb;
  border-radius: 0.75rem;
  background: var(--ui-bg);
}

.dark .blast-demo__panel {
  border-color: #4a5568;
}

.blast-demo__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/*
 * Where the canvas's zoom controls stand in a row along its foot — a phone,
 * or any touch screen — the frame is as tall as it ever is, for the row to
 * stay clear of the module's card too: the canvas needs 88px down to below
 * the chips, 230px for the module and its first levels, Root mark and all,
 * at a size their names read at, and 70px for the row and the room around
 * it — 388px — and the steppers and the key take another 148px on a phone.
 */
@media (pointer: coarse), (max-width: 639.98px) {
  .blast-demo__panel {
    height: 34rem;
  }
}

/*
 * On a phone the frame already stands in the page's 16px gutter, so the
 * canvas runs to the frame (--module-bracket-inset): that is the width the
 * module and both its first levels need at a size their names read at. The
 * ways out run the column's width, each a thumb's height.
 */
@media (max-width: 639.98px) {
  .blast-demo__panel {
    --module-bracket-inset: 0px;
  }

  .blast-demo__actions > * {
    flex: 1 1 100%;
    justify-content: center;
    min-height: 44px;
  }
}
</style>
