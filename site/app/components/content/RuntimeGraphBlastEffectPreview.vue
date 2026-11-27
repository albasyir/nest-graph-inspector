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
 * The landing page's blast effect: a module of the demo application in the
 * middle of its dependency bracket — what it needs on the left, and on the
 * right every module a change to it would hit — drawn from the demo's graph
 * as every preview draws it (the static export, or the live demo once it
 * runs), and kept in place. The steppers, a "+N more" stub and a click on
 * another module all change the demo here; only its two exits leave the page.
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
 * the way the full graph's previews open a module. Framed whole: everything a
 * change reaches at the depth shown is on screen at once wherever its names
 * still read — a desktop — and a phone opens on the module, as its page does.
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
 * its `framing` and by anything here that frames it afresh. With a graph to
 * draw, it is what the root's `data-ready` says — a signal from the canvas,
 * never a timer.
 */
const isFramed = ref(false)
watch(
  [center, () => state.value.depth.left, () => state.value.depth.right, () => view.value.source],
  () => {
    isFramed.value = false
  }
)
const isReady = computed(() => Boolean(graph.value && center.value) && isFramed.value)

function recenter(moduleName: string): void {
  state.value = recenterBlastDemo(state.value, moduleName)
}

function setDepth(side: BracketSide, depth: number): void {
  state.value = setBlastDemoDepth(state.value, side, depth)
}

function reset(): void {
  state.value = startBlastDemo()
}
</script>

<template>
  <section
    class="blast-demo"
    aria-label="Blast effect"
    data-ui
    :data-ready="isReady ? 'true' : 'false'"
  >
    <div class="blast-demo__text">
      <p class="blast-demo__lead">
        <span class="blast-demo__term">Blast effect:</span>
        pick a module and see everything that depends on it — the modules a change would hit.
      </p>
      <p
        class="blast-demo__finding"
        aria-live="polite"
      >
        <template v-if="center && finding?.kind === 'reaches'">
          A change to
          <span
            class="blast-demo__module"
            translate="no"
          >{{ center }}</span>
          reaches <span class="blast-demo__count">{{ finding.modules }}</span>, {{ finding.distance }}.
        </template>
        <template v-else-if="center && finding?.kind === 'contained'">
          No module depends on
          <span
            class="blast-demo__module"
            translate="no"
          >{{ center }}</span>: a change to it stays inside it.
        </template>
      </p>
    </div>

    <!-- The page's own accent stays on the hero's call to action: the demo's
         way out is filled, the rest outlined or plain. -->
    <div class="blast-demo__actions">
      <UButton
        v-if="!isAtStart"
        icon="i-lucide-rotate-ccw"
        label="Reset"
        color="neutral"
        variant="ghost"
        size="lg"
        :aria-label="`Reset to ${BLAST_DEMO_MODULE}`"
        class="cursor-pointer"
        @click="reset"
      />
      <UButton
        v-if="moduleLocation"
        :to="moduleLocation"
        icon="i-lucide-panel-top-open"
        label="Open this module in the viewer"
        color="neutral"
        variant="outline"
        size="lg"
      />
      <UButton
        to="/view?preview=true"
        icon="i-lucide-network"
        label="Open full graph"
        color="neutral"
        variant="solid"
        size="lg"
      />
    </div>

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
  </section>
</template>

<style scoped>
/*
 * What it shows and how far a change reaches, its ways out, then the demo.
 * Wide, the ways out stand beside the words; on a phone they follow the
 * demo, so the demo comes first after the words.
 */
.blast-demo {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas:
    "text"
    "actions"
    "panel";
  gap: 12px;
  min-width: 0;
  text-align: start;
}

.blast-demo__text {
  grid-area: text;
  min-width: 0;
}

.blast-demo__lead {
  color: var(--ui-text-toned);
  font-size: 16px;
  line-height: 1.5;
  text-wrap: pretty;
}

.blast-demo__term,
.blast-demo__module,
.blast-demo__count {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}

.blast-demo__finding {
  margin-top: 4px;
  color: var(--ui-text-muted);
  font-size: 14px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}

.blast-demo__actions {
  grid-area: actions;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/*
 * The bracket fills the panel: its depth steppers, the canvas, and its key.
 * On a desktop it takes what the first screen has left below the hero — the
 * whole panel on screen at 1440×900 — and never less than the height at
 * which the opening module's whole bracket still draws its names at 11px or
 * more (27rem); a taller screen gets up to 32rem.
 */
.blast-demo__panel {
  grid-area: panel;
  height: clamp(27rem, calc(100svh - 28.5rem), 32rem);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-bg);
}

@media (min-width: 1024px) {
  .blast-demo {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "text actions"
      "panel panel";
    align-items: end;
    gap: 12px 24px;
  }
}

/*
 * On a phone the panel runs to the screen's edges, past the page's 16px
 * gutter, so the compact bracket gets the width a module's own page gives it:
 * the module and the first level of each side, at a size their names read
 * at. Taller, too, for the steppers' two rows and the key. The ways out come
 * after it, as wide as the screen.
 */
@media (max-width: 639.98px) {
  .blast-demo {
    grid-template-areas:
      "text"
      "panel"
      "actions";
  }

  .blast-demo__panel {
    height: 36rem;
    margin-inline: -16px;
    border-inline: 0;
    border-radius: 0;
  }

  .blast-demo__actions > * {
    flex: 1 1 100%;
    justify-content: center;
    min-height: 44px;
  }
}
</style>
