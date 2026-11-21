<script setup lang="ts">
import {
  VueFlow,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  useVueFlow
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { useDebounceFn, useResizeObserver } from '@vueuse/core'
import type { Edge, Node } from '@vue-flow/core'
import type { CSSProperties } from 'vue'
import type { GraphOutput } from 'nest-graph-inspector'
import {
  formatCircularEdgeLabel,
  getCircularLabelPlacement,
  unionRects,
  type CircularEdgeRect
} from '~/utils/circular-dependency-edge'
import {
  CIRCULAR_DEPENDENCY_EDGE_COLOR,
  MODULE_EDGE_COLOR
} from '~/utils/graph-viewer-edges'
import { createDeepDiveFitTracker } from '~/utils/module-deep-dive'
import {
  BRACKET_SIDES,
  buildModuleDependencyBracket,
  type BracketCenterNode,
  type BracketEdge,
  type BracketModuleNode,
  type BracketNode,
  type BracketSide,
  type BracketStubNode
} from '~/utils/module-dependency-bracket'
import { buildModulePageLocation } from '~/utils/module-page-route'

/**
 * A module among the others, as a tournament bracket opening both ways: what
 * it needs to its left, level by level, and what needs it to its right — the
 * dependencies view of a module's page. The layout, the routes and every fact
 * on the cards come from `utils/module-dependency-bracket.ts`; this draws them.
 *
 * Every other module on the canvas is a link to its own page, keeping the
 * depths asked for; a stub where a branch goes on asks for one more level on
 * its side, as the steppers above the canvas do. The page owns the address,
 * so a new depth is asked for with `depthChange` rather than set here.
 */
const props = defineProps<{
  graphData: GraphOutput
  moduleName: string
  /** The depths the page's address asks for, each side its own. */
  depth: Record<BracketSide, number>
}>()

const emit = defineEmits<{
  depthChange: [side: BracketSide, depth: number]
}>()

const flowId = `module-bracket-${useId()}`
const containerRef = ref<HTMLElement | null>(null)

const bracket = computed(() => buildModuleDependencyBracket({
  graph: props.graphData,
  center: props.moduleName,
  depth: props.depth
}))

/** What each side of the toolbar says, and whether its steppers can step. */
const sides = computed(() => {
  const summaries = bracket.value?.sides
  return BRACKET_SIDES.map((side) => {
    const summary = summaries?.[side]
    return {
      side,
      label: side === 'left' ? 'Needs' : 'Needed by',
      icon: side === 'left' ? 'i-lucide-arrow-left' : 'i-lucide-arrow-right',
      depth: summary?.depth ?? 0,
      available: summary?.available ?? 0,
      shown: summary?.shown ?? 0,
      canDeepen: Boolean(summary?.hasMore),
      canShallow: (summary?.depth ?? 0) > 1
    }
  })
})

type FlowNode = Node<BracketNode, Record<string, never>, BracketNode['kind']>
type FlowEdge = Edge<BracketEdge, Record<string, never>, 'bracket'>

const flowNodes = computed<FlowNode[]>(() =>
  (bracket.value?.nodes ?? []).map(node => ({
    id: node.id,
    type: node.kind,
    position: node.position,
    data: node,
    style: { width: `${node.width}px`, height: `${node.height}px` },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    domAttributes: getNodeAttributes(node)
  }))
)

/** What a test, or a stylesheet, can tell a node by. */
function getNodeAttributes(node: BracketNode): Record<string, string> {
  switch (node.kind) {
    case 'center':
      return { 'data-bracket-node': 'center' }
    case 'module':
    case 'stub':
    case 'level':
      return { 'data-bracket-node': node.kind, 'data-side': node.side, 'data-level': String(node.level) }
    case 'empty':
      return { 'data-bracket-node': 'empty', 'data-side': node.side }
    default: {
      const _exhaustive: never = node
      return _exhaustive
    }
  }
}

const flowEdges = computed<FlowEdge[]>(() =>
  (bracket.value?.edges ?? []).map((edge) => {
    const isCircular = edge.cycleIds.length > 0
    const color = edge.kind === 'stub'
      ? 'var(--ui-border-accented)'
      : isCircular ? CIRCULAR_DEPENDENCY_EDGE_COLOR : MODULE_EDGE_COLOR

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'bracket',
      data: edge,
      class: `bracket-edge bracket-edge--${edge.kind}${isCircular ? ' bracket-edge--circular' : ''}`,
      style: getEdgeStyle(edge, color),
      ...(edge.kind === 'stub' ? {} : { markerEnd: { type: MarkerType.ArrowClosed, color } })
    }
  })
)

type EdgeStroke = { stroke: string, strokeWidth: number, strokeDasharray?: string }

function getEdgeStyle(edge: BracketEdge, color: string): EdgeStroke {
  switch (edge.kind) {
    case 'tree':
    case 'self':
      return { stroke: color, strokeWidth: edge.cycleIds.length > 0 ? 2.2 : 1.75 }
    case 'link':
      return { stroke: color, strokeWidth: 1.25, strokeDasharray: '6 5' }
    case 'stub':
      return { stroke: color, strokeWidth: 1.5, strokeDasharray: '2 4' }
    default: {
      const _exhaustive: never = edge.kind
      return _exhaustive
    }
  }
}

const hasCircularEdges = computed(() =>
  Boolean(bracket.value?.edges.some(edge => edge.cycleIds.length > 0))
)
const hasLinks = computed(() =>
  Boolean(bracket.value?.edges.some(edge => edge.kind === 'link'))
)
const hasStubs = computed(() =>
  Boolean(bracket.value?.nodes.some(node => node.kind === 'stub'))
)
const hasCycleBadges = computed(() =>
  Boolean(bracket.value?.nodes.some(node => node.kind === 'module' && node.isOnCycleWithCenter))
)

/** Another module's page, keeping the depths asked for here. */
function recenterOn(node: BracketModuleNode) {
  return buildModulePageLocation(node.moduleName, { depth: props.depth })
}

/** The inside view of the module in the middle, Direct Run open on its first target. */
function directRunLocation(node: BracketCenterNode) {
  return buildModulePageLocation(node.moduleName, {
    depth: props.depth,
    directRunOn: node.stats.runnableNodeIds[0] ?? null
  })
}

function stepDepth(side: BracketSide, by: number): void {
  const current = sides.value.find(entry => entry.side === side)?.depth ?? 0
  emit('depthChange', side, Math.max(1, current + by))
}

function describeStub(stub: BracketStubNode): string {
  const modules = `${stub.moduleCount} more ${stub.moduleCount === 1 ? 'module' : 'modules'}`
  return stub.side === 'left'
    ? `Show ${modules}: one more level of what ${props.moduleName} needs`
    : `Show ${modules}: one more level of what needs ${props.moduleName}`
}

function pluralize(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

/** A cycle label at its own size, wherever the canvas is zoomed: it rides the connector it names. */
function getCycleLabelStyle(edge: BracketEdge): CSSProperties {
  return edge.label
    ? { position: 'absolute', ...getCircularLabelPlacement(edge.label, 1) }
    : { display: 'none' }
}

// Framing. The whole bracket on a canvas wide enough to read it; on a narrow
// one, the module and the first level each side — the rest a pan away.

const { fitBounds, viewportHelper } = useVueFlow(flowId)
const fitTracker = createDeepDiveFitTracker()
/** Room left around the bracket, as Vue Flow reads a fit padding. */
const FIT_PADDING = 0.08
/** Narrower than this, the canvas frames the first level only. */
const NARROW_CANVAS_PX = 640
let isFitPending = true

function getFitBounds(): CircularEdgeRect | null {
  const current = bracket.value
  if (!current) {
    return null
  }

  const width = containerRef.value?.clientWidth ?? Number.POSITIVE_INFINITY
  if (width >= NARROW_CANVAS_PX) {
    return current.bounds
  }

  return unionRects(current.nodes
    .filter(node => node.kind === 'center'
      || node.kind === 'empty'
      || (node.kind === 'module' && node.level === 1))
    .map(node => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height })))
}

/**
 * Frames the bracket. Until Vue Flow's viewport exists a fit does nothing, so
 * it stays owed and is made the moment the viewport is ready; a newer fit
 * supersedes one still running.
 */
async function fitBracket(): Promise<void> {
  const isCurrent = fitTracker.begin()
  isFitPending = true
  const bounds = getFitBounds()
  if (!bounds || !viewportHelper.value.viewportInitialized) {
    return
  }

  const isFitted = await fitBounds(bounds, { padding: FIT_PADDING })
  if (isCurrent()) {
    isFitPending = !isFitted
  }
}

function refitBracket(): void {
  fitTracker.reset()
  void fitBracket()
}

function noteReaderMove(): void {
  fitTracker.noteReaderMove()
}

watch(
  () => viewportHelper.value.viewportInitialized,
  (isInitialized) => {
    if (isInitialized && isFitPending) {
      void fitBracket()
    }
  },
  { immediate: true }
)

// Another module, or another depth, is a new bracket: framed afresh, whatever
// the reader did to the last one.
watch(
  [() => props.moduleName, () => props.depth.left, () => props.depth.right],
  async () => {
    fitTracker.reset()
    await nextTick()
    void fitBracket()
  }
)

// A resize reframes a fit still owed, or one the reader has not moved away
// from — never a view they panned or zoomed themselves.
const debouncedFit = useDebounceFn(() => {
  if (isFitPending || fitTracker.shouldFitOnResize()) {
    void fitBracket()
  }
}, 200)

useResizeObserver(containerRef, debouncedFit)
</script>

<template>
  <div class="module-bracket flex h-full min-h-0 flex-col">
    <div class="module-bracket__toolbar">
      <div
        v-for="entry in sides"
        :key="entry.side"
        role="group"
        class="module-bracket__depth"
        :class="`module-bracket__depth--${entry.side}`"
        :aria-labelledby="`${flowId}-${entry.side}-label`"
      >
        <span
          :id="`${flowId}-${entry.side}-label`"
          class="module-bracket__depth-label"
        >
          <UIcon
            v-if="entry.side === 'left'"
            :name="entry.icon"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          {{ entry.label }}
          <UIcon
            v-if="entry.side === 'right'"
            :name="entry.icon"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
        </span>
        <div class="module-bracket__stepper">
          <UButton
            icon="i-lucide-minus"
            color="neutral"
            variant="outline"
            size="sm"
            square
            aria-label="Show one level fewer"
            class="module-bracket__step"
            :disabled="!entry.canShallow"
            @click="stepDepth(entry.side, -1)"
          />
          <output
            class="module-bracket__depth-value"
            aria-live="polite"
          >
            {{ entry.depth }}<span class="sr-only"> {{ entry.depth === 1 ? 'level' : 'levels' }}</span>
          </output>
          <UButton
            icon="i-lucide-plus"
            color="neutral"
            variant="outline"
            size="sm"
            square
            aria-label="Show one more level"
            class="module-bracket__step"
            :disabled="!entry.canDeepen"
            @click="stepDepth(entry.side, 1)"
          />
        </div>
        <span class="module-bracket__depth-meta">
          <template v-if="entry.available === 0">
            None
          </template>
          <template v-else>
            of {{ entry.available }} · {{ pluralize(entry.shown, 'module') }}
          </template>
        </span>
      </div>
    </div>

    <div
      ref="containerRef"
      class="relative min-h-0 flex-1 overflow-hidden"
    >
      <VueFlow
        :id="flowId"
        :nodes="flowNodes"
        :edges="flowEdges"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :elements-selectable="false"
        :nodes-focusable="false"
        :edges-focusable="false"
        only-render-visible-elements
        :min-zoom="0.05"
        :max-zoom="1.5"
        :zoom-on-double-click="false"
        class="module-bracket__flow"
        @move-end="noteReaderMove"
      >
        <template #edge-bracket="edgeProps">
          <BaseEdge
            :id="edgeProps.id"
            :path="edgeProps.data.path"
            :marker-end="edgeProps.markerEnd"
            :style="edgeProps.style"
            :interaction-width="0"
          />

          <EdgeLabelRenderer v-if="edgeProps.data.label">
            <span
              class="module-bracket__cycle"
              :style="getCycleLabelStyle(edgeProps.data)"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="module-bracket__cycle-icon"
                aria-hidden="true"
              />
              <span aria-hidden="true">{{ formatCircularEdgeLabel(edgeProps.data.cycleIds) }}</span>
              <span class="sr-only">Circular dependency {{ formatCircularEdgeLabel(edgeProps.data.cycleIds) }}</span>
            </span>
          </EdgeLabelRenderer>
        </template>

        <template #node-center="{ data }">
          <Handle
            id="left-target"
            type="target"
            :position="Position.Left"
          />
          <Handle
            id="left-source"
            type="source"
            :position="Position.Left"
          />
          <div
            class="module-bracket-center"
            :class="{ 'module-bracket-center--root': data.isRoot }"
          >
            <div class="module-bracket-center__title">
              <UIcon
                name="i-lucide-package"
                class="size-4 shrink-0 text-muted"
                aria-hidden="true"
              />
              <span
                class="module-bracket-center__name"
                translate="no"
              >{{ data.moduleName }}</span>
              <span
                v-if="data.isRoot"
                class="module-bracket-badge module-bracket-badge--root"
              >Root</span>
              <span
                v-if="data.isOnCycle"
                class="module-bracket-badge module-bracket-badge--cycle"
              >
                <UIcon
                  name="i-lucide-repeat-2"
                  class="size-3 shrink-0"
                  aria-hidden="true"
                />
                Cycle
              </span>
            </div>
            <dl class="module-bracket-center__stats">
              <div>
                <dt>Providers</dt>
                <dd>{{ data.stats.providers }}</dd>
              </div>
              <div>
                <dt>Controllers</dt>
                <dd>{{ data.stats.controllers }}</dd>
              </div>
              <div>
                <dt>Imports</dt>
                <dd>{{ data.stats.imports }}</dd>
              </div>
              <div>
                <dt>Exports</dt>
                <dd>{{ data.stats.exports }}</dd>
              </div>
            </dl>
            <NuxtLink
              v-if="data.stats.runnableNodeIds.length"
              :to="directRunLocation(data)"
              class="module-bracket-center__run"
            >
              <UIcon
                name="i-lucide-play"
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              <span>Direct Run</span>
              <span class="module-bracket-center__run-count">
                {{ data.stats.runnableNodeIds.length }} runnable
              </span>
              <UIcon
                name="i-lucide-arrow-right"
                class="ms-auto size-4 shrink-0"
                aria-hidden="true"
              />
            </NuxtLink>
            <p
              v-else
              class="module-bracket-center__run module-bracket-center__run--none"
            >
              <UIcon
                name="i-lucide-play"
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              Direct Run: nothing to call
            </p>
          </div>
          <Handle
            id="right-target"
            type="target"
            :position="Position.Right"
          />
          <Handle
            id="right-source"
            type="source"
            :position="Position.Right"
          />
        </template>

        <template #node-module="{ data }">
          <Handle
            id="left-target"
            type="target"
            :position="Position.Left"
          />
          <Handle
            id="left-source"
            type="source"
            :position="Position.Left"
          />
          <NuxtLink
            :to="recenterOn(data)"
            class="module-bracket-module"
            :class="{ 'module-bracket-module--root': data.isRoot }"
          >
            <span
              class="module-bracket-module__name"
              translate="no"
            >{{ data.moduleName }}</span>
            <span
              v-if="data.isRoot"
              class="module-bracket-badge module-bracket-badge--root"
            >Root</span>
            <!-- The icon alone, so a long name keeps its room; the words are
                 there for a screen reader and on hover. -->
            <span
              v-if="data.isOnCycleWithCenter"
              class="module-bracket-badge module-bracket-badge--cycle module-bracket-badge--icon"
              data-cycle-badge
              :title="`On a cycle with ${props.moduleName}: each needs the other`"
            >
              <UIcon
                name="i-lucide-repeat-2"
                class="size-3 shrink-0"
                aria-hidden="true"
              />
              <span class="sr-only">On a cycle with {{ props.moduleName }}</span>
            </span>
          </NuxtLink>
          <Handle
            id="right-target"
            type="target"
            :position="Position.Right"
          />
          <Handle
            id="right-source"
            type="source"
            :position="Position.Right"
          />
        </template>

        <template #node-stub="{ data }">
          <Handle
            id="left-target"
            type="target"
            :position="Position.Left"
          />
          <Handle
            id="left-source"
            type="source"
            :position="Position.Left"
          />
          <button
            type="button"
            class="module-bracket-stub"
            :class="`module-bracket-stub--${data.side}`"
            :aria-label="describeStub(data)"
            @click="stepDepth(data.side, 1)"
          >
            <UIcon
              :name="data.side === 'left' ? 'i-lucide-chevrons-left' : 'i-lucide-chevrons-right'"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
            +{{ pluralize(data.moduleCount, 'module') }}
          </button>
          <Handle
            id="right-target"
            type="target"
            :position="Position.Right"
          />
          <Handle
            id="right-source"
            type="source"
            :position="Position.Right"
          />
        </template>

        <template #node-empty="{ data }">
          <p class="module-bracket-empty">
            {{ data.side === 'left' ? 'Imports no other module' : 'No module imports it' }}
          </p>
        </template>

        <template #node-level="{ data }">
          <p class="module-bracket-level">
            Level {{ data.level }}
            <span class="module-bracket-level__count">· {{ pluralize(data.moduleCount, 'module') }}</span>
          </p>
        </template>

        <Background />
        <Controls
          :show-interactive="false"
          @zoom-in="noteReaderMove"
          @zoom-out="noteReaderMove"
          @fit-view="refitBracket"
        />
      </VueFlow>
    </div>

    <footer
      class="module-bracket__legend border-t border-default px-4 py-2 text-xs text-muted"
      aria-label="Legend"
    >
      <span class="module-bracket__legend-item">
        <span class="module-bracket__line" />
        Import, pointing at the module importing
      </span>
      <span
        v-if="hasLinks"
        class="module-bracket__legend-item"
      >
        <span class="module-bracket__line module-bracket__line--link" />
        Import between modules already drawn
      </span>
      <span
        v-if="hasCircularEdges"
        class="module-bracket__legend-item"
      >
        <span class="module-bracket__line module-bracket__line--circular" />
        Circular dependency (#id)
      </span>
      <span
        v-if="hasCycleBadges"
        class="module-bracket__legend-item"
      >
        <span class="module-bracket-badge module-bracket-badge--cycle">
          <UIcon
            name="i-lucide-repeat-2"
            class="size-3 shrink-0"
            aria-hidden="true"
          />
          Cycle
        </span>
        Needs <span translate="no">{{ props.moduleName }}</span> and is needed by it
      </span>
      <span
        v-if="hasStubs"
        class="module-bracket__legend-item"
      >
        <span class="module-bracket__legend-stub">+N</span>
        More one level further: select to show it
      </span>
    </footer>
  </div>
</template>

<style>
@import "@vue-flow/core/dist/style.css";
@import "@vue-flow/core/dist/theme-default.css";
@import "@vue-flow/controls/dist/style.css";
</style>

<style scoped>
/*
 * The navigator's --mg-* palette, declared again here: this page can be the
 * first one a tab opens, before GraphViewer's global styles have ever loaded.
 */
.module-bracket {
  --mg-subgraph-border: #bbb;
  --mg-root-border: #ff6b6b;
  --mg-root-bg: rgba(255, 107, 107, 0.06);
  --mg-edge-module: #0284c7;
  --mg-edge-circular: #d97706;
}

.dark .module-bracket {
  --mg-subgraph-border: #4a5568;
  --mg-root-border: #f87171;
  --mg-root-bg: rgba(248, 113, 113, 0.08);
  --mg-edge-module: #38bdf8;
  --mg-edge-circular: #facc15;
}

/*
 * The two sides' depths, each at its own end of the bar as each side stands
 * at its own end of the bracket. On a phone both stay on one row and the
 * counts beside them go: the steppers are what the row is for.
 */
.module-bracket__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.module-bracket__depth {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.module-bracket__depth--right {
  flex-direction: row-reverse;
}

.module-bracket__depth-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-text-highlighted);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.module-bracket__stepper {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.module-bracket__depth-value {
  min-width: 2ch;
  color: var(--ui-text-highlighted);
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.module-bracket__depth-meta {
  color: var(--ui-text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/*
 * On a phone the two sides take a column each, the label over its stepper,
 * so both stay on screen at once with 40px targets.
 */
@media (max-width: 639.98px) {
  .module-bracket__toolbar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 6px 12px;
  }

  .module-bracket__depth,
  .module-bracket__depth--right {
    flex-direction: column;
    gap: 2px;
  }

  .module-bracket__depth--left {
    align-items: flex-start;
  }

  .module-bracket__depth--right {
    align-items: flex-end;
  }

  .module-bracket__step {
    width: 40px;
    height: 40px;
    justify-content: center;
  }

  .module-bracket__depth-meta {
    display: none;
  }
}

.module-bracket__flow :deep(.vue-flow__node) {
  cursor: default;
}

.module-bracket__flow :deep(.vue-flow__handle) {
  width: 6px;
  height: 6px;
  min-width: 0;
  min-height: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
}

/* Cycle labels ride above the cards a connector passes beside. */
.module-bracket :deep(.vue-flow__edge-labels) {
  z-index: 7;
}

/* Links are what the bracket has room left for: drawn, and kept back. */
.module-bracket__flow :deep(.bracket-edge--link:not(.bracket-edge--circular) .vue-flow__edge-path) {
  opacity: 0.55;
}

/* The module the page is about: larger, and framed in ink. */
.module-bracket-center {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 12px 14px;
  border: 2px solid var(--ui-border-inverted);
  border-radius: 10px;
  background: var(--ui-bg);
  box-sizing: border-box;
  font-family: "Public Sans", system-ui, sans-serif;
}

.module-bracket-center--root {
  border-color: var(--mg-root-border);
}

.module-bracket-center__title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.module-bracket-center__name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--ui-text-highlighted);
  font-size: 16px;
  font-weight: 700;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bracket-center__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
  padding: 8px 0;
  border-block: 1px solid var(--ui-border);
}

.module-bracket-center__stats > div + div {
  padding-left: 8px;
  border-left: 1px solid var(--ui-border);
}

.module-bracket-center__stats dt {
  overflow: hidden;
  color: var(--ui-text-muted);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bracket-center__stats dd {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 24px;
}

.module-bracket-center__run {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  margin: 0 -6px;
  padding: 0 6px;
  border-radius: 6px;
  color: var(--ui-text-highlighted);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: background-color 120ms ease;
}

a.module-bracket-center__run:hover {
  background: var(--ui-bg-elevated);
}

a.module-bracket-center__run:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.module-bracket-center__run-count {
  color: var(--ui-text-muted);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.module-bracket-center__run--none {
  color: var(--ui-text-muted);
  font-weight: 500;
}

/* Every other module: its name on a card drawn as the navigator draws a module. */
.module-bracket-module {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: 0 10px;
  border: 2px solid var(--mg-subgraph-border);
  border-radius: 8px;
  background: var(--ui-bg);
  box-sizing: border-box;
  color: var(--ui-text-highlighted);
  font-family: "Public Sans", system-ui, sans-serif;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 120ms ease;
}

.module-bracket-module--root {
  border-color: var(--mg-root-border);
  background: var(--mg-root-bg);
}

.module-bracket-module:hover {
  border-color: var(--ui-border-inverted);
}

.module-bracket-module:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.module-bracket-module__name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bracket-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.module-bracket-badge--root {
  background: color-mix(in srgb, var(--mg-root-border) 16%, transparent);
  color: var(--ui-error);
}

/* The cycle colour the graph's cycle labels wear. */
.module-bracket-badge--cycle {
  border: 1px solid #f59e0b;
  background: #facc15;
  color: #713f12;
}

.module-bracket-badge--icon {
  justify-content: center;
  width: 18px;
  padding: 0;
}

/* Where a branch goes on: a button asking for one more level. */
.module-bracket-stub {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 100%;
  border: 1.5px dashed var(--ui-border-accented);
  border-radius: 8px;
  background: var(--ui-bg);
  color: var(--ui-text-muted);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    color 120ms ease;
}

.module-bracket-stub--left {
  flex-direction: row;
}

.module-bracket-stub--right {
  flex-direction: row-reverse;
}

.module-bracket-stub:hover {
  border-color: var(--ui-border-inverted);
  color: var(--ui-text-highlighted);
}

.module-bracket-stub:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.module-bracket-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0 12px;
  border: 1px dashed var(--ui-border-accented);
  border-radius: 8px;
  box-sizing: border-box;
  color: var(--ui-text-muted);
  font-size: 13px;
  text-align: center;
}

.module-bracket-level {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 12px;
  font-weight: 600;
  line-height: 24px;
  white-space: nowrap;
}

.module-bracket-level__count {
  color: var(--ui-text-muted);
  font-weight: 500;
}

/* The deep dive's cycle chip: the ids of the cycles a connector is a step of. */
.module-bracket__cycle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid #f59e0b;
  border-radius: 999px;
  background: #facc15;
  color: #713f12;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
}

.module-bracket__cycle-icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}

.module-bracket__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
}

.module-bracket__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.module-bracket__line {
  width: 22px;
  border-top: 2px solid var(--mg-edge-module);
}

.module-bracket__line--link {
  border-top-style: dashed;
}

.module-bracket__line--circular {
  border-color: var(--mg-edge-circular);
}

.module-bracket__legend-stub {
  padding: 0 4px;
  border: 1px dashed var(--ui-border-accented);
  border-radius: 4px;
  font-weight: 600;
}

/* On a phone, one row the legend scrolls along, rather than four that push the graph off. */
@media (max-width: 639.98px) {
  .module-bracket__legend {
    flex-wrap: nowrap;
    overflow-x: auto;
    white-space: nowrap;
    scrollbar-width: thin;
  }
}

@media (prefers-reduced-motion: reduce) {
  .module-bracket-module,
  .module-bracket-stub,
  .module-bracket-center__run {
    transition: none;
  }
}
</style>
