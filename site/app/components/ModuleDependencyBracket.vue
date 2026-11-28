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
import { ControlButton, Controls } from '@vue-flow/controls'
import { useDebounceFn, useElementSize, useMediaQuery, useResizeObserver } from '@vueuse/core'
import type { Edge, Node } from '@vue-flow/core'
import type { CSSProperties } from 'vue'
import type { GraphOutput } from 'nest-graph-inspector'
import {
  formatCircularEdgeLabel,
  getCircularLabelPlacement
} from '~/utils/circular-dependency-edge'
import {
  CIRCULAR_DEPENDENCY_EDGE_COLOR,
  MODULE_EDGE_COLOR
} from '~/utils/graph-viewer-edges'
import {
  formatLevelRange,
  getBracketFrame,
  getBracketLevelHeaders,
  getBracketOffscreen,
  getCutCardIds,
  getLevelRevealViewport,
  getVerticalRevealViewport,
  pickWholeFrameBracket,
  type BracketCanvas,
  type BracketFraming,
  type BracketViewport
} from '~/utils/module-bracket-viewport'
import { createDeepDiveFitTracker } from '~/utils/module-deep-dive'
import {
  BRACKET_SIDES,
  buildModuleDependencyBracket,
  type BracketCenterNode,
  type BracketEdge,
  type BracketModuleNode,
  type BracketNode,
  type BracketSide,
  type BracketSize,
  type BracketStubNode,
  type ModuleDependencyBracket
} from '~/utils/module-dependency-bracket'
import { splitNameIntoWords } from '~/utils/module-name-words'
import {
  buildModulePageLocation,
  type BracketNavigation,
  type ModulePageLocation
} from '~/utils/module-page-route'
import { NuxtLink } from '#components'

/**
 * A module among the others, as a tournament bracket opening both ways: what
 * it needs to its left, level by level, and what needs it to its right — the
 * dependencies view of a module's page. The layout, the routes and every fact
 * on the cards come from `utils/module-dependency-bracket.ts`; where the
 * canvas looks, from `utils/module-bracket-viewport.ts`; this draws them.
 *
 * The bracket reads first: each module joined to the one the walk came from.
 * Every other import between modules drawn is there on demand — for the
 * module under the pointer or the keyboard, for a cycle whose label is
 * pointed at or pressed, or for all of them at once from the legend.
 *
 * On a module's page every other module on the canvas is a link to its own
 * page, keeping the depths asked for; kept in place — the landing page's
 * demo — it asks for that module in the middle with `recenter` instead (see
 * `BracketNavigation`). A stub where a branch goes on asks for one more level
 * on its side, as the steppers above the canvas do. Whoever holds the bracket
 * owns its depths, so a new one is asked for with `depthChange` rather than
 * set here.
 */
const props = withDefaults(defineProps<{
  graphData: GraphOutput
  moduleName: string
  /** The depths asked for, each side its own: by a page's address, or by its host. */
  depth: Record<BracketSide, number>
  /** Where the bracket's links lead: `pages` on a module's page, the default. */
  navigation?: BracketNavigation
}>(), {
  navigation: () => ({ kind: 'pages' })
})

const emit = defineEmits<{
  depthChange: [side: BracketSide, depth: number]
  /** In place: the reader asked for another module in the middle. */
  recenter: [moduleName: string]
  /**
   * A frame is owed: what is on screen may not be where the bracket opens.
   * Said as the bracket opens, the moment its module, a depth or its size
   * changes, and as each frame starts — so a host never has to watch for them.
   */
  framing: []
  /**
   * The bracket on screen is framed: the viewport is where the bracket opens,
   * set once Vue Flow could take it — after mounting, and again whenever a
   * change frames it afresh.
   */
  framed: []
}>()

const flowId = `module-bracket-${useId()}`
const containerRef = ref<HTMLElement | null>(null)
const {
  viewport,
  dimensions,
  nodes,
  setNodes,
  setEdges,
  setViewport,
  viewportHelper,
  zoomIn,
  zoomOut,
  fitView
} = useVueFlow(flowId)

/** The strip of column headings pinned across the top of the canvas. */
const HEADINGS_HEIGHT = 32
const canvas = computed<BracketCanvas>(() => ({
  width: dimensions.value.width,
  height: dimensions.value.height,
  top: HEADINGS_HEIGHT
}))
const hasCanvas = computed(() => canvas.value.width > 0 && canvas.value.height > 0)

/** How the bracket opens: whole only where a host keeps it in place and asks. */
const framing = computed<BracketFraming>(() =>
  props.navigation.kind === 'in-place' ? props.navigation.framing : 'focus'
)

/**
 * Below this width a canvas draws the bracket compact — narrower cards,
 * names over two lines, tighter gaps — so a phone opens on the module and
 * the first level of each side at a size their names read at.
 */
const COMPACT_BELOW_WIDTH = 640
const isPhone = useMediaQuery('(max-width: 639.98px)')
const { width: canvasWidth } = useElementSize(containerRef)
/** The size the canvas's width gives the bracket; until it is measured, the window says. */
const widthSize = computed<BracketSize>(() =>
  (canvasWidth.value > 0 ? canvasWidth.value < COMPACT_BELOW_WIDTH : isPhone.value) ? 'compact' : 'regular'
)

function layOut(size: BracketSize): ModuleDependencyBracket | null {
  return buildModuleDependencyBracket({
    graph: props.graphData,
    center: props.moduleName,
    depth: props.depth,
    size
  })
}

// The bracket at each size, laid out only once asked for, and then only again
// for another module, depth or graph: a canvas resized picks between them
// again rather than laying either out afresh. A module's page asks for the
// size its width gives it alone, so it never lays a bracket out twice.
const regularBracket = computed(() => layOut('regular'))
const compactBracket = computed(() => layOut('compact'))
const widthBracket = computed(() =>
  widthSize.value === 'compact' ? compactBracket.value : regularBracket.value
)

/**
 * Framed whole, the bracket at a size it reads whole at on this canvas — the
 * regular one when it does, else the compact one — or none, and it opens in
 * focus at the size the canvas's width gives it.
 */
const wholeBracket = computed(() => {
  if (framing.value !== 'whole' || !hasCanvas.value) {
    return null
  }

  const laidOut = [regularBracket.value, compactBracket.value]
    .filter((candidate): candidate is ModuleDependencyBracket => candidate !== null)
  return pickWholeFrameBracket(laidOut, canvas.value)
})

const bracket = computed(() => wholeBracket.value ?? widthBracket.value)
const isCompact = computed(() => bracket.value?.size === 'compact')

const nodeById = computed(() =>
  new Map<string, BracketNode>((bracket.value?.nodes ?? []).map(node => [node.id, node]))
)

/** What each side of the toolbar says, and whether its steppers can step. */
const sides = computed(() => BRACKET_SIDES.map((side) => {
  const summary = bracket.value?.sides[side]
  const depth = summary?.depth ?? 0

  return {
    side,
    label: side === 'left' ? 'Needs' : 'Needed by',
    depth,
    available: summary?.available ?? 0,
    shown: summary?.shown ?? 0,
    canDeepen: Boolean(summary?.hasMore),
    canShallow: depth > 1
  }
}))

// What the reader is pointing at. The bracket draws its own connectors
// always; the rest follows the reader.

/** The card under the pointer, and the one the keyboard is on. */
const pointedNodeId = ref<string | null>(null)
const focusedNodeId = ref<string | null>(null)
/** The cycles a label under the pointer, or with focus, names. */
const pointedCycleIds = ref<readonly number[]>([])
/** The cycles a pressed label names: they stay lit until it is pressed again. */
const pinnedCycleIds = ref<readonly number[]>([])
const showAllImports = ref(false)

const activeNodeIds = computed(() => new Set(
  [pointedNodeId.value, focusedNodeId.value].filter((id): id is string => id !== null)
))
const activeCycleIds = computed(() => new Set(
  pointedCycleIds.value.length > 0 ? pointedCycleIds.value : pinnedCycleIds.value
))
/** The module on both sides the reader is on, whose other card lights up with it. */
const activeTwinName = computed(() => {
  for (const id of activeNodeIds.value) {
    const node = nodeById.value.get(id)
    if (node?.kind === 'module' && node.isOnCycleWithCenter) {
      return node.moduleName
    }
  }
  return null
})

function isEdgeLit(edge: BracketEdge): boolean {
  return edge.cycleIds.some(id => activeCycleIds.value.has(id))
}

function isEdgeDimmed(edge: BracketEdge): boolean {
  return activeCycleIds.value.size > 0 && !isEdgeLit(edge)
}

function isLinkShown(edge: BracketEdge): boolean {
  return showAllImports.value
    || isEdgeLit(edge)
    || activeNodeIds.value.has(edge.source)
    || activeNodeIds.value.has(edge.target)
}

function isTwinLit(node: BracketModuleNode): boolean {
  return node.isOnCycleWithCenter && activeTwinName.value === node.moduleName
}

function isCyclePinned(edge: BracketEdge): boolean {
  return edge.cycleIds.length > 0
    && edge.cycleIds.length === pinnedCycleIds.value.length
    && edge.cycleIds.every(id => pinnedCycleIds.value.includes(id))
}

function togglePinnedCycle(edge: BracketEdge): void {
  pinnedCycleIds.value = isCyclePinned(edge) ? [] : [...edge.cycleIds]
}

function pointAt(node: BracketNode): void {
  pointedNodeId.value = node.id
}

function leave(node: BracketNode): void {
  if (pointedNodeId.value === node.id) {
    pointedNodeId.value = null
  }
}

function focusOn(node: BracketNode): void {
  focusedNodeId.value = node.id
}

function blurFrom(node: BracketNode): void {
  if (focusedNodeId.value === node.id) {
    focusedNodeId.value = null
  }
}

type FlowNode = Node<BracketNode, Record<string, never>, BracketNode['kind']>
type FlowEdge = Edge<BracketEdge, Record<string, never>, 'bracket'>

// The column headings are drawn across the top of the canvas instead, at a
// size of their own, wherever the canvas is zoomed.
const flowNodes = computed<FlowNode[]>(() =>
  (bracket.value?.nodes ?? [])
    .filter(node => node.kind !== 'level')
    .map(node => ({
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

/**
 * Vue Flow draws only the cards in view, and tells them by `computedPosition`
 * and `dimensions` — where it last drew each one, and at what size — which
 * only a drawn card's own wrapper updates. A card moved or resized while
 * undrawn — the page re-centred on another module and back, the bracket laid
 * out at its other size — would stay undrawn wherever it now stands, its
 * place in the frame left empty. So once Vue Flow has a layout, every card is
 * given where it now stands, and its size if Vue Flow has measured it before;
 * one never drawn has no size yet, and is drawn once to be measured.
 */
function placeEveryCard(): void {
  for (const node of nodes.value) {
    const card = nodeById.value.get(node.id)
    if (!card) {
      continue
    }

    const { x, y } = card.position
    if (node.computedPosition.x !== x || node.computedPosition.y !== y) {
      node.computedPosition = { ...node.computedPosition, x, y }
    }

    const { width, height } = card
    if (node.dimensions.width > 0 && (node.dimensions.width !== width || node.dimensions.height !== height)) {
      node.dimensions = { width, height }
    }
  }
}

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
    const isLit = isEdgeLit(edge)
    // A stub's connector is an import like the bracket's own: drawn as one.
    const color = isCircular ? CIRCULAR_DEPENDENCY_EDGE_COLOR : MODULE_EDGE_COLOR
    const classes = [
      'bracket-edge',
      `bracket-edge--${edge.kind}`,
      isCircular ? 'bracket-edge--circular' : '',
      isLit ? 'bracket-edge--lit' : '',
      isEdgeDimmed(edge) ? 'bracket-edge--dimmed' : ''
    ]

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'bracket',
      data: edge,
      hidden: edge.kind === 'link' && !isLinkShown(edge),
      // A cycle's own line is drawn over the bracket's where they cross.
      zIndex: isLit ? 2 : isCircular ? 1 : 0,
      class: classes.filter(Boolean).join(' '),
      style: getEdgeStyle(edge, color, isLit),
      markerEnd: { type: MarkerType.ArrowClosed, color }
    }
  })
)

// Vue Flow is handed the bracket here rather than through its `nodes` and
// `edges` props: after each update, a prop's watcher stands still until the
// next tick, so a layout following another inside it — the canvas measured
// as the bracket opens and the bracket laid out at its other size — would be
// dropped, and the canvas would keep the first one for good. The cards go in
// before the connectors that name them, and are placed as soon as they are in.
watch([flowNodes, flowEdges], ([nextNodes, nextEdges], [previousNodes, previousEdges]) => {
  if (nextNodes !== previousNodes) {
    setNodes(nextNodes)
    placeEveryCard()
  }
  if (nextEdges !== previousEdges) {
    setEdges(nextEdges)
  }
}, { immediate: true })

type EdgeStroke = { stroke: string, strokeWidth: number, strokeDasharray?: string }

function getEdgeStyle(edge: BracketEdge, color: string, isLit: boolean): EdgeStroke {
  switch (edge.kind) {
    case 'tree':
    case 'self':
      return { stroke: color, strokeWidth: isLit ? 3 : edge.cycleIds.length > 0 ? 2.25 : 1.75 }
    case 'link':
      return { stroke: color, strokeWidth: isLit ? 2.25 : 1.5, strokeDasharray: '6 5' }
    case 'stub':
      return { stroke: color, strokeWidth: 1.75 }
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
const hasTwins = computed(() =>
  Boolean(bracket.value?.nodes.some(node => node.kind === 'module' && node.isOnCycleWithCenter))
)

/**
 * Another module's page, keeping the depths asked for here: a place of its
 * own, which Back returns from to this one.
 */
function recenterOn(node: BracketModuleNode): ModulePageLocation {
  return buildModulePageLocation(node.moduleName, { depth: props.depth })
}

/** What a module card is: a link to its own page, or — in place — a button asking for it in the middle. */
type ModuleCardAttrs
  = | { to: ModulePageLocation }
    | { type: 'button', onClick: () => void }

function moduleCardAttrs(node: BracketModuleNode): ModuleCardAttrs {
  return props.navigation.kind === 'in-place'
    ? { type: 'button', onClick: () => emit('recenter', node.moduleName) }
    : { to: recenterOn(node) }
}

/**
 * Direct Run on the module in the middle, open on its first target. On its
 * page that is the same module's inside view, so it replaces the address, as
 * the page's own view switch does; in place it leaves for where the host
 * says, a step Back returns from.
 */
function directRunLink(node: BracketCenterNode): { to: ModulePageLocation, replace: boolean } {
  const state = { depth: props.depth, directRunOn: node.stats.runnableNodeIds[0] ?? null }
  const navigation = props.navigation

  return navigation.kind === 'in-place'
    ? { to: navigation.leaveFor(node.moduleName, state), replace: false }
    : { to: buildModulePageLocation(node.moduleName, state), replace: true }
}

function stepDepth(side: BracketSide, by: number, isAllowed: boolean): void {
  if (!isAllowed) {
    return
  }

  const current = sides.value.find(entry => entry.side === side)?.depth ?? 0
  emit('depthChange', side, Math.max(1, current + by))
}

/** A stub's name: its own words first, then what pressing it does. */
function describeStub(stub: BracketStubNode): string {
  const shown = `+${pluralize(stub.moduleCount, 'more module')}`
  return stub.side === 'left'
    ? `${shown}: show one more level of what ${props.moduleName} needs`
    : `${shown}: show one more level of what needs ${props.moduleName}`
}

/** How many of the modules past a stub its tooltip names before counting the rest. */
const STUB_NAMES_LISTED = 6

/** What a stub holds back, by name: its tooltip. */
function listStubModules(stub: BracketStubNode): string {
  const listed = stub.moduleNames.slice(0, STUB_NAMES_LISTED)
  const rest = stub.moduleNames.length - listed.length
  return rest > 0
    ? `${listed.join(', ')} and ${rest} more`
    : listed.join(', ')
}

/** What being on both sides means, for a module on one of them. */
function describeTwin(node: BracketModuleNode): string {
  return node.side === 'left'
    ? `It also needs ${props.moduleName}: the two are on a cycle`
    : `${props.moduleName} also needs it: the two are on a cycle`
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

// Framing. A bracket opens on its module at a zoom its names read at — all
// of it when that fits — and what the canvas cuts off is a chip away; kept in
// place to be framed whole, it opens on all of it wherever that reads.

const fitTracker = createDeepDiveFitTracker()
const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
const REVEAL_DURATION_MS = 280
/**
 * Whether a frame is owed: the bracket on screen is not yet where it opens.
 * The root says it as `data-framed`, a signal a test can wait on.
 */
const isFramePending = ref(true)

/**
 * A frame is owed from now, and the host hears it at once as `framing`: the
 * bracket owes one as it opens, the moment anything it draws changes, and as
 * each frame starts. A host binds `framing` and `framed`, nothing more.
 */
function oweFrame(): void {
  isFramePending.value = true
  emit('framing')
}

oweFrame()

/**
 * Frames the bracket. Until Vue Flow's viewport exists a frame does nothing,
 * so it stays owed and is made the moment the viewport is ready; a newer
 * frame supersedes one still running. It says `framing` as it starts — what
 * is on screen may not be this frame — and `framed` once Vue Flow has taken
 * it.
 */
async function frameBracket(): Promise<void> {
  const isCurrent = fitTracker.begin()
  oweFrame()
  const current = bracket.value
  if (!current || !viewportHelper.value.viewportInitialized || !hasCanvas.value) {
    return
  }

  // Vue Flow answers `false` only without its zoom handler, which a viewport
  // it calls initialized always has; with no duration it answers at once.
  const isFramed = await setViewport(getBracketFrame(current, canvas.value, framing.value))
  if (isCurrent()) {
    isFramePending.value = !isFramed
    if (isFramed) {
      emit('framed')
    }
  }
}

/** Back to the frame the bracket opened at, as if it had just opened. */
function recentre(): void {
  fitTracker.reset()
  void frameBracket()
}

function noteReaderMove(): void {
  fitTracker.noteReaderMove()
}

function zoomCanvas(direction: 'in' | 'out'): void {
  noteReaderMove()
  void (direction === 'in' ? zoomIn() : zoomOut())
}

/** All of the bracket at once, however small that draws it: an overview to zoom into. */
function showWholeBracket(): void {
  noteReaderMove()
  void fitView({ padding: 0.08 })
}

/**
 * A pan of the canvas, at the same zoom throughout: a smooth zoom would fly
 * out and back in on the way, and names would pass through a size too small
 * to read.
 */
function panOptions() {
  return {
    duration: prefersReducedMotion.value ? 0 : REVEAL_DURATION_MS,
    interpolate: 'linear' as const
  }
}

async function moveTo(target: BracketViewport): Promise<void> {
  noteReaderMove()
  await setViewport(target, panOptions())
}

watch(
  () => viewportHelper.value.viewportInitialized,
  (isInitialized) => {
    if (isInitialized && isFramePending.value) {
      void frameBracket()
    }
  },
  { immediate: true }
)

// Another module, another depth, or the other size of bracket — a phone
// turned, a window narrowed — is a new bracket: framed afresh, whatever the
// reader did to the last one. The frame is owed from the moment it is laid
// out, so the bracket is never drawn saying the last one's frame is its own.
watch(
  [() => props.moduleName, () => props.depth.left, () => props.depth.right, isCompact],
  async ([moduleName], [previousModuleName]) => {
    if (moduleName !== previousModuleName) {
      pointedNodeId.value = null
      focusedNodeId.value = null
      pointedCycleIds.value = []
      pinnedCycleIds.value = []
    }
    oweFrame()
    fitTracker.reset()
    await nextTick()
    void frameBracket()
  }
)

// A resize reframes a frame still owed, or one the reader has not moved away
// from — never a view they panned or zoomed themselves.
const debouncedFrame = useDebounceFn(() => {
  if (isFramePending.value || fitTracker.shouldFitOnResize()) {
    void frameBracket()
  }
}, 200)

useResizeObserver(containerRef, debouncedFrame)

/** What the view leaves out, as chips at the canvas edges that go there. */
const offscreen = computed(() =>
  bracket.value && hasCanvas.value
    ? getBracketOffscreen(bracket.value, viewport.value, canvas.value)
    : null
)

/**
 * A chip at a side edge of the canvas: toward the levels it cuts off — which
 * levels drawn, and how many of their modules — or, where stubs are all it
 * cuts off, toward them, saying what they say; or back to the module, cut off
 * itself. No chip names a level past the depth shown.
 */
type EdgeChip = { edge: BracketSide, kind: 'levels' | 'stubs' | 'middle', text: string, count: string, label: string }

const edgeChips = computed<EdgeChip[]>(() => BRACKET_SIDES.flatMap((edge): EdgeChip[] => {
  const current = offscreen.value
  if (!current) {
    return []
  }

  if (current.middle === edge) {
    return [{ edge, kind: 'middle', text: props.moduleName, count: '', label: `Back to ${props.moduleName}` }]
  }

  const where = edge === 'left'
    ? `of what ${props.moduleName} needs`
    : `of what needs ${props.moduleName}`
  const levels = current.levels[edge]
  if (levels.length === 0) {
    const pastStubs = current.stubModules[edge]
    return pastStubs > 0
      ? [{
          edge,
          kind: 'stubs',
          text: `+${pastStubs} more`,
          count: '',
          label: `Show +${pastStubs} more, one level further out ${where}`
        }]
      : []
  }

  const range = formatLevelRange(levels)
  const modules = current.modules[edge]
  return [{
    edge,
    kind: 'levels',
    text: range,
    count: `${modules} more`,
    label: `Show ${range.toLowerCase()} ${where}: ${pluralize(modules, 'more module')}`
  }]
}))

const verticalChips = computed(() => {
  const current = offscreen.value
  if (!current) {
    return []
  }

  return [
    { direction: 'up' as const, count: current.above },
    { direction: 'down' as const, count: current.below }
  ].filter(chip => chip.count > 0)
})

function followEdgeChip(chip: EdgeChip): void {
  const current = bracket.value
  if (!current) {
    return
  }

  if (chip.kind === 'middle') {
    fitTracker.reset()
    void setViewport(getBracketFrame(current, canvas.value, framing.value), panOptions())
    return
  }

  void moveTo(getLevelRevealViewport(current, viewport.value, canvas.value, chip.edge))
}

function followVerticalChip(direction: 'up' | 'down'): void {
  const current = bracket.value
  if (current) {
    void moveTo(getVerticalRevealViewport(current, viewport.value, canvas.value, direction))
  }
}

/** Cards an edge of the canvas cuts through: drawn back, as what a chip there leads to. */
const cutCardIds = computed(() =>
  bracket.value && hasCanvas.value
    ? getCutCardIds(bracket.value, viewport.value, canvas.value)
    : new Set<string>()
)

const levelHeaders = computed(() =>
  bracket.value && hasCanvas.value
    ? getBracketLevelHeaders(bracket.value, viewport.value, canvas.value)
    : []
)

const isLegendOpen = ref(false)
</script>

<template>
  <div
    class="module-bracket flex h-full min-h-0 flex-col"
    :class="{ 'module-bracket--compact': isCompact }"
    :data-framed="!isFramePending"
  >
    <div class="module-bracket__toolbar">
      <div
        v-for="entry in sides"
        :key="entry.side"
        role="group"
        class="module-bracket__depth"
        :aria-labelledby="`${flowId}-${entry.side}-label`"
      >
        <span
          :id="`${flowId}-${entry.side}-label`"
          class="module-bracket__depth-label"
        >
          <UIcon
            v-if="entry.side === 'left'"
            name="i-lucide-arrow-left"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          {{ entry.label }}
          <UIcon
            v-if="entry.side === 'right'"
            name="i-lucide-arrow-right"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
        </span>
        <span
          class="module-bracket__depth-word"
          aria-hidden="true"
        >Depth</span>
        <div class="module-bracket__stepper">
          <UButton
            icon="i-lucide-minus"
            color="neutral"
            variant="outline"
            size="sm"
            square
            class="module-bracket__step"
            :aria-disabled="entry.canShallow ? undefined : 'true'"
            :aria-label="entry.canShallow ? 'Show one level fewer' : 'Show one level fewer (one level is the fewest)'"
            :title="entry.canShallow ? 'Show one level fewer' : 'One level is the fewest'"
            @click="stepDepth(entry.side, -1, entry.canShallow)"
          />
          <output
            class="module-bracket__depth-value"
            aria-live="polite"
          >
            <!-- The space is the interpolation's own: the compiler drops a
                 whitespace-only text node at the start of an element. -->
            {{ entry.depth }}<span class="sr-only">{{ ` ${entry.depth === 1 ? 'level' : 'levels'}` }}</span>
          </output>
          <UButton
            icon="i-lucide-plus"
            color="neutral"
            variant="outline"
            size="sm"
            square
            class="module-bracket__step"
            :aria-disabled="entry.canDeepen ? undefined : 'true'"
            :aria-label="entry.canDeepen ? 'Show one more level' : 'Show one more level (all levels shown)'"
            :title="entry.canDeepen ? 'Show one more level' : 'All levels shown'"
            @click="stepDepth(entry.side, 1, entry.canDeepen)"
          />
        </div>
        <span class="module-bracket__depth-meta">
          <template v-if="entry.available === 0">
            None
          </template>
          <template v-else>
            max {{ entry.available }} · {{ pluralize(entry.shown, 'module') }}
          </template>
        </span>
      </div>
    </div>

    <div
      ref="containerRef"
      class="module-bracket__canvas"
    >
      <VueFlow
        :id="flowId"
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
            <button
              type="button"
              class="module-bracket__cycle nodrag nopan"
              :class="{
                'module-bracket__cycle--lit': isEdgeLit(edgeProps.data),
                'module-bracket__cycle--dimmed': isEdgeDimmed(edgeProps.data)
              }"
              :style="getCycleLabelStyle(edgeProps.data)"
              :aria-pressed="isCyclePinned(edgeProps.data)"
              :aria-label="`Trace cycle ${formatCircularEdgeLabel(edgeProps.data.cycleIds)}`"
              @mouseenter="pointedCycleIds = edgeProps.data.cycleIds"
              @mouseleave="pointedCycleIds = []"
              @focus="pointedCycleIds = edgeProps.data.cycleIds"
              @blur="pointedCycleIds = []"
              @click="togglePinnedCycle(edgeProps.data)"
            >
              {{ formatCircularEdgeLabel(edgeProps.data.cycleIds) }}
            </button>
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
          <!-- Compact, the card stacks: the name over two lines, its counts
               one to a line, Direct Run at its foot. -->
          <div
            v-if="isCompact"
            class="module-bracket-center module-bracket-center--compact"
          >
            <span
              class="module-bracket-center__name"
              translate="no"
              :title="data.moduleName"
            >
              <template
                v-for="(word, index) in splitNameIntoWords(data.moduleName)"
                :key="index"
              ><wbr v-if="index > 0">{{ word }}</template>
            </span>
            <span
              v-if="data.isRoot || data.isOnCycle"
              class="module-bracket-center__tags"
            >
              <span
                v-if="data.isRoot"
                class="module-bracket-tag"
              >Root</span>
              <span
                v-if="data.isOnCycle"
                class="module-bracket-cycle-mark"
              >
                <UIcon
                  name="i-lucide-repeat-2"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                On a cycle
              </span>
            </span>
            <ul class="module-bracket-center__counts">
              <li>{{ pluralize(data.stats.providers, 'provider') }}</li>
              <li>{{ pluralize(data.stats.controllers, 'controller') }}</li>
              <li>{{ pluralize(data.stats.imports, 'import') }}</li>
              <li>{{ pluralize(data.stats.exports, 'export') }}</li>
            </ul>
            <!-- No icon: its words alone fill the card's width. -->
            <UButton
              v-if="data.stats.runnableNodeIds.length"
              v-bind="directRunLink(data)"
              color="neutral"
              variant="solid"
              block
              class="module-bracket-center__run"
              :aria-label="`Direct Run · ${data.stats.runnableNodeIds.length} runnable`"
            >
              Direct Run
            </UButton>
            <p
              v-else
              class="module-bracket-center__run-none"
            >
              Nothing to run
            </p>
          </div>
          <div
            v-else
            class="module-bracket-center"
          >
            <div class="module-bracket-center__title">
              <UIcon
                name="i-lucide-package"
                class="module-bracket-center__icon"
                aria-hidden="true"
              />
              <span
                class="module-bracket-center__name"
                translate="no"
                :title="data.moduleName"
              >{{ data.moduleName }}</span>
              <span
                v-if="data.isRoot"
                class="module-bracket-tag"
              >Root</span>
              <span
                v-if="data.isOnCycle"
                class="module-bracket-cycle-mark"
              >
                <UIcon
                  name="i-lucide-repeat-2"
                  class="size-4 shrink-0"
                  aria-hidden="true"
                />
                On a cycle
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
            <UButton
              v-if="data.stats.runnableNodeIds.length"
              v-bind="directRunLink(data)"
              color="neutral"
              variant="solid"
              block
              icon="i-lucide-play"
              trailing-icon="i-lucide-arrow-right"
              class="module-bracket-center__run"
            >
              Direct Run
              <span class="module-bracket-center__run-count">· {{ data.stats.runnableNodeIds.length }} runnable</span>
            </UButton>
            <p
              v-else
              class="module-bracket-center__run-none"
            >
              <UIcon
                name="i-lucide-play"
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              Direct Run: nothing to call here
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
          <component
            :is="props.navigation.kind === 'in-place' ? 'button' : NuxtLink"
            v-bind="moduleCardAttrs(data)"
            class="module-bracket-module"
            :class="[`module-bracket-module--${data.side}`, {
              'module-bracket-module--active': activeNodeIds.has(data.id),
              'module-bracket-module--twin-lit': isTwinLit(data),
              'module-bracket-module--cut': cutCardIds.has(data.id)
            }]"
            @mouseenter="pointAt(data)"
            @mouseleave="leave(data)"
            @focus="focusOn(data)"
            @blur="blurFrom(data)"
          >
            <!-- Breaks between its words where a compact card has to. -->
            <span
              class="module-bracket-module__name"
              translate="no"
              :title="data.moduleName"
            >
              <template
                v-for="(word, index) in splitNameIntoWords(data.moduleName)"
                :key="index"
              ><wbr v-if="index > 0">{{ word }}</template>
            </span>
            <!-- Compact, the marks ride the card's top edge, off its name. -->
            <span
              v-if="data.isRoot || data.isOnCycleWithCenter"
              class="module-bracket-module__marks"
            >
              <span
                v-if="data.isRoot"
                class="module-bracket-tag"
              >Root</span>
              <span
                v-if="data.isOnCycleWithCenter"
                class="module-bracket-twin"
                data-cycle-badge
                :title="describeTwin(data)"
              >
                <UIcon
                  name="i-lucide-repeat-2"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span class="module-bracket-twin__text">also {{ data.side === 'left' ? 'right' : 'left' }}</span>
                <span class="sr-only">— {{ describeTwin(data) }}</span>
              </span>
            </span>
          </component>
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
          <!-- An action: one more level of its side, pointing the way it goes. -->
          <button
            type="button"
            class="module-bracket-stub"
            :class="[`module-bracket-stub--${data.side}`, { 'module-bracket-stub--cut': cutCardIds.has(data.id) }]"
            :aria-label="describeStub(data)"
            :title="listStubModules(data)"
            @click="stepDepth(data.side, 1, true)"
          >
            <UIcon
              :name="data.side === 'left' ? 'i-lucide-arrow-left' : 'i-lucide-arrow-right'"
              class="module-bracket-stub__arrow"
              aria-hidden="true"
            />
            +{{ data.moduleCount }} more
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

        <Background />
        <!-- Vue Flow's own buttons are icons with no name; these say what they do. -->
        <Controls
          :show-interactive="false"
          class="module-bracket__controls"
        >
          <template #control-zoom-in>
            <ControlButton
              title="Zoom in"
              aria-label="Zoom in"
              @click="zoomCanvas('in')"
            >
              <UIcon
                name="i-lucide-plus"
                aria-hidden="true"
              />
            </ControlButton>
          </template>
          <template #control-zoom-out>
            <ControlButton
              title="Zoom out"
              aria-label="Zoom out"
              @click="zoomCanvas('out')"
            >
              <UIcon
                name="i-lucide-minus"
                aria-hidden="true"
              />
            </ControlButton>
          </template>
          <template #control-fit-view>
            <ControlButton
              title="Show the whole bracket"
              aria-label="Show the whole bracket"
              @click="showWholeBracket"
            >
              <UIcon
                name="i-lucide-maximize"
                aria-hidden="true"
              />
            </ControlButton>
          </template>
          <ControlButton
            :title="`Back to ${props.moduleName}`"
            :aria-label="`Back to ${props.moduleName}`"
            @click="recentre"
          >
            <UIcon
              name="i-lucide-locate-fixed"
              aria-hidden="true"
            />
          </ControlButton>
        </Controls>
      </VueFlow>

      <!-- Each column's heading, pinned across the top: read at one size
           whatever the zoom, and in view however far the canvas is panned. -->
      <div
        v-if="levelHeaders.length > 0"
        class="module-bracket__headings"
      >
        <p
          v-for="header in levelHeaders"
          :key="header.id"
          class="module-bracket__heading"
          data-bracket-node="level"
          :data-side="header.side"
          :data-level="header.level"
          :style="{ left: `${header.left}px`, width: `${header.width}px` }"
          :title="`Level ${header.level} · ${pluralize(header.moduleCount, 'module')}`"
        >
          Level {{ header.level }}
          <!-- A compact column is too narrow for its count: read out, not shown. -->
          <span
            class="module-bracket__heading-count"
            :class="{ 'sr-only': isCompact }"
          >· {{ pluralize(header.moduleCount, 'module') }}</span>
        </p>
      </div>

      <button
        v-for="chip in edgeChips"
        :key="`${chip.edge}-${chip.kind}`"
        type="button"
        class="module-bracket__chip"
        :class="`module-bracket__chip--${chip.edge}`"
        :aria-label="chip.label"
        :data-chip="chip.kind"
        :data-side="chip.edge"
        @click="followEdgeChip(chip)"
      >
        <UIcon
          v-if="chip.edge === 'left'"
          name="i-lucide-arrow-left"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        <!-- Which levels, and how many modules: mirrored on the right, and
             over two lines on a compact canvas. -->
        <span
          class="module-bracket__chip-text"
          :translate="chip.kind === 'middle' ? 'no' : undefined"
        >
          <span class="module-bracket__chip-range">{{ chip.text }}</span>
          <span
            v-if="chip.count"
            class="module-bracket__chip-count"
          >{{ chip.count }}</span>
        </span>
        <UIcon
          v-if="chip.edge === 'right'"
          name="i-lucide-arrow-right"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
      </button>

      <button
        v-for="chip in verticalChips"
        :key="chip.direction"
        type="button"
        class="module-bracket__chip"
        :class="`module-bracket__chip--${chip.direction}`"
        :data-chip="chip.direction"
        @click="followVerticalChip(chip.direction)"
      >
        <UIcon
          :name="chip.direction === 'up' ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down'"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        {{ chip.count }} more {{ chip.count === 1 ? 'module' : 'modules' }}
      </button>
    </div>

    <footer
      class="module-bracket__legend"
      aria-label="Legend"
    >
      <button
        v-if="isCompact"
        type="button"
        class="module-bracket__legend-toggle"
        :aria-expanded="isLegendOpen"
        :aria-controls="`${flowId}-legend`"
        @click="isLegendOpen = !isLegendOpen"
      >
        <UIcon
          name="i-lucide-info"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        Key
        <UIcon
          :name="isLegendOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
      </button>
      <ul
        v-show="!isCompact || isLegendOpen"
        :id="`${flowId}-legend`"
        class="module-bracket__legend-items"
      >
        <li class="module-bracket__legend-item">
          <span
            class="module-bracket__line"
            aria-hidden="true"
          />
          Import, pointing at the module importing
        </li>
        <li
          v-if="hasCircularEdges"
          class="module-bracket__legend-item"
        >
          <span
            class="module-bracket__line module-bracket__line--circular"
            aria-hidden="true"
          />
          Import on a cycle
          <span
            class="module-bracket__cycle module-bracket__cycle--sample"
            aria-hidden="true"
          >#1</span>
          — point at its number to trace it
        </li>
        <li
          v-if="hasTwins"
          class="module-bracket__legend-item"
        >
          <span
            class="module-bracket-twin"
            aria-hidden="true"
          >
            <UIcon
              name="i-lucide-repeat-2"
              class="size-3.5 shrink-0"
            />
            also right
          </span>
          On both sides: needs <span translate="no">{{ props.moduleName }}</span> and is needed by it
        </li>
        <li
          v-if="hasStubs"
          class="module-bracket__legend-item"
        >
          <span
            class="module-bracket__legend-stub"
            aria-hidden="true"
          >+N more</span>
          One level further: select to show it
        </li>
        <li
          v-if="hasLinks"
          class="module-bracket__legend-item"
        >
          <span
            class="module-bracket__line module-bracket__line--link"
            aria-hidden="true"
          />
          Other imports between modules drawn: point at a module
        </li>
      </ul>
      <USwitch
        v-if="hasLinks"
        v-model="showAllImports"
        label="Show all imports"
        size="sm"
        class="module-bracket__legend-switch"
      />
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
 * A cycle wears one colour everywhere on the page: its connectors in
 * --mg-edge-circular, its labels and marks as a pale tint of it with ink of
 * the same hue.
 */
.module-bracket {
  --mg-subgraph-border: #c4c4c4;
  --mg-edge-module: #0284c7;
  --mg-edge-circular: #d97706;
  --bracket-cycle-ink: #92400e;
  --bracket-cycle-tint: #fef3c7;
  --bracket-cycle-edge: #f59e0b;
  /* A stub wears the imports' own colour: a pale tint of it, ink of its hue. */
  --bracket-stub-ink: #075985;
  --bracket-stub-tint: color-mix(in srgb, var(--mg-edge-module) 10%, var(--ui-bg));
  --bracket-stub-tint-pointed: color-mix(in srgb, var(--mg-edge-module) 20%, var(--ui-bg));
}

.dark .module-bracket {
  --mg-subgraph-border: #4a5568;
  --mg-edge-module: #38bdf8;
  --mg-edge-circular: #facc15;
  --bracket-cycle-ink: #fde68a;
  --bracket-cycle-tint: rgb(250 204 21 / 0.14);
  --bracket-cycle-edge: rgb(250 204 21 / 0.55);
  --bracket-stub-ink: #bae6fd;
}

/*
 * The two sides' depths, each at its own end of the bar as each side stands
 * at its own end of the bracket, and in the same words in the same order:
 * which side, its depth, then how far it goes.
 */
.module-bracket__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 24px;
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

.module-bracket__depth-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-text-highlighted);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.module-bracket__depth-word {
  color: var(--ui-text-toned);
  font-size: 13px;
}

.module-bracket__depth-word::before,
.module-bracket__depth-meta::before {
  content: "·";
  margin-right: 8px;
  color: var(--ui-text-toned);
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

/* A step that cannot be taken looks it, and says why when pointed at. */
.module-bracket__step[aria-disabled="true"] {
  opacity: 0.4;
  cursor: not-allowed;
}

.module-bracket__step[aria-disabled="true"]:hover {
  background: transparent;
}

.module-bracket__depth-meta {
  color: var(--ui-text-toned);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* On a phone each side takes a row of its own, its steppers 40px targets. */
@media (max-width: 639.98px) {
  .module-bracket__toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    padding: 6px 16px;
  }

  /* One width for both labels, so the two rows' steppers line up. */
  .module-bracket__depth-label {
    width: 108px;
  }

  .module-bracket__depth-word {
    display: none;
  }

  .module-bracket__step {
    width: 40px;
    height: 40px;
    justify-content: center;
  }

  .module-bracket__depth-meta {
    margin-left: auto;
  }

  .module-bracket__depth-meta::before {
    content: none;
  }
}

/*
 * The canvas keeps the page's 16px margin, so a card cut off at its edge — and
 * its name — never runs into the window's edge, and the canvas shares one left
 * and one right edge with the toolbar above it and the legend below. A host
 * that frames the bracket itself inside the page's own margin — the landing
 * page's bordered panel, on a phone — sets --module-bracket-inset to 0: its
 * frame is that edge, and the canvas keeps the width the first levels need.
 */
.module-bracket__canvas {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  margin: 0 var(--module-bracket-inset, 16px);
  overflow: hidden;
}

/*
 * Vue Flow lets a node take the pointer only when it can be selected or
 * dragged, or something listens for clicks on it — none of which a bracket
 * node is — and sets `pointer-events: none` on it inline otherwise. These hold
 * links and buttons of their own; a press that moves still pans the canvas,
 * which swallows the click.
 */
.module-bracket__flow :deep(.vue-flow__node) {
  cursor: default;
  pointer-events: all !important;
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

/* Links are drawn on demand, and kept back behind the bracket when they are. */
.module-bracket__flow :deep(.bracket-edge--link:not(.bracket-edge--lit) .vue-flow__edge-path) {
  opacity: 0.75;
}

/* Tracing a cycle: its connectors stand out, the rest steps back. */
.module-bracket__flow :deep(.bracket-edge--dimmed .vue-flow__edge-path) {
  opacity: 0.2;
}

/*
 * The zoom controls as touch targets on a phone or any touch screen, in a row
 * along the canvas foot rather than a column up its side, over the module's
 * card.
 */
@media (pointer: coarse), (max-width: 639.98px) {
  .module-bracket__flow :deep(.vue-flow__controls) {
    display: flex;
    flex-direction: row;
  }

  .module-bracket__flow :deep(.vue-flow__controls-button) {
    width: 40px;
    height: 40px;
  }

  .module-bracket__flow :deep(.vue-flow__controls-button svg) {
    max-width: 16px;
    max-height: 16px;
  }
}

/* The module the page is about: the largest card, framed in ink. */
.module-bracket-center {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  padding: 16px;
  border: 2px solid var(--ui-border-inverted);
  border-radius: 12px;
  background: var(--ui-bg);
  box-sizing: border-box;
}

.module-bracket-center__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.module-bracket-center__icon {
  width: 20px;
  height: 20px;
  flex: none;
  color: var(--ui-text-muted);
}

.module-bracket-center__name {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  color: var(--ui-text-highlighted);
  font-size: 18px;
  font-weight: 700;
  line-height: 26px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bracket-center__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
  padding: 10px 0;
  border-block: 1px solid var(--ui-border);
}

.module-bracket-center__stats > div + div {
  padding-left: 10px;
  border-left: 1px solid var(--ui-border);
}

.module-bracket-center__stats dt {
  overflow: hidden;
  color: var(--ui-text-toned);
  font-size: 12px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bracket-center__stats dd {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 28px;
}

.module-bracket-center__run {
  min-height: 46px;
  justify-content: center;
  font-size: 15px;
  font-weight: 600;
}

.module-bracket-center__run-count {
  font-weight: 500;
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}

.module-bracket-center__run-none {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 46px;
  margin: 0;
  border: 1px dashed var(--ui-border-accented);
  border-radius: 8px;
  color: var(--ui-text-toned);
  font-size: 14px;
}

/* Every other module: its name on a card drawn as the navigator draws a module. */
.module-bracket-module {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 0 12px;
  border: 1.5px solid var(--mg-subgraph-border);
  border-radius: 8px;
  background: var(--ui-bg);
  box-sizing: border-box;
  color: var(--ui-text-highlighted);
  font-size: 14px;
  font-weight: 600;
  /* A card kept in place is a button, which would centre its name. */
  text-align: start;
  text-decoration: none;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease,
    opacity 120ms ease;
}

.module-bracket-module:hover,
.module-bracket-module--active {
  border-color: var(--ui-border-inverted);
}

.module-bracket-module:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

/*
 * A card the canvas edge cuts through steps back: part of the levels the chip
 * at that edge leads to, not one the frame is about. Pointed at, or reached by
 * the keyboard, it comes forward again.
 */
.module-bracket-module--cut,
.module-bracket-stub--cut {
  opacity: 0.45;
}

.module-bracket-module--cut:hover,
.module-bracket-module--cut:focus-visible,
.module-bracket-stub--cut:hover,
.module-bracket-stub--cut:focus-visible {
  opacity: 1;
}

/* The same module's card on the other side, lit while either is pointed at. */
.module-bracket-module--twin-lit {
  border-color: var(--mg-edge-circular);
  /* A 1px inner ring thickens the border while lit without moving the card's
     text, and leaves the outline to the focus ring: a state, not a shadow. */
  box-shadow: inset 0 0 0 1px var(--mg-edge-circular); /* taste-skill-ignore */
}

.module-bracket-module__name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The bracket mirrors: on the left a card's name sits at its end nearer the
 * middle, as on the right, where the connectors into the middle start — and
 * where a card cut off by the canvas edge still shows it.
 */
.module-bracket-module--left {
  flex-direction: row-reverse;
}

.module-bracket-module--left .module-bracket-module__name {
  text-align: right;
}

/* A card's marks stand beside its name, as items of the card itself. */
.module-bracket-module__marks {
  display: contents;
}

/* The root module is a fact, not a warning: a neutral tag. */
.module-bracket-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-toned);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

/* A module on both sides: in the cycle's ink, naming the other side. */
.module-bracket-twin,
.module-bracket-cycle-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  color: var(--bracket-cycle-ink);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.module-bracket-cycle-mark {
  margin-left: auto;
  font-size: 13px;
}

/*
 * Where a branch goes on: a button asking for one more level, in the imports'
 * own colour — filled, bordered, its arrow pointing the way the side goes —
 * so it reads as something to press, not a slot left empty.
 */
.module-bracket-stub {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 100%;
  border: 1.5px solid var(--mg-edge-module);
  border-radius: 8px;
  background: var(--bracket-stub-tint);
  color: var(--bracket-stub-ink);
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    opacity 120ms ease;
}

.module-bracket-stub--right {
  flex-direction: row-reverse;
}

.module-bracket-stub__arrow {
  width: 16px;
  height: 16px;
  flex: none;
}

.module-bracket-stub:hover,
.module-bracket-stub:focus-visible {
  background: var(--bracket-stub-tint-pointed);
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
  color: var(--ui-text-toned);
  font-size: 14px;
  text-align: center;
}

/* A cycle's number on its connector: press it to keep the cycle traced. */
/* 22px tall, as `labelHeight` in `utils/module-dependency-bracket.ts` keeps it clear. */
.module-bracket__cycle {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--bracket-cycle-edge);
  border-radius: 999px;
  background: var(--bracket-cycle-tint);
  color: var(--bracket-cycle-ink);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: all;
  transition: opacity 120ms ease;
}

.module-bracket__cycle:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.module-bracket__cycle--lit,
.module-bracket__cycle[aria-pressed="true"] {
  border-color: var(--mg-edge-circular);
  /* The same inner ring as a lit card: a state, not a shadow. */
  box-shadow: inset 0 0 0 1px var(--mg-edge-circular); /* taste-skill-ignore */
}

.module-bracket__cycle--dimmed {
  opacity: 0.35;
}

.module-bracket__cycle--sample {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  cursor: default;
  pointer-events: none;
}

/* Column headings, pinned across the top of the canvas. */
.module-bracket__headings {
  position: absolute;
  inset: 0 0 auto;
  z-index: 5;
  height: 32px;
  overflow: hidden;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
  pointer-events: none;
}

.module-bracket__heading {
  position: absolute;
  top: 0;
  display: block;
  height: 32px;
  margin: 0;
  overflow: hidden;
  color: var(--ui-text-highlighted);
  font-size: 13px;
  font-weight: 600;
  line-height: 32px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-bracket__heading-count {
  color: var(--ui-text-toned);
  font-weight: 500;
}

/* Mirrored like the cards below it: read from the end nearer the middle. */
.module-bracket__heading[data-side="left"] {
  text-align: right;
}

/* Chips at the canvas edges, toward what the view cuts off. */
.module-bracket__chip {
  position: absolute;
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(50% - 24px);
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color 120ms ease;
}

.module-bracket__chip:hover {
  background: var(--ui-bg-elevated);
}

.module-bracket__chip:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

/* Which levels, then how many modules — mirrored on the right: "2 more · Levels 2–3". */
.module-bracket__chip-text {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.module-bracket__chip-range,
.module-bracket__chip-count {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.module-bracket__chip-count {
  color: var(--ui-text-toned);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.module-bracket__chip--left .module-bracket__chip-count::before {
  content: "·";
  margin-right: 6px;
}

.module-bracket__chip--right .module-bracket__chip-text {
  flex-direction: row-reverse;
}

.module-bracket__chip--right .module-bracket__chip-count::after {
  content: "·";
  margin-left: 6px;
}

/*
 * The chips toward each side's hidden levels stand at the top of the canvas,
 * under the headings, where they cover no card the bracket is framed on.
 */
.module-bracket__chip--left,
.module-bracket__chip--right {
  top: 44px;
}

.module-bracket__chip--left {
  left: 12px;
}

.module-bracket__chip--right {
  right: 12px;
}

.module-bracket__chip--up,
.module-bracket__chip--down {
  left: 50%;
  transform: translateX(-50%);
}

.module-bracket__chip--up {
  top: 44px;
}

.module-bracket__chip--down {
  bottom: 12px;
}

@media (pointer: coarse), (max-width: 639.98px) {
  .module-bracket__chip {
    height: 40px;
    padding: 0 14px;
  }
}

/* A phone has room for the two side chips across the top, and no more. */
@media (max-width: 639.98px) {
  .module-bracket__chip--up {
    top: 96px;
  }

  .module-bracket__chip--down {
    right: 12px;
    left: auto;
    transform: none;
  }
}

.module-bracket__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text-toned);
  font-size: 12px;
}

.module-bracket__legend-items {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.module-bracket__legend-item {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.module-bracket__legend-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 4px;
  color: var(--ui-text-highlighted);
  font-size: 14px;
  font-weight: 600;
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
  padding: 0 5px;
  border: 1px solid var(--mg-edge-module);
  border-radius: 4px;
  background: var(--bracket-stub-tint);
  color: var(--bracket-stub-ink);
  font-weight: 600;
}

/*
 * Compact — on a phone, or in a column as narrow — the key folds behind a
 * toggle, the switch beside it, so its rows never take the canvas's height.
 */
.module-bracket--compact .module-bracket__legend {
  padding: 4px 16px;
}

.module-bracket--compact .module-bracket__legend-items {
  order: 3;
  flex-basis: 100%;
  padding-bottom: 6px;
}

/*
 * Compact: the bracket a phone opens on, the module and the first level of
 * each side across it at a size their names read at. Names wrap over two
 * lines between their words, set at 11.5px — 11px drawn at the zoom that
 * fits — and nothing on the canvas is set smaller than 11px.
 */
.module-bracket--compact .module-bracket-module {
  position: relative;
  gap: 0;
  padding: 0 2px;
  border-width: 1px;
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 14px;
}

.module-bracket--compact .module-bracket-module__name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  white-space: normal;
}

/* The marks ride the card's top edge, at its end nearer the middle. */
.module-bracket--compact .module-bracket-module__marks {
  position: absolute;
  top: -9px;
  display: flex;
  gap: 3px;
}

.module-bracket--compact .module-bracket-module--left .module-bracket-module__marks {
  right: 6px;
}

.module-bracket--compact .module-bracket-module--right .module-bracket-module__marks {
  left: 6px;
}

.module-bracket--compact .module-bracket-tag {
  height: 18px;
  padding: 0 5px;
  font-size: 11px;
}

/* On both sides: the cycle's mark alone, its words read out and in the key. */
.module-bracket--compact .module-bracket-twin {
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--bracket-cycle-edge);
  border-radius: 999px;
  background: var(--bracket-cycle-tint);
}

.module-bracket--compact .module-bracket-module .module-bracket-twin__text {
  display: none;
}

.module-bracket--compact .module-bracket-stub {
  gap: 3px;
  border-radius: 6px;
  font-size: 12px;
}

.module-bracket--compact .module-bracket-stub__arrow {
  width: 14px;
  height: 14px;
}

.module-bracket--compact .module-bracket-empty {
  padding: 0 6px;
  font-size: 12px;
  line-height: 15px;
}

/* The module in the middle stacks: name, marks, counts, Direct Run. */
.module-bracket-center--compact {
  gap: 5px;
  padding: 8px 7px;
  border-radius: 10px;
}

.module-bracket-center--compact .module-bracket-center__name {
  display: -webkit-box;
  flex: none;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 13px;
  line-height: 16px;
  overflow-wrap: anywhere;
  white-space: normal;
}

.module-bracket-center__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.module-bracket-center--compact .module-bracket-cycle-mark {
  margin-left: 0;
  font-size: 11.5px;
}

.module-bracket-center__counts {
  margin: 0;
  padding: 6px 0 0;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text-highlighted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 14px;
  list-style: none;
}

.module-bracket-center--compact .module-bracket-center__run,
.module-bracket-center--compact .module-bracket-center__run-none {
  min-height: 36px;
  margin-top: auto;
  padding: 0 6px;
  font-size: 12px;
}

/* 20px tall, as the compact `labelHeight` keeps it clear. */
.module-bracket--compact .module-bracket__cycle {
  height: 20px;
  padding: 0 4px;
  font-size: 11px;
}

/* A chip's levels over its count, two short lines rather than one cut off. */
.module-bracket--compact .module-bracket__chip {
  height: auto;
  min-height: 40px;
  padding: 3px 12px;
}

.module-bracket--compact .module-bracket__chip-text,
.module-bracket--compact .module-bracket__chip--right .module-bracket__chip-text {
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  line-height: 16px;
}

.module-bracket--compact .module-bracket__chip--right .module-bracket__chip-text {
  align-items: flex-end;
}

.module-bracket--compact .module-bracket__chip-count {
  font-size: 12px;
}

.module-bracket--compact .module-bracket__chip-count::before,
.module-bracket--compact .module-bracket__chip-count::after {
  content: none;
}

@media (prefers-reduced-motion: reduce) {
  .module-bracket-module,
  .module-bracket-stub,
  .module-bracket__cycle,
  .module-bracket__chip {
    transition: none;
  }
}
</style>
