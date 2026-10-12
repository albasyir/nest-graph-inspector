/**
 * One module's own wiring, laid out for the deep-dive page.
 *
 * The navigator draws every module at once, so inside any one of them the
 * question "what does this module need, and from where" is answered by
 * tracing lines across the whole canvas. The deep dive answers it for one
 * module: its providers and controllers, and every dependency it reaches
 * outside itself as a node of its own, laid out so a dependency always sits to
 * the left of whatever injects it.
 *
 * Pure data in, pure data out — the component only renders what this returns.
 */
import type {
  GraphOutput,
  GraphOutputCycles,
  GraphOutputDependencyRef,
  GraphOutputModule
} from 'nest-graph-inspector'
import {
  formatCircularEdgeLabel,
  getCircularEdgeBounds,
  getCircularEdgeGeometry,
  getCircularLabelScale,
  unionRects,
  type CircularEdgeRect
} from './circular-dependency-edge.ts'
import { getDirectRunNodeId } from './direct-run-provider.ts'

export type ModuleDeepDiveItemKind = 'provider' | 'controller'

/** A provider or controller declared in the module itself. */
export type ModuleDeepDiveItemNode = {
  id: string
  type: 'item'
  kind: ModuleDeepDiveItemKind
  label: string
  /** The module being inspected; it declares every item node. */
  moduleName: string
  isExported: boolean
  jsdoc?: string
  /** Whether the graph advertises any method Direct Run may call. */
  isRunnable: boolean
  position: { x: number, y: number }
}

/** A token the module injects but does not declare, and who provides it. */
export type ModuleDeepDiveExternalNode = {
  id: string
  type: 'external'
  label: string
  /** The module the dependency is provided by. */
  moduleName: string
  position: { x: number, y: number }
}

export type ModuleDeepDiveNode = ModuleDeepDiveItemNode | ModuleDeepDiveExternalNode

/**
 * What an edge draws: a provider injected into a provider, anything injected
 * into a controller, or a dependency reaching outside the module. An external
 * dependency is `external` whatever injects it — where it comes from is the
 * point of the page.
 */
export type ModuleDeepDiveEdgeKind = 'provider' | 'controller' | 'external'

/** From the dependency to whatever injects it, as the navigator draws them. */
export type ModuleDeepDiveEdge = {
  id: string
  source: string
  target: string
  kind: ModuleDeepDiveEdgeKind
  /**
   * The ids of the graph's reported cycles this injection is a step of,
   * ascending; empty for an edge on no cycle. An item injecting itself is the
   * one step of its own cycle, drawn with the same node at both ends.
   */
  cycleIds: number[]
}

/** A class a cycle passes through, by the module that declares it. */
export type DependencyCycleNode = {
  moduleName: string
  name: string
}

/** One injection a reported cycle runs through: `dependent` injects `dependency`. */
export type DependencyCycleStep = {
  cycleId: number
  dependent: DependencyCycleNode
  dependency: DependencyCycleNode
}

export type ModuleDeepDiveStats = {
  imports: number
  exports: number
  providers: number
  controllers: number
  /** Distinct injections of one of the module's items into another. */
  internalDependencies: number
  /** Distinct tokens the module injects from somewhere else. */
  externalDependencies: number
}

export type ModuleDeepDive = {
  nodes: ModuleDeepDiveNode[]
  edges: ModuleDeepDiveEdge[]
  stats: ModuleDeepDiveStats
}

export const DEEP_DIVE_ITEM_WIDTH = 220
export const DEEP_DIVE_ITEM_HEIGHT = 36
export const DEEP_DIVE_EXTERNAL_HEIGHT = 52
const COLUMN_GAP = 120
const ROW_GAP = 20

/**
 * The deep dive of `moduleName`, or `null` when the graph has no such module.
 *
 * A dependency is internal only when it resolves to an item the module itself
 * declares. Anything else — another module's export, a NestJS core token, or a
 * token the library attributed to this module but that no item here declares —
 * is drawn as an external node, so nothing the module injects goes missing.
 *
 * Each edge carries the reported cycles it is a step of, read from the graph's
 * own `cycles` rather than guessed from the layout. Cycles only mark edges the
 * module's own injections already draw — one passing through another module
 * marks the injection that reaches this one — and never add an edge.
 */
export function buildModuleDeepDive(
  graph: Pick<GraphOutput, 'modules'> & Partial<Pick<GraphOutput, 'cycles'>>,
  moduleName: string
): ModuleDeepDive | null {
  if (!Object.hasOwn(graph.modules, moduleName)) {
    return null
  }

  const mod = graph.modules[moduleName] as GraphOutputModule
  const providerIds = new Map(
    mod.providers.map(provider => [
      provider.name,
      getDirectRunNodeId('provider', moduleName, provider.name)
    ])
  )
  const controllerIds = new Map(
    mod.controllers.map(controller => [
      controller.name,
      getDirectRunNodeId('controller', moduleName, controller.name)
    ])
  )

  function resolveInternalId(dep: GraphOutputDependencyRef): string | null {
    if (dep.providedBy.name !== moduleName) {
      return null
    }

    return providerIds.get(dep.token) ?? controllerIds.get(dep.token) ?? null
  }

  const externals = new Map<string, ModuleDeepDiveExternalNode>()
  const edges = new Map<string, ModuleDeepDiveEdge>()
  // Each injection, keyed as a cycle step names it → the edge drawing it.
  const edgeIdByInjection = new Map<string, string>()
  // Provider id → the internal providers it injects, for its column.
  const providerDependencies = new Map<string, string[]>()

  const items = [
    ...mod.providers.map(provider => ({
      kind: 'provider' as const,
      entry: provider,
      id: providerIds.get(provider.name) as string
    })),
    ...mod.controllers.map(controller => ({
      kind: 'controller' as const,
      entry: controller,
      id: controllerIds.get(controller.name) as string
    }))
  ]

  for (const { kind, entry, id } of items) {
    const internalDependencies: string[] = []

    for (const dep of entry.dependencies) {
      const internalId = resolveInternalId(dep)
      let edgeId: string

      if (internalId) {
        internalDependencies.push(internalId)
        edgeId = addEdge(edges, internalId, id, kind === 'controller' ? 'controller' : 'provider')
      } else {
        const externalId = getExternalNodeId(dep.providedBy.name, dep.token)
        if (!externals.has(externalId)) {
          externals.set(externalId, {
            id: externalId,
            type: 'external',
            label: dep.token,
            moduleName: dep.providedBy.name,
            position: { x: 0, y: 0 }
          })
        }
        edgeId = addEdge(edges, externalId, id, 'external')
      }

      edgeIdByInjection.set(
        getInjectionKey(
          { moduleName, name: entry.name },
          { moduleName: dep.providedBy.name, name: dep.token }
        ),
        edgeId
      )
    }

    if (kind === 'provider') {
      providerDependencies.set(
        id,
        internalDependencies.filter(dependencyId => dependencyId.startsWith('provider-'))
      )
    }
  }

  const providerLevels = resolveDependencyLevels(
    [...providerIds.values()],
    providerDependencies
  )
  const providerColumnCount = Math.max(-1, ...providerLevels.values()) + 1

  // External dependencies first, providers by how deep they inject one
  // another, controllers last — then empty columns are closed up, so a module
  // with no external dependencies does not start with a gap.
  const sortedExternals = [...externals.values()].sort(
    (left, right) =>
      left.moduleName.localeCompare(right.moduleName)
      || left.label.localeCompare(right.label)
  )
  const columns: ModuleDeepDiveNode[][] = [
    sortedExternals,
    ...Array.from({ length: providerColumnCount }, () => [] as ModuleDeepDiveNode[]),
    []
  ]

  for (const { kind, entry, id } of items) {
    const node: ModuleDeepDiveItemNode = {
      id,
      type: 'item',
      kind,
      label: entry.name,
      moduleName,
      isExported: mod.exports.includes(entry.name),
      jsdoc: entry.jsdoc,
      isRunnable: Boolean(entry.directRun?.methods?.length),
      position: { x: 0, y: 0 }
    }

    const column = kind === 'provider'
      ? 1 + (providerLevels.get(id) ?? 0)
      : columns.length - 1
    columns[column]?.push(node)
  }

  const nodes: ModuleDeepDiveNode[] = []
  const filledColumns = columns.filter(column => column.length > 0)

  for (const [columnIndex, column] of filledColumns.entries()) {
    const step = getNodeHeight(column[0] as ModuleDeepDiveNode) + ROW_GAP
    const top = -((column.length - 1) * step) / 2

    for (const [rowIndex, node] of column.entries()) {
      node.position = {
        x: columnIndex * (DEEP_DIVE_ITEM_WIDTH + COLUMN_GAP),
        y: top + rowIndex * step
      }
      nodes.push(node)
    }
  }

  for (const step of getDependencyCycleSteps(graph.cycles)) {
    const edge = edges.get(
      edgeIdByInjection.get(getInjectionKey(step.dependent, step.dependency)) ?? ''
    )
    if (edge && !edge.cycleIds.includes(step.cycleId)) {
      edge.cycleIds.push(step.cycleId)
    }
  }

  const edgeList = [...edges.values()]
  for (const edge of edgeList) {
    edge.cycleIds.sort((left, right) => left - right)
  }

  return {
    nodes,
    edges: edgeList,
    stats: {
      imports: mod.imports.length,
      exports: mod.exports.length,
      providers: mod.providers.length,
      controllers: mod.controllers.length,
      internalDependencies: edgeList.filter(edge => edge.kind !== 'external').length,
      externalDependencies: externals.size
    }
  }
}

/**
 * The box the canvas has to show for everything in a deep dive to be seen, in
 * flow coordinates, or `null` for a module with nothing to draw.
 *
 * Fitting the view to the nodes alone cuts off what a cycle draws outside
 * them — the curve that doubles back below the columns, the gentle bow above
 * them, a self-loop beside its node — and the cycle labels on those curves,
 * leaving them under the page header or past the canvas edge. So the box
 * holds every node and, for every cycle edge and self-loop, its curve and its
 * label at `labelScale`, the size labels are enlarged to at the fitted zoom.
 * Edges run from a node's right side into another's left, as the deep dive's
 * handles do.
 */
export function getModuleDeepDiveBounds(
  deepDive: Pick<ModuleDeepDive, 'nodes' | 'edges'>,
  labelScale = 1
): CircularEdgeRect | null {
  const nodeById = new Map(deepDive.nodes.map(node => [node.id, node]))
  const rects: CircularEdgeRect[] = deepDive.nodes.map(node => ({
    x: node.position.x,
    y: node.position.y,
    width: DEEP_DIVE_ITEM_WIDTH,
    height: getNodeHeight(node)
  }))

  for (const edge of deepDive.edges) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    const isSelfLoop = edge.source === edge.target
    if (!source || !target || (edge.cycleIds.length === 0 && !isSelfLoop)) {
      continue
    }

    const geometry = getCircularEdgeGeometry({
      sourceX: source.position.x + DEEP_DIVE_ITEM_WIDTH,
      sourceY: source.position.y + getNodeHeight(source) / 2,
      sourcePosition: 'right',
      targetX: target.position.x,
      targetY: target.position.y + getNodeHeight(target) / 2,
      targetPosition: 'left',
      isSelfLoop
    })
    rects.push(getCircularEdgeBounds(
      geometry,
      formatCircularEdgeLabel(edge.cycleIds),
      labelScale
    ))
  }

  return unionRects(rects)
}

/** The canvas a deep dive is fitted to: Vue Flow's `fitBounds`, and its zoom. */
export type ModuleDeepDiveViewport = {
  /** Resolves `false` when nothing moved — Vue Flow's answer before it is ready. */
  fitBounds: (bounds: CircularEdgeRect) => Promise<boolean>
  getZoom: () => number
  /**
   * Whether this fit is still the latest one asked for. A fit superseded by a
   * newer one stops, so two never take turns moving the canvas.
   */
  isCurrent?: () => boolean
}

/**
 * When the deep dive may be reframed, and which fit is the latest.
 *
 * A first frame — a module's nodes measured, its viewport ready — is always
 * made. A resize afterwards reframes only while the reader has left the
 * canvas where the fit put it: once they pan or zoom, opening the JSDoc or
 * turning a phone must not throw their view away. Opening another module, or
 * asking for a fit, starts over.
 */
export type DeepDiveFitTracker = {
  /** A fit is starting; the returned check says whether it is still the latest. */
  begin: () => () => boolean
  /** The reader moved the canvas themselves. */
  noteReaderMove: () => void
  /** A new module, or a fit the reader asked for: resizes reframe again. */
  reset: () => void
  /** Whether a resize should reframe the deep dive. */
  shouldFitOnResize: () => boolean
}

export function createDeepDiveFitTracker(): DeepDiveFitTracker {
  let latestFit = 0
  let hasReaderMoved = false

  return {
    begin: () => {
      latestFit += 1
      const fit = latestFit
      return () => fit === latestFit
    },
    noteReaderMove: () => {
      hasReaderMoved = true
    },
    reset: () => {
      hasReaderMoved = false
    },
    shouldFitOnResize: () => !hasReaderMoved
  }
}

/** Fits a label scale settles in: each fit can zoom out and enlarge labels. */
const DEEP_DIVE_FIT_MAX_PASSES = 3

/**
 * Frames a deep dive with its cycle curves and labels, and says whether the
 * canvas took the fit.
 *
 * Labels are enlarged as the canvas zooms out, so the box is refitted with the
 * scale the last fit left, until the scale holds. `false` means the viewport
 * refused — Vue Flow's `fitBounds` is a no-op answering `false` until its
 * zoom handler and pane size exist — and the caller should fit again once it
 * is ready, rather than leave the canvas at its default viewport with the top
 * of the graph above it. A deep dive with nothing to draw needs no fit, and a
 * fit superseded by a newer one stops without moving the canvas again — the
 * newer fit owes whatever is left.
 */
export async function fitModuleDeepDive(
  deepDive: Pick<ModuleDeepDive, 'nodes' | 'edges'>,
  viewport: ModuleDeepDiveViewport
): Promise<boolean> {
  const isCurrent = viewport.isCurrent ?? (() => true)
  let labelScale = 1

  for (let pass = 0; pass < DEEP_DIVE_FIT_MAX_PASSES; pass += 1) {
    const bounds = getModuleDeepDiveBounds(deepDive, labelScale)
    if (!bounds || !isCurrent()) {
      return true
    }

    if (!await viewport.fitBounds(bounds)) {
      return false
    }
    if (!isCurrent()) {
      return true
    }

    const nextScale = getCircularLabelScale(viewport.getZoom())
    if (nextScale <= labelScale) {
      return true
    }
    labelScale = nextScale
  }

  return true
}

/** The node height a layout column is spaced by. */
export function getNodeHeight(node: Pick<ModuleDeepDiveNode, 'type'>): number {
  return node.type === 'external' ? DEEP_DIVE_EXTERNAL_HEIGHT : DEEP_DIVE_ITEM_HEIGHT
}

/**
 * An external node's id. JSON rather than a joined string: module and token
 * names may both contain `-`, and `A-B` + `C` must not meet `A` + `B-C`.
 */
function getExternalNodeId(moduleName: string, token: string): string {
  return `external:${JSON.stringify([moduleName, token])}`
}

/** Adds the edge once, however many injections it draws, and returns its id. */
function addEdge(
  edges: Map<string, ModuleDeepDiveEdge>,
  source: string,
  target: string,
  kind: ModuleDeepDiveEdgeKind
): string {
  const id = JSON.stringify([source, target])
  if (!edges.has(id)) {
    edges.set(id, { id, source, target, kind, cycleIds: [] })
  }

  return id
}

/**
 * Every injection the graph's provider and controller cycles run through, in
 * path order.
 *
 * A cycle's path names each class with its module — as `{ module, provider }`
 * items in a provider cycle, as `Module:Class` strings in a controller one —
 * and each class injects the next, the last repeating the first: a path of
 * n + 1 names is n injections, and a class injecting itself is a path of two
 * and a single step. A string that names no module is skipped. Module cycles
 * are imports between modules, not injections, so they have no steps.
 */
export function getDependencyCycleSteps(
  cycles: Partial<Pick<GraphOutputCycles, 'providers' | 'controllers'>> | undefined
): DependencyCycleStep[] {
  const paths = [
    ...(cycles?.providers ?? []).map(cycle => ({
      id: cycle.id,
      nodes: cycle.path.map((item): DependencyCycleNode | null => ({
        moduleName: item.module.name,
        name: item.provider.name
      }))
    })),
    ...(cycles?.controllers ?? []).map(cycle => ({
      id: cycle.id,
      nodes: cycle.path.map(splitCycleKey)
    }))
  ]
  const steps: DependencyCycleStep[] = []

  for (const { id, nodes } of paths) {
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const dependent = nodes[index]
      const dependency = nodes[index + 1]
      if (dependent && dependency) {
        steps.push({ cycleId: id, dependent, dependency })
      }
    }
  }

  return steps
}

/**
 * The class a `Module:Class` cycle key names, split at the first colon as the
 * library joins it, or `null` for a key with no module.
 */
function splitCycleKey(key: string): DependencyCycleNode | null {
  const separatorIndex = key.indexOf(':')
  if (separatorIndex === -1) {
    return null
  }

  return {
    moduleName: key.slice(0, separatorIndex),
    name: key.slice(separatorIndex + 1)
  }
}

/**
 * One injection as a key: who injects, then what. JSON, like the node ids,
 * so names containing `:` or `-` cannot run into each other.
 */
function getInjectionKey(
  dependent: DependencyCycleNode,
  dependency: DependencyCycleNode
): string {
  return JSON.stringify([
    dependent.moduleName,
    dependent.name,
    dependency.moduleName,
    dependency.name
  ])
}

/**
 * How many providers deep each one injects: `0` for a provider that injects
 * none of its siblings, one more than its deepest sibling otherwise. A cycle
 * is cut where it is found, so every provider still gets a level.
 */
function resolveDependencyLevels(
  ids: string[],
  dependencies: Map<string, string[]>
): Map<string, number> {
  const levels = new Map<string, number>()
  const visiting = new Set<string>()

  function visit(id: string): number {
    const known = levels.get(id)
    if (known !== undefined) {
      return known
    }

    visiting.add(id)
    let level = 0
    for (const dependencyId of dependencies.get(id) ?? []) {
      if (dependencyId === id || visiting.has(dependencyId)) {
        continue
      }
      level = Math.max(level, visit(dependencyId) + 1)
    }
    visiting.delete(id)
    levels.set(id, level)

    return level
  }

  for (const id of ids) {
    visit(id)
  }

  return levels
}
