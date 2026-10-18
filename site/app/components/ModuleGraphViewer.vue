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
import type { CSSProperties } from 'vue'
import type { Edge, EdgeProps, Node, NodeMouseEvent } from '@vue-flow/core'
import type { BreadcrumbItem } from '@nuxt/ui'
import type { GraphOutput } from 'nest-graph-inspector'
import {
  buildDirectRunRequest,
  buildDirectRunSnapshot,
  getDirectRunProviderState,
  type DirectRunAnyMethod,
  type DirectRunExecutionSnapshot,
  type DirectRunResultPayload
} from '~/utils/direct-run-provider'
import { buildCircularIssueFlow } from '~/utils/circular-dependency-flow'
import {
  formatCircularEdgeLabel,
  getCircularEdgeGeometry,
  getCircularLabelPlacement,
  getCircularLabelScale,
  type CircularEdgeGeometry
} from '~/utils/circular-dependency-edge'
import { collectCircularDependencyIssues } from '~/utils/circular-dependency-issues'
import {
  CIRCULAR_DEPENDENCY_EDGE_COLOR,
  CONTROLLER_EDGE_COLOR,
  MODULE_EDGE_COLOR,
  PROVIDER_EDGE_COLOR
} from '~/utils/graph-viewer-edges'
import { resolveHoverCardPosition } from '~/utils/hover-card-position'
import {
  hasJsDocPreview,
  parseJsDocPreview,
  type JsDocPreviewBlock
} from '~/utils/jsdoc-preview'
import {
  DEEP_DIVE_ITEM_WIDTH,
  buildModuleDeepDive,
  createDeepDiveFitTracker,
  fitModuleDeepDive,
  getNodeHeight,
  withLiveNodePositions,
  type ModuleDeepDiveEdgeKind,
  type ModuleDeepDiveExternalNode,
  type ModuleDeepDiveItemNode
} from '~/utils/module-deep-dive'

/**
 * One module on its own canvas: what it declares, how its items inject one
 * another, and every dependency it reaches outside itself.
 *
 * The navigator answers "how do the modules fit together"; this answers "what
 * does this one module need, and from where" without tracing lines across the
 * whole application. The layout comes from `utils/module-deep-dive.ts`, so a
 * dependency always sits to the left of whatever injects it — or above it on
 * a phone, where the deep dive runs top to bottom.
 */
const props = withDefaults(
  defineProps<{
    moduleName: string
    graphData: GraphOutput
    directRunUrl?: string
    directRunHeaders?: Record<string, string>
    /** A graph read from a file has no application behind it to call. */
    directRunDisabled?: boolean
    /** Node id of the provider or controller whose Direct Run drawer is open. */
    directRunOn?: string
  }>(),
  {
    directRunUrl: undefined,
    directRunHeaders: undefined,
    directRunDisabled: false,
    directRunOn: undefined
  }
)

const emit = defineEmits<{
  // The node id, not the class name: only the id says provider or controller.
  directRunDrawerOpen: [nodeId: string]
  directRunDrawerClose: []
}>()

type FlowNode
  = | Node<ModuleDeepDiveItemNode, Record<string, never>, 'item'>
    | Node<ModuleDeepDiveExternalNode, Record<string, never>, 'external'>

/** What an edge carries: the reported cycles it is a step of. */
type FlowEdgeData = { cycleIds: number[] }
type CircularEdgeProps = EdgeProps<FlowEdgeData>

const NAVIGATOR_PATH = '/view/navigator'
/** How long a pointer has to rest on a node before its JSDoc appears. */
const JSDOC_HOVER_OPEN_DELAY_MS = 240
/** How long the card survives the pointer leaving its node, so it can be reached. */
const JSDOC_HOVER_CLOSE_DELAY_MS = 140

const EDGE_COLOR_BY_KIND: Readonly<Record<ModuleDeepDiveEdgeKind, string>> = {
  provider: PROVIDER_EDGE_COLOR,
  controller: CONTROLLER_EDGE_COLOR,
  external: MODULE_EDGE_COLOR
}

const flowId = `module-graph-${useId()}`
const containerRef = ref<HTMLElement | null>(null)

const mod = computed(() =>
  Object.hasOwn(props.graphData.modules, props.moduleName)
    ? props.graphData.modules[props.moduleName]
    : undefined
)
// A phone held upright reads the deep dive top to bottom: dependencies above,
// whatever injects them below.
const { isMobile } = useMobileDevice()
const deepDive = computed(() =>
  buildModuleDeepDive(props.graphData, props.moduleName, {
    orientation: isMobile.value ? 'vertical' : 'horizontal'
  })
)
const isRoot = computed(() => props.moduleName === props.graphData.root)
const moduleJsDoc = computed(() => parseJsDocPreview(mod.value?.jsdoc))

const breadcrumbItems = computed<BreadcrumbItem[]>(() => [
  { label: 'Navigator', icon: 'i-lucide-map', to: NAVIGATOR_PATH },
  { label: 'Modules' },
  { label: props.moduleName }
])

const overviewStats = computed(() => {
  const stats = deepDive.value?.stats
  if (!stats) {
    return []
  }

  return [
    { label: 'Imports', value: stats.imports },
    { label: 'Exports', value: stats.exports },
    { label: 'Providers', value: stats.providers },
    { label: 'Controllers', value: stats.controllers },
    { label: 'Internal deps', value: stats.internalDependencies },
    { label: 'External deps', value: stats.externalDependencies }
  ]
})

const flowNodes = computed<FlowNode[]>(() =>
  (deepDive.value?.nodes ?? []).map((node) => {
    const style = {
      width: `${DEEP_DIVE_ITEM_WIDTH}px`,
      height: `${getNodeHeight(node)}px`
    }
    // The sides the node's handles are on. The templates place the handles;
    // these tell Vue Flow, which only measures a handle again when they
    // change — without them, turning a phone would leave every edge on the
    // sides its handles have just left.
    const sides = {
      sourcePosition: isMobile.value ? Position.Bottom : Position.Right,
      targetPosition: isMobile.value ? Position.Top : Position.Left
    }

    return node.type === 'item'
      ? { id: node.id, type: 'item', position: node.position, data: node, style, ...sides }
      : { id: node.id, type: 'external', position: node.position, data: node, style, ...sides }
  })
)

const flowEdges = computed<Edge<FlowEdgeData>[]>(() =>
  (deepDive.value?.edges ?? []).map((edge) => {
    const isCircular = edge.cycleIds.length > 0
    const color = isCircular
      ? CIRCULAR_DEPENDENCY_EDGE_COLOR
      : EDGE_COLOR_BY_KIND[edge.kind]

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // A cycle edge bows clear of the columns it doubles back across, and a
      // self-loop can only be drawn that way, cycle report or not.
      type: isCircular || edge.source === edge.target ? 'circular' : 'smoothstep',
      data: { cycleIds: edge.cycleIds },
      style: {
        stroke: color,
        strokeWidth: isCircular ? 2.2 : 1.5,
        ...(edge.kind === 'external' ? { strokeDasharray: '6 4' } : {})
      },
      markerEnd: { type: MarkerType.ArrowClosed, color }
    }
  })
)

const hasCircularEdges = computed(() =>
  Boolean(deepDive.value?.edges.some(edge => edge.cycleIds.length > 0))
)

function getCircularGeometry(edgeProps: CircularEdgeProps): CircularEdgeGeometry {
  return getCircularEdgeGeometry({
    sourceX: edgeProps.sourceX,
    sourceY: edgeProps.sourceY,
    sourcePosition: edgeProps.sourcePosition,
    targetX: edgeProps.targetX,
    targetY: edgeProps.targetY,
    targetPosition: edgeProps.targetPosition,
    isSelfLoop: edgeProps.source === edgeProps.target
  })
}

const { fitBounds, getNodes, viewport, viewportHelper } = useVueFlow(flowId)

/** Labels keep their own size on a zoomed-out canvas, so a phone can read them. */
const circularLabelScale = computed(() => getCircularLabelScale(viewport.value.zoom))

function getCircularEdgeLabelStyle(edgeProps: CircularEdgeProps): CSSProperties {
  return {
    position: 'absolute',
    ...getCircularLabelPlacement(getCircularGeometry(edgeProps), circularLabelScale.value),
    pointerEvents: 'all'
  }
}

/** Room left around the deep dive, as Vue Flow reads a fit padding. */
const DEEP_DIVE_FIT_PADDING = 0.12

/**
 * Whether the canvas still owes the deep dive a fit. Vue Flow can report its
 * nodes measured before its viewport exists, and a fit asked for then does
 * nothing — the canvas would stay at its default viewport, with the top of
 * the graph and its cycle labels above it, under the header.
 */
let isDeepDiveFitPending = true
const deepDiveFitTracker = createDeepDiveFitTracker()

/**
 * Where the canvas has each node now — the reader may have dragged some. The
 * deep dive has no parent nodes, so a node's computed position is its place
 * on the canvas.
 */
function getLiveNodePositions(): Map<string, { x: number, y: number }> {
  return new Map(getNodes.value.map(node => [
    node.id,
    { x: node.computedPosition.x, y: node.computedPosition.y }
  ]))
}

/**
 * Frames the deep dive with its cycle curves and labels, not only its nodes:
 * a label on a curve that bows past the nodes would otherwise sit outside the
 * canvas. Nodes are framed where the canvas has them, so a node the reader
 * dragged stays in view. Until the viewport is ready the fit stays pending,
 * and is made the moment it is. A newer fit supersedes one still running.
 */
async function fitDeepDive(): Promise<void> {
  const current = deepDive.value
  const isCurrent = deepDiveFitTracker.begin()
  isDeepDiveFitPending = true
  if (!current || !viewportHelper.value.viewportInitialized) {
    return
  }

  const liveDeepDive = withLiveNodePositions(current, getLiveNodePositions())
  const isFitted = await fitModuleDeepDive(liveDeepDive, {
    fitBounds: bounds => fitBounds(bounds, { padding: DEEP_DIVE_FIT_PADDING }),
    getZoom: () => viewport.value.zoom,
    isCurrent
  })
  if (isCurrent()) {
    isDeepDiveFitPending = !isFitted
  }
}

/** The reader asked for a fit — Controls' own frames the nodes alone. */
function refitDeepDive(): void {
  deepDiveFitTracker.reset()
  void fitDeepDive()
}

/** A pan or zoom of the reader's own: resizes leave their view alone now. */
function noteReaderMove(): void {
  deepDiveFitTracker.noteReaderMove()
}

// Another module is a fresh frame, whatever the reader did to the last one.
watch(() => props.moduleName, () => {
  deepDiveFitTracker.reset()
})

// So is the same module turned the other way: the view the reader left is of
// a layout that is gone. Its nodes keep their size, so Vue Flow reports them
// initialized only once — the fit waits for the canvas to take the new
// positions instead.
watch(isMobile, async () => {
  deepDiveFitTracker.reset()
  await nextTick()
  void fitDeepDive()
}, { flush: 'post' })

watch(
  () => viewportHelper.value.viewportInitialized,
  (isInitialized) => {
    if (isInitialized && isDeepDiveFitPending) {
      void fitDeepDive()
    }
  }
)

// A resize reframes a fit still owed, or one the reader has not moved away
// from — never a view they panned or zoomed themselves.
const debouncedFitDeepDive = useDebounceFn(() => {
  if (isDeepDiveFitPending || deepDiveFitTracker.shouldFitOnResize()) {
    void fitDeepDive()
  }
}, 200)

useResizeObserver(containerRef, debouncedFitDeepDive)

// Cycle details — the navigator's "Circular Story", for the cycles a label
// names, with every class on each cycle rather than only this module's.

const cycleIssues = computed(() => collectCircularDependencyIssues(props.graphData))
const openCycleIds = ref<number[]>([])
const openCycleIssues = computed(() =>
  cycleIssues.value.filter(issue => openCycleIds.value.includes(issue.id))
)
// Open or shut on its own, so closing keeps the story in the drawer while it
// slides away, as the navigator's does; the next label opened replaces it.
const showCycleDetails = ref(false)

function openCycleDetails(cycleIds: readonly number[]): void {
  closeJsDocHoverCard()
  openCycleIds.value = [...cycleIds]
  showCycleDetails.value = openCycleIssues.value.length > 0
}

/** A cycle label as a screen reader hears it: each cycle's whole path. */
function describeCycles(cycleIds: readonly number[]): string {
  const paths = cycleIssues.value
    .filter(issue => cycleIds.includes(issue.id))
    .map(issue => `Circular dependency #${issue.id}: ${issue.path.join(' -> ')}`)

  return paths.length > 0
    ? paths.join('. ')
    : `Circular dependency ${formatCircularEdgeLabel(cycleIds)}`
}

// The module's JSDoc shows one line until asked for the rest, so a long
// comment never pushes the canvas down the page.

const jsDocId = `${flowId}-jsdoc`
const jsDocBodyRef = ref<HTMLElement | null>(null)
const isJsDocExpanded = ref(false)
const isJsDocClipped = ref(false)

/** Whether the one collapsed line hides any of the comment. */
function measureJsDocClipping(): void {
  const body = jsDocBodyRef.value
  if (!body || isJsDocExpanded.value) {
    return
  }

  const firstBlock = body.firstElementChild
  isJsDocClipped.value = body.scrollHeight > body.clientHeight + 1
    || (firstBlock instanceof HTMLElement
      && firstBlock.scrollWidth > firstBlock.clientWidth + 1)
}

useResizeObserver(jsDocBodyRef, measureJsDocClipping)

watch(moduleJsDoc, () => {
  isJsDocExpanded.value = false
  void nextTick(measureJsDocClipping)
})

// JSDoc hover card — the navigator's behaviour: open after a short rest, and
// survive the pointer leaving the node long enough to be reached and scrolled.

type JsDocHoverCardState = {
  nodeId: string
  title: string
  kind: 'provider' | 'controller'
  blocks: JsDocPreviewBlock[]
  left: number
  top: number
  /** Placed only once measured, so hidden for the tick in between. */
  isPositioned: boolean
}

const jsDocHoverCard = ref<JsDocHoverCardState | null>(null)
const jsDocHoverCardRef = ref<HTMLElement | null>(null)
let jsDocHoverOpenTimer: ReturnType<typeof setTimeout> | undefined
let jsDocHoverCloseTimer: ReturnType<typeof setTimeout> | undefined
let pendingJsDocHoverNodeId: string | null = null

function closeJsDocHoverCard(): void {
  clearTimeout(jsDocHoverOpenTimer)
  clearTimeout(jsDocHoverCloseTimer)
  pendingJsDocHoverNodeId = null
  jsDocHoverCard.value = null
}

function openJsDocHoverCard(event: MouseEvent, node: ModuleDeepDiveItemNode): void {
  const anchor = event.currentTarget
  const blocks = parseJsDocPreview(node.jsdoc)
  if (blocks.length === 0 || !(anchor instanceof HTMLElement)) {
    return
  }

  clearTimeout(jsDocHoverOpenTimer)
  clearTimeout(jsDocHoverCloseTimer)
  pendingJsDocHoverNodeId = node.id
  jsDocHoverOpenTimer = setTimeout(() => {
    if (pendingJsDocHoverNodeId !== node.id) {
      return
    }

    jsDocHoverCard.value = {
      nodeId: node.id,
      title: node.label,
      kind: node.kind,
      blocks,
      left: 0,
      top: 0,
      isPositioned: false
    }
    void nextTick(() => positionJsDocHoverCard(node.id, anchor))
  }, JSDOC_HOVER_OPEN_DELAY_MS)
}

function positionJsDocHoverCard(nodeId: string, anchor: HTMLElement): void {
  const state = jsDocHoverCard.value
  const container = containerRef.value
  const card = jsDocHoverCardRef.value
  if (!state || state.nodeId !== nodeId || !container || !card || !anchor.isConnected) {
    return
  }

  const containerRect = container.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const cardRect = card.getBoundingClientRect()
  const { left, top } = resolveHoverCardPosition({
    anchor: {
      left: anchorRect.left - containerRect.left,
      top: anchorRect.top - containerRect.top,
      width: anchorRect.width,
      height: anchorRect.height
    },
    viewport: { width: containerRect.width, height: containerRect.height },
    card: { width: cardRect.width, height: cardRect.height }
  })

  jsDocHoverCard.value = { ...state, left, top, isPositioned: true }
}

/** Lets go of a node without dropping a card the pointer is moving onto. */
function scheduleJsDocHoverClose(nodeId: string): void {
  if ((jsDocHoverCard.value?.nodeId ?? pendingJsDocHoverNodeId) !== nodeId) {
    return
  }

  clearTimeout(jsDocHoverOpenTimer)
  clearTimeout(jsDocHoverCloseTimer)
  jsDocHoverCloseTimer = setTimeout(() => {
    if ((jsDocHoverCard.value?.nodeId ?? pendingJsDocHoverNodeId) === nodeId) {
      closeJsDocHoverCard()
    }
  }, JSDOC_HOVER_CLOSE_DELAY_MS)
}

function holdJsDocHoverCard(): void {
  clearTimeout(jsDocHoverCloseTimer)
}

onBeforeUnmount(closeJsDocHoverCard)

// Direct Run — a compact drawer over the same request and snapshot helpers the
// navigator's drawer uses. Arguments are a JSON array, checked for shape only.

const selectedNodeId = ref<string | null>(null)
/** Keyed `nodeId:method`, so two items' same-named methods never share state. */
const argsInputByKey = ref<Record<string, string>>({})
const argsErrorByKey = ref<Record<string, string>>({})
const snapshotByKey = ref<Record<string, DirectRunExecutionSnapshot>>({})
const pendingKey = ref<string | null>(null)

const selectedItem = computed(() => {
  const node = deepDive.value?.nodes.find(
    candidate => candidate.id === selectedNodeId.value
  )
  return node?.type === 'item' ? node : null
})

const selectedMethods = computed<DirectRunAnyMethod[]>(() => {
  const item = selectedItem.value
  if (!item) {
    return []
  }

  const entries = item.kind === 'controller'
    ? mod.value?.controllers
    : mod.value?.providers
  const entry = entries?.find(candidate => candidate.name === item.label)

  return entry ? getDirectRunProviderState(entry).methods : []
})

const directRunUnavailableReason = computed(() => {
  if (props.directRunDisabled) {
    return 'This graph was read from a file, so there is no running application to call.'
  }
  if (!props.directRunUrl) {
    return 'Direct Run endpoint is unavailable for this graph URL.'
  }
  return ''
})

const showDirectRunDrawer = computed({
  get: () => Boolean(selectedItem.value),
  set: (open) => {
    if (!open) {
      selectNode(null)
    }
  }
})

function selectNode(nodeId: string | null): void {
  const hadSelection = Boolean(selectedNodeId.value)
  selectedNodeId.value = nodeId

  if (nodeId) {
    emit('directRunDrawerOpen', nodeId)
  } else if (hadSelection) {
    emit('directRunDrawerClose')
  }
}

// Follow the page's `direct-run-on`, so a reload or a shared link reopens the
// drawer — but only onto a runnable item of this module.
watch(
  [() => props.directRunOn, deepDive],
  ([nodeId]) => {
    const node = deepDive.value?.nodes.find(candidate => candidate.id === nodeId)
    selectedNodeId.value = node?.type === 'item' && node.isRunnable ? node.id : null
  },
  { immediate: true }
)

function getMethodKey(methodName: string): string {
  return `${selectedNodeId.value}:${methodName}`
}

/** `[]` is how the library writes a method that takes nothing. */
function hasParameters(method: DirectRunAnyMethod): boolean {
  const parameterTypes = method.parameterTypes.trim()
  return parameterTypes !== '' && parameterTypes !== '[]'
}

function getMethodHttpLabel(method: DirectRunAnyMethod): string {
  const http = 'http' in method ? method.http : undefined
  return http ? `${http.method} ${http.path}` : ''
}

function parseArgs(
  method: DirectRunAnyMethod,
  input: string
): { ok: true, args: unknown[] | undefined } | { ok: false, error: string } {
  if (!hasParameters(method)) {
    return { ok: true, args: undefined }
  }

  const trimmed = input.trim()
  if (!trimmed) {
    return { ok: false, error: `Enter JSON arguments for ${method.name}().` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'Arguments must be valid JSON.' }
  }

  return Array.isArray(parsed)
    ? { ok: true, args: parsed }
    : { ok: false, error: `${method.name}() takes its arguments as a JSON array.` }
}

async function runMethod(method: DirectRunAnyMethod): Promise<void> {
  const item = selectedItem.value
  if (!item || !props.directRunUrl || props.directRunDisabled || pendingKey.value) {
    return
  }

  const key = getMethodKey(method.name)
  const parsed = parseArgs(method, argsInputByKey.value[key] ?? '')
  if (!parsed.ok) {
    argsErrorByKey.value = { ...argsErrorByKey.value, [key]: parsed.error }
    return
  }

  const { [key]: _cleared, ...remainingErrors } = argsErrorByKey.value
  argsErrorByKey.value = remainingErrors
  pendingKey.value = key

  let response: DirectRunResultPayload
  try {
    response = await $fetch<DirectRunResultPayload>(props.directRunUrl, {
      method: 'POST',
      headers: props.directRunHeaders,
      body: buildDirectRunRequest({
        moduleName: props.moduleName,
        targetType: item.kind,
        targetName: item.label,
        methodName: method.name,
        args: parsed.args
      })
    })
  } catch (error) {
    // A refused call still answers with the payload saying why.
    response = (error as { data?: DirectRunResultPayload }).data ?? {
      ok: false,
      error: error instanceof Error ? error.message : 'Direct run failed.'
    }
  } finally {
    pendingKey.value = null
  }

  snapshotByKey.value = {
    ...snapshotByKey.value,
    [key]: buildDirectRunSnapshot({ response, requestedMethod: method.name })
  }
}

function handleNodeClick(event: NodeMouseEvent): void {
  closeJsDocHoverCard()
  const node = event.node.data as ModuleDeepDiveItemNode | ModuleDeepDiveExternalNode
  selectNode(node.type === 'item' && node.isRunnable ? node.id : null)
}

function handlePaneClick(): void {
  closeJsDocHoverCard()
  selectNode(null)
}
</script>

<template>
  <div class="module-graph flex h-full min-h-0 flex-col">
    <header class="relative z-10 border-b border-default bg-default px-4 py-2">
      <div class="flex items-center justify-between gap-3">
        <UBreadcrumb
          :items="breadcrumbItems"
          class="min-w-0"
        />
        <UButton
          icon="i-lucide-arrow-left"
          label="Back to Application Graph"
          color="neutral"
          variant="outline"
          size="xs"
          class="shrink-0"
          :ui="{ label: 'max-sm:sr-only' }"
          :to="NAVIGATOR_PATH"
        />
      </div>

      <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div class="flex min-w-0 items-center gap-2">
          <UIcon
            name="i-lucide-package"
            class="size-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <h1 class="truncate font-mono text-base font-semibold">
            {{ props.moduleName }}
          </h1>
          <UBadge
            v-if="isRoot"
            label="Root"
            color="error"
            variant="subtle"
            size="sm"
          />
        </div>

        <ul
          class="module-graph__stats"
          aria-label="Module overview"
        >
          <li
            v-for="stat in overviewStats"
            :key="stat.label"
            class="module-graph__stat"
          >
            <span class="font-semibold tabular-nums">{{ stat.value }}</span>
            <span class="text-muted">{{ stat.label }}</span>
          </li>
        </ul>
      </div>

      <div
        v-if="moduleJsDoc.length"
        class="module-graph__jsdoc text-sm text-muted"
        :class="{ 'module-graph__jsdoc--expanded': isJsDocExpanded }"
      >
        <div
          :id="jsDocId"
          ref="jsDocBodyRef"
          class="module-graph__jsdoc-body"
        >
          <template
            v-for="(block, index) in moduleJsDoc"
            :key="index"
          >
            <p v-if="block.kind === 'paragraph'">
              {{ block.text }}
            </p>
            <ul
              v-else
              class="list-disc ps-5"
            >
              <li
                v-for="(listItem, itemIndex) in block.items"
                :key="itemIndex"
              >
                {{ listItem }}
              </li>
            </ul>
          </template>
        </div>
        <UButton
          v-if="isJsDocExpanded || isJsDocClipped"
          :label="isJsDocExpanded ? 'Show less' : 'Show more'"
          color="neutral"
          variant="link"
          size="xs"
          class="shrink-0 py-0"
          :aria-expanded="isJsDocExpanded"
          :aria-controls="jsDocId"
          @click="isJsDocExpanded = !isJsDocExpanded"
        />
      </div>
    </header>

    <div
      ref="containerRef"
      class="relative min-h-0 flex-1 overflow-hidden"
    >
      <VueFlow
        :id="flowId"
        :nodes="flowNodes"
        :edges="flowEdges"
        :nodes-connectable="false"
        :min-zoom="0.2"
        @nodes-initialized="fitDeepDive"
        @node-click="handleNodeClick"
        @pane-click="handlePaneClick"
        @move-start="closeJsDocHoverCard"
        @move-end="noteReaderMove"
      >
        <template #edge-circular="edgeProps">
          <BaseEdge
            :id="edgeProps.id"
            :path="getCircularGeometry(edgeProps).path"
            :marker-end="edgeProps.markerEnd"
            :style="edgeProps.style"
            :interaction-width="edgeProps.interactionWidth"
          />

          <EdgeLabelRenderer v-if="edgeProps.data?.cycleIds.length">
            <UTooltip
              text="Click for the whole cycle"
              :delay-duration="0"
            >
              <button
                type="button"
                class="module-graph__cycle nodrag nopan"
                :style="getCircularEdgeLabelStyle(edgeProps)"
                :aria-label="describeCycles(edgeProps.data.cycleIds)"
                @click.stop="openCycleDetails(edgeProps.data.cycleIds)"
              >
                <UIcon
                  name="i-lucide-triangle-alert"
                  class="module-graph__cycle-icon"
                  aria-hidden="true"
                />
                {{ formatCircularEdgeLabel(edgeProps.data.cycleIds) }}
              </button>
            </UTooltip>
          </EdgeLabelRenderer>
        </template>

        <template #node-item="itemProps">
          <Handle
            type="target"
            :position="isMobile ? Position.Top : Position.Left"
          />
          <div
            class="module-graph-node"
            :class="[
              `module-graph-node--${itemProps.data.kind}`,
              {
                'module-graph-node--documented': hasJsDocPreview(itemProps.data.jsdoc),
                'module-graph-node--runnable': itemProps.data.isRunnable
              }
            ]"
            @mouseenter="openJsDocHoverCard($event, itemProps.data)"
            @mouseleave="scheduleJsDocHoverClose(itemProps.id)"
          >
            <span class="module-graph-node__badge module-graph-node__kind">
              {{ itemProps.data.kind === 'controller' ? 'C' : 'P' }}
            </span>
            <span
              v-if="itemProps.data.isExported"
              class="module-graph-node__badge module-graph-node__export"
              title="Exported"
            >
              E
            </span>
            <span class="module-graph-node__label">
              {{ itemProps.data.label }}
            </span>
            <UIcon
              v-if="itemProps.data.isRunnable"
              name="i-lucide-play"
              class="module-graph-node__run"
              aria-label="Direct Run available"
            />
          </div>
          <Handle
            type="source"
            :position="isMobile ? Position.Bottom : Position.Right"
          />
        </template>

        <template #node-external="externalProps">
          <Handle
            type="target"
            :position="isMobile ? Position.Top : Position.Left"
          />
          <div class="module-graph-node module-graph-node--external">
            <span
              class="module-graph-node__badge module-graph-node__ext"
              title="Imported"
            >
              EXT
            </span>
            <span class="module-graph-node__stack">
              <span class="module-graph-node__label">
                {{ externalProps.data.label }}
              </span>
              <span class="module-graph-node__from">
                from {{ externalProps.data.moduleName }}
              </span>
            </span>
          </div>
          <Handle
            type="source"
            :position="isMobile ? Position.Bottom : Position.Right"
          />
        </template>

        <Background />
        <Controls
          @zoom-in="noteReaderMove"
          @zoom-out="noteReaderMove"
          @fit-view="refitDeepDive"
        />
      </VueFlow>

      <div
        v-if="jsDocHoverCard"
        ref="jsDocHoverCardRef"
        class="module-graph__jsdoc-card"
        :class="{ 'module-graph__jsdoc-card--positioned': jsDocHoverCard.isPositioned }"
        :style="{ left: `${jsDocHoverCard.left}px`, top: `${jsDocHoverCard.top}px` }"
        @mouseenter="holdJsDocHoverCard"
        @mouseleave="closeJsDocHoverCard"
      >
        <JsDocHoverCard
          :title="jsDocHoverCard.title"
          :kind="jsDocHoverCard.kind"
          :subtitle="props.moduleName"
          :blocks="jsDocHoverCard.blocks"
        />
      </div>

      <p
        v-if="!flowNodes.length"
        class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted"
      >
        This module declares no providers or controllers.
      </p>
    </div>

    <footer
      class="module-graph__legend border-t border-default px-4 py-2 text-xs text-muted"
      aria-label="Legend"
    >
      <span class="module-graph__legend-item">
        <span class="module-graph__swatch module-graph__swatch--provider" />
        Internal Provider
      </span>
      <span class="module-graph__legend-item">
        <span class="module-graph__swatch module-graph__swatch--controller" />
        Controller
      </span>
      <span class="module-graph__legend-item">
        <span class="module-graph__swatch module-graph__swatch--external" />
        External Dependency
      </span>
      <span class="module-graph__legend-item">
        <span class="module-graph-node__badge module-graph-node__export">E</span>
        Exported
      </span>
      <span class="module-graph__legend-item">
        <span class="module-graph__line module-graph__line--provider" />
        Provider injection
      </span>
      <span class="module-graph__legend-item">
        <span class="module-graph__line module-graph__line--controller" />
        Controller injection
      </span>
      <span class="module-graph__legend-item">
        <span class="module-graph__line module-graph__line--external" />
        External import
      </span>
      <span
        v-if="hasCircularEdges"
        class="module-graph__legend-item"
      >
        <span class="module-graph__line module-graph__line--circular" />
        Circular dependency (#id)
      </span>
    </footer>

    <UDrawer
      v-model:open="showDirectRunDrawer"
      direction="right"
      :ui="{ content: 'w-screen max-w-md' }"
    >
      <template #header>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-xs uppercase tracking-wide text-muted">
              {{ selectedItem?.kind === 'controller' ? 'Controller Action' : 'Provider Action' }}
            </p>
            <p class="truncate font-mono font-semibold">
              {{ selectedItem?.label }}
            </p>
            <p class="text-sm text-muted">
              {{ props.moduleName }}
            </p>
          </div>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            square
            aria-label="Close direct run drawer"
            @click="showDirectRunDrawer = false"
          />
        </div>
      </template>

      <template #body>
        <div class="space-y-4">
          <UAlert
            v-if="directRunUnavailableReason"
            color="neutral"
            variant="subtle"
            icon="i-lucide-info"
            :description="directRunUnavailableReason"
          />

          <section
            v-for="method in selectedMethods"
            :key="method.name"
            class="space-y-2 rounded-lg border border-default p-3"
          >
            <div class="flex flex-wrap items-center gap-2">
              <code class="font-semibold">{{ method.name }}()</code>
              <UBadge
                v-if="getMethodHttpLabel(method)"
                :label="getMethodHttpLabel(method)"
                color="neutral"
                variant="subtle"
                size="sm"
              />
            </div>
            <p class="font-mono text-xs text-muted">
              {{ method.parameterTypes }}
            </p>

            <UTextarea
              v-if="hasParameters(method)"
              v-model="argsInputByKey[getMethodKey(method.name)]"
              :rows="3"
              autoresize
              class="w-full font-mono"
              placeholder="[ ...arguments as a JSON array ]"
              :aria-label="`Arguments for ${method.name}`"
            />
            <p
              v-if="argsErrorByKey[getMethodKey(method.name)]"
              class="text-xs text-error"
            >
              {{ argsErrorByKey[getMethodKey(method.name)] }}
            </p>

            <UButton
              icon="i-lucide-play"
              label="Run"
              size="sm"
              :loading="pendingKey === getMethodKey(method.name)"
              :disabled="Boolean(directRunUnavailableReason) || Boolean(pendingKey)"
              @click="runMethod(method)"
            />

            <div
              v-if="snapshotByKey[getMethodKey(method.name)]"
              class="space-y-2"
            >
              <UBadge
                :label="snapshotByKey[getMethodKey(method.name)]?.state === 'success' ? 'Success' : 'Failed'"
                :color="snapshotByKey[getMethodKey(method.name)]?.state === 'success' ? 'success' : 'error'"
                variant="subtle"
                size="sm"
              />
              <pre class="module-graph__result">{{ snapshotByKey[getMethodKey(method.name)]?.summary }}</pre>
              <UButton
                v-if="snapshotByKey[getMethodKey(method.name)]?.traceId"
                icon="i-lucide-activity"
                label="Open Trace"
                color="neutral"
                variant="link"
                size="sm"
                to="/view/trace"
              />
            </div>
          </section>
        </div>
      </template>
    </UDrawer>

    <UDrawer
      v-model:open="showCycleDetails"
      :ui="{ content: 'w-screen max-w-none' }"
    >
      <template #header>
        <div class="flex w-full items-start justify-between gap-3">
          <p class="text-base font-semibold text-highlighted">
            Circular Story
          </p>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            square
            aria-label="Close drawer"
            @click="showCycleDetails = false"
          />
        </div>
      </template>

      <template #body>
        <div class="flex flex-col gap-2.5">
          <CircularDependencyIssueCard
            v-for="issue in openCycleIssues"
            :key="issue.id"
            :issue="issue"
            :flow="buildCircularIssueFlow(issue)"
            :flow-id="`${flowId}-cycle-${issue.id}`"
          />
        </div>
      </template>
    </UDrawer>
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
.module-graph {
  --mg-node-text: #333;
  --mg-controller-bg: #eaf7ff;
  --mg-controller-border: #38bdf8;
  --mg-controller-kind-bg: #0284c7;
  --mg-provider-bg: #ecfdf3;
  --mg-provider-border: #22c55e;
  --mg-provider-kind-bg: #16a34a;
  --mg-export-badge-bg: #d97706;
  --mg-external-bg: rgba(2, 132, 199, 0.06);
  --mg-edge-module: #0284c7;
  --mg-edge-provider: #059669;
  --mg-edge-controller: #7c3aed;
  --mg-edge-circular: #d97706;
}

.dark .module-graph {
  --mg-node-text: #e2e8f0;
  --mg-controller-bg: rgba(14, 116, 144, 0.26);
  --mg-controller-border: #22d3ee;
  --mg-controller-kind-bg: #0891b2;
  --mg-provider-bg: rgba(21, 128, 61, 0.26);
  --mg-provider-border: #4ade80;
  --mg-provider-kind-bg: #16a34a;
  --mg-export-badge-bg: #f59e0b;
  --mg-external-bg: rgba(56, 189, 248, 0.08);
  --mg-edge-module: #38bdf8;
  --mg-edge-provider: #34d399;
  --mg-edge-controller: #c084fc;
  --mg-edge-circular: #facc15;
}

.module-graph__stats {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 0.25rem;
  min-width: 0;
}

/* One scrollable row on a phone, rather than three rows of pills. */
@media (max-width: 639px) {
  .module-graph__stats {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: thin;
  }
}

.module-graph__stat {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: baseline;
  gap: 0.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  padding: 0 0.5rem;
  font-size: 0.75rem;
  line-height: 1.25rem;
  white-space: nowrap;
}

.module-graph__jsdoc {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin-top: 0.25rem;
  line-height: 1.25rem;
}

/* Collapsed, the comment is its first line; the button opens the rest. */
.module-graph__jsdoc-body {
  flex: 1;
  min-width: 0;
  max-height: 1.25rem;
  overflow: hidden;
}

.module-graph__jsdoc:not(.module-graph__jsdoc--expanded) .module-graph__jsdoc-body > p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-graph__jsdoc--expanded .module-graph__jsdoc-body {
  max-height: 6.5rem;
  overflow-y: auto;
}

.module-graph__jsdoc-body > * + * {
  margin-top: 0.375rem;
}

.module-graph-node {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 2px solid;
  border-radius: 4px;
  box-sizing: border-box;
  overflow: hidden;
  white-space: nowrap;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 12px;
  color: var(--mg-node-text);
}

.module-graph-node--provider {
  background: var(--mg-provider-bg);
  border-color: var(--mg-provider-border);
}

.module-graph-node--controller {
  background: var(--mg-controller-bg);
  border-color: var(--mg-controller-border);
}

.module-graph-node--external {
  background: var(--mg-external-bg);
  border-style: dashed;
  border-color: var(--mg-edge-module);
}

.module-graph-node--runnable {
  cursor: pointer;
}

.module-graph-node__badge {
  height: 18px;
  min-width: 18px;
  padding: 0 4px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}

.module-graph-node--provider .module-graph-node__kind {
  background: var(--mg-provider-kind-bg);
}

.module-graph-node--controller .module-graph-node__kind {
  background: var(--mg-controller-kind-bg);
}

.module-graph-node__export {
  background: var(--mg-export-badge-bg);
}

.module-graph-node__ext {
  background: var(--mg-edge-module);
}

.module-graph-node__stack {
  display: flex;
  min-width: 0;
  flex-direction: column;
  line-height: 1.25;
}

.module-graph-node__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.module-graph-node__from {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 10px;
  opacity: 0.7;
}

.module-graph-node__run {
  margin-left: auto;
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  opacity: 0.7;
}

/* A dotted underline is the only hint that a node has something to say. */
.module-graph-node--documented .module-graph-node__label {
  text-decoration: underline dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
}

.module-graph__jsdoc-card {
  position: absolute;
  z-index: 12;
  width: 320px;
  max-width: calc(100% - 16px);
  max-height: calc(100% - 16px);
  overflow-y: auto;
  visibility: hidden;
}

.module-graph__jsdoc-card--positioned {
  visibility: visible;
}

.module-graph__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
}

.module-graph__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.module-graph__swatch {
  width: 14px;
  height: 10px;
  border: 2px solid;
  border-radius: 2px;
}

.module-graph__swatch--provider {
  background: var(--mg-provider-bg);
  border-color: var(--mg-provider-border);
}

.module-graph__swatch--controller {
  background: var(--mg-controller-bg);
  border-color: var(--mg-controller-border);
}

.module-graph__swatch--external {
  background: var(--mg-external-bg);
  border-style: dashed;
  border-color: var(--mg-edge-module);
}

.module-graph__line {
  width: 22px;
  border-top: 2px solid;
}

.module-graph__line--provider {
  border-color: var(--mg-edge-provider);
}

.module-graph__line--controller {
  border-color: var(--mg-edge-controller);
}

.module-graph__line--external {
  border-top-style: dashed;
  border-color: var(--mg-edge-module);
}

.module-graph__line--circular {
  border-color: var(--mg-edge-circular);
}

/* Cycle labels sit above the nodes a doubled-back edge passes beside. */
.module-graph :deep(.vue-flow__edge-labels) {
  z-index: 7;
}

/* The navigator's cycle chip: the ids of the cycles the edge is a step of. */
.module-graph__cycle {
  height: 20px;
  padding: 0 7px;
  border: 1px solid #f59e0b;
  border-radius: 999px;
  background: #facc15;
  color: #713f12;
  box-shadow: 0 1px 4px rgba(120, 53, 15, 0.28);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.module-graph__cycle:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.module-graph__cycle-icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}

.module-graph__result {
  max-height: 12rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 0.375rem;
  background: var(--ui-bg-elevated);
  padding: 0.5rem;
  font-size: 12px;
}
</style>
