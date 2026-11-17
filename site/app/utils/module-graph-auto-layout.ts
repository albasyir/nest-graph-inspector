import type {
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
  LayoutOptions
} from 'elkjs/lib/elk-api'
import type { GraphOutput } from 'nest-graph-inspector'
import { LAYOUT_GEOMETRY, type LayoutSize } from './graph-layout-placement.ts'

/**
 * Where the modules go when nobody has arranged them: the viewer's automatic
 * layout.
 *
 * ELK's layered algorithm draws the module graph top-down, as a Mermaid
 * flowchart of the imports would be: the root module on top, every module
 * above the modules it imports, the order inside each layer chosen to keep
 * crossings down, and the import that closes a cycle drawn as the one edge
 * pointing back up. ELK also routes every import through the gaps it leaves
 * between modules, so a line never has to pass behind one. When ELK cannot be
 * loaded or started, dies, throws, or answers with something that cannot be
 * drawn, the modules fall back to a simple arrangement instead: layers from
 * the root, each wrapped into rows of a bounded width.
 *
 * ELK is the one thing here that is not pure, and it is handed in as an
 * `ElkEngineSource`: the viewer's runs ELK in a worker, warmed before the
 * graph arrives (`elk-engine-source.ts`); a script or a test lays out with the
 * bundled build on its own thread (`bundledElkSource`), or with a stand-in.
 */

/** A module's top-left corner, in flow coordinates. */
export type LayoutPoint = { x: number, y: number }

/** A module as the viewer will draw it: its name and its box, open or collapsed. */
export type AutoLayoutModule = LayoutSize & { name: string }

/** One entry of a module's `imports`: `importer` imports `imported`. */
export type AutoLayoutImport = { importer: string, imported: string }

/** All a layout knows of the graph. */
export type ModuleGraphLayoutInput = {
  /** Every module to place, in the graph's own order, which breaks ties. */
  modules: readonly AutoLayoutModule[]
  /** The imports between them, in the graph's own order. */
  imports: readonly AutoLayoutImport[]
  /** The application's root module, always in the top layer. */
  root: string
}

/** Each module's top-left corner, by module name. */
export type ModulePositions = ReadonlyMap<string, LayoutPoint>

/**
 * Each import's path, from the importer's edge to the edge of the module it
 * imports, by `importRouteKey`.
 */
export type ModuleImportRoutes = ReadonlyMap<string, readonly LayoutPoint[]>

/** A layout ELK drew: where each module goes, and the way each import runs. */
export type ElkModuleLayout = {
  positions: Map<string, LayoutPoint>
  routes: Map<string, LayoutPoint[]>
}

/**
 * Why the modules were laid out in rows instead: ELK itself failed — it could
 * not be loaded or started, or its worker died (`engine`) — or it ran and
 * failed this graph, throwing or answering with something that cannot be
 * drawn (`layout`).
 */
export type AutoLayoutFallbackReason = 'engine' | 'layout'

/** Where ELK runs: in a worker, off the thread the page draws on, or on it. */
export type ElkRuntime = 'worker' | 'main-thread'

export type ModuleGraphAutoLayout
  = | {
    engine: 'elk'
    runtime: ElkRuntime
    /** Whether ELK was up and warm when the layout was asked for. */
    warm: boolean
    positions: ModulePositions
    routes: ModuleImportRoutes
  }
  | {
    engine: 'rows'
    warm: boolean
    positions: ModulePositions
    reason: AutoLayoutFallbackReason
    /** What ELK failed with. */
    error: unknown
  }
  /** A graph with no modules, which there is nothing to lay out for. */
  | { engine: 'none', positions: ModulePositions }

/** ELK, ready to lay graphs out. */
export type ElkEngine = {
  runtime: ElkRuntime
  layout: (graph: ElkNode) => Promise<ElkNode>
}

/**
 * The ELK a page's layouts share. An engine that fails is let go of the moment
 * it does, so the next layout — a retry included — starts a fresh one and
 * never reuses a broken one.
 */
export type ElkEngineSource = {
  /** Whether a layout asked for now would start at once: ELK up and warm. */
  isReady: () => boolean
  /**
   * The engine, started if it is not running yet. Rejects when ELK cannot be
   * loaded or started.
   */
  acquire: () => Promise<ElkEngine>
  /**
   * Resolves once the engine running now has finished its first layout — a
   * warm-up's or a real one's — at once if it has. Rejects if that engine
   * fails first, or if none is running.
   */
  whenReady: () => Promise<void>
}

/**
 * ELK itself failed, rather than the graph it was given: its worker's script
 * did not load, or the worker died. A layout an engine cannot finish for this
 * reason rejects with it, so it is told apart from ELK refusing a graph.
 */
export class ElkEngineFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ElkEngineFailure'
  }
}

/**
 * The User Timing measure each automatic layout records, from asking for ELK
 * to the modules standing where it put them:
 * `performance.getEntriesByName('ngi:auto-layout')`.
 */
export const AUTO_LAYOUT_MEASURE = 'ngi:auto-layout'

/**
 * The User Timing measure an engine records once, from being started to its
 * first layout done — a warm-up's, ideally, before any graph arrives.
 */
export const AUTO_LAYOUT_ENGINE_READY_MEASURE = 'ngi:auto-layout:engine-ready'

/**
 * The gap between modules, side by side in a layer and from one layer to the
 * next: the gap the viewer has always left between rows of modules.
 */
const MODULE_SPACING = LAYOUT_GEOMETRY.moduleGapY

/**
 * How far a route keeps from the modules it passes, its own included away
 * from where it meets them: far enough that no line seems to run along a
 * module's border, at no more than a few per cent on the drawing's size.
 */
export const ROUTE_MODULE_CLEARANCE = 24
/** How far apart two routes running side by side keep. */
export const ROUTE_GAP = 16

/** The box of a module the input has no size for, as the rows always drew it. */
const DEFAULT_MODULE_BOX: LayoutSize = {
  width: LAYOUT_GEOMETRY.nodeWidth + LAYOUT_GEOMETRY.modulePadding * 2,
  height: LAYOUT_GEOMETRY.moduleCollapsedHeight
}

/** Ids of what ELK lays out besides modules; a class name has no colon. */
const ELK_GRAPH_ID = 'ngi:modules'
const ELK_EDGE_ID_PREFIX = 'ngi:import:'

/** How ELK lays the module graph out; see the comments for the choices. */
export const MODULE_GRAPH_ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  // A module sits one layer below the deepest module importing it. Layering
  // for the fewest long edges instead sinks a module only the root imports
  // down towards what it imports, far from the root it hangs off.
  'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
  // A cycle is broken where a depth-first walk of the imports, from the root
  // in the graph's order, first returns to a module on its path: that import
  // is the one drawn pointing back up.
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.spacing.nodeNode': String(MODULE_SPACING),
  'elk.layered.spacing.nodeNodeBetweenLayers': String(MODULE_SPACING),
  // A route clears a module beside it within a layer, and one above or below
  // it in the gap between layers, by the same distance; routes side by side
  // keep their own gap, so a bundle of them still reads as separate lines.
  'elk.spacing.edgeNode': String(ROUTE_MODULE_CLEARANCE),
  'elk.layered.spacing.edgeNodeBetweenLayers': String(ROUTE_MODULE_CLEARANCE),
  'elk.spacing.edgeEdge': String(ROUTE_GAP),
  'elk.layered.spacing.edgeEdgeBetweenLayers': String(ROUTE_GAP),
  // Each import meets each of its modules at a port of its own, so no two
  // lines share an end point, and the two imports of a mutual pair stay two
  // paths. ELK's default, set so nothing comes to rely on it unawares.
  'elk.layered.mergeEdges': 'false',
  // One set of layers for every module, so the root's top layer is the top:
  // laid out apart, a module with no imports could be packed above the root.
  'elk.separateConnectedComponents': 'false',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.randomSeed': '1'
} as const satisfies LayoutOptions

/**
 * Every module hangs from the top of its layer, so an open module grows down
 * and the titles along a layer line up; ELK would centre them on its middle.
 */
const MODULE_NODE_OPTIONS: LayoutOptions = { 'elk.alignment': 'TOP' }

const IN_TOP_LAYER: LayoutOptions = {
  'elk.layered.layering.layerConstraint': 'FIRST'
}
/**
 * Where a module nothing imports and that imports nothing goes: below the
 * graph, as it always has, rather than beside the root as if it were one.
 */
const IN_BOTTOM_LAYER: LayoutOptions = {
  'elk.layered.layering.layerConstraint': 'LAST'
}

/**
 * The layout input for a graph, each module with the box the viewer draws it
 * in. A module with no size is left out, and so is an import of a module the
 * graph does not have.
 */
export function moduleGraphLayoutInput(params: {
  moduleMap: GraphOutput
  sizes: ReadonlyMap<string, LayoutSize>
}): ModuleGraphLayoutInput {
  const { moduleMap, sizes } = params
  const modules = Object.keys(moduleMap.modules).flatMap((name) => {
    const size = sizes.get(name)
    return size ? [{ name, width: size.width, height: size.height }] : []
  })
  const imports = Object.entries(moduleMap.modules).flatMap(([importer, mod]) =>
    mod.imports
      .filter(imported => Object.hasOwn(moduleMap.modules, imported))
      .map(imported => ({ importer, imported }))
  )

  return { modules, imports, root: moduleMap.root }
}

/**
 * Lays the modules out: with ELK, or — when ELK fails — in rows, saying why.
 * Never rejects.
 *
 * There is no deadline. A layout waits for ELK for as long as ELK takes to
 * arrive and answer: on a slow connection its worker's script alone is a
 * megabyte and a half, and no fixed time tells a slow ELK from a stuck one —
 * a deadline short enough to matter throws away layouts about to land, and a
 * long one only delays the same rows. So only a real failure falls back: the
 * engine's import rejecting, its worker's `error` event, `elk.layout`
 * rejecting, or an answer that cannot be drawn. A layout that never settles
 * leaves its viewer saying it is still arranging, deliberately: there is no
 * hang guard, since a guard is a deadline by another name.
 */
export async function autoLayoutModuleGraph(params: {
  input: ModuleGraphLayoutInput
  engines?: ElkEngineSource
  /**
   * Told once ELK is up — has finished its first layout, a warm-up's or this
   * one's — or at once if it already was. Not told when ELK fails first.
   */
  onEngineReady?: () => void
}): Promise<ModuleGraphAutoLayout> {
  const { input, engines = bundledElkSource, onEngineReady } = params
  if (input.modules.length === 0) {
    return { engine: 'none', positions: new Map() }
  }

  let elk: ElkEngine
  try {
    elk = await engines.acquire()
  } catch (error) {
    return fallBackToRows({ input, warm: false, reason: 'engine', error })
  }

  // Whether ELK was up and warm, as this layout found it once it had the
  // engine: a source still being imported cannot say before then.
  const warm = engines.isReady()
  if (warm) {
    onEngineReady?.()
  } else {
    // An engine that fails before it is ready fails this layout too, which
    // says so itself.
    void engines.whenReady().then(() => onEngineReady?.(), () => undefined)
  }

  try {
    const { positions, routes } = await layoutModuleGraphWithElk({ input, elk })
    return { engine: 'elk', runtime: elk.runtime, warm, positions, routes }
  } catch (error) {
    return fallBackToRows({
      input,
      warm,
      reason: error instanceof ElkEngineFailure ? 'engine' : 'layout',
      error
    })
  }
}

function fallBackToRows(params: {
  input: ModuleGraphLayoutInput
  warm: boolean
  reason: AutoLayoutFallbackReason
  error: unknown
}): ModuleGraphAutoLayout {
  const { input, warm, reason, error } = params
  return { engine: 'rows', warm, positions: layoutModuleRows(input), reason, error }
}

/**
 * Lays the modules out with ELK, the drawing moved so it starts at the
 * origin. Throws when ELK does, or when its answer leaves a module without a
 * position; an import ELK gives no usable route to simply has none.
 */
export async function layoutModuleGraphWithElk(params: {
  input: ModuleGraphLayoutInput
  elk: ElkEngine
}): Promise<ElkModuleLayout> {
  const { input, elk } = params
  if (input.modules.length === 0) {
    return { positions: new Map(), routes: new Map() }
  }

  const { graph, importsByEdgeId } = elkGraphOf(input)
  const laidOut = await elk.layout(graph)
  return readElkLayout({ laidOut, modules: input.modules, importsByEdgeId })
}

/** The key an import's route is kept under. */
export function importRouteKey({ importer, imported }: AutoLayoutImport): string {
  return JSON.stringify([importer, imported])
}

/**
 * The graph ELK is given: every module, the root first and pinned to the top
 * layer, and every import between two modules once — a module importing
 * itself changes no layer, so it is left to the viewer's own loop.
 */
export function toElkGraph(input: ModuleGraphLayoutInput): ElkNode {
  return elkGraphOf(input).graph
}

/**
 * The shape the rows aim for, width to height: a little wider than tall, as
 * the canvases they are drawn on are.
 */
const ROWS_ASPECT_RATIO = 16 / 10
/**
 * The gap between one layer's rows and the next layer's: twice the gap between
 * the rows a layer wraps into, so each layer still reads as one.
 */
const ROWS_LAYER_GAP = MODULE_SPACING * 2

/** A module in the rows: its box, and whether the input has it to place. */
type RowModule = LayoutSize & { name: string, isPlaced: boolean }

/**
 * The simple arrangement drawn before ELK's lands, and in its place when ELK
 * fails. Modules go in layers by their shortest import path from the root —
 * the root alone on top, the modules it does not reach in one layer at the
 * bottom — and each layer is wrapped into rows, in the graph's order, no
 * wider than the whole drawing needs to come out about `ROWS_ASPECT_RATIO`:
 * a layer of many modules never becomes one row thousands of pixels wide.
 * Each row is centred under the root, and the same input always gives the
 * same rows.
 */
export function layoutModuleRows(
  input: ModuleGraphLayoutInput
): Map<string, LayoutPoint> {
  const boxes = new Map(input.modules.map(module => [module.name, module]))
  const layers = assignLayers(input).map(layer => layer.map((name): RowModule => {
    const box = boxes.get(name)
    const { width, height } = box ?? DEFAULT_MODULE_BOX
    return { name, width, height, isPlaced: box !== undefined }
  }))
  const widest = Math.max(...layers.flat().map(module => module.width))
  const longest = Math.max(...layers.map(layer => layer.length))

  // A row of `perRow` of the widest module, for each count a layer could
  // take: the one whose drawing comes out nearest the aspect ratio wins, the
  // narrower on a tie.
  let best: { rows: RowModule[][][], miss: number } | undefined
  for (let perRow = 1; perRow <= longest; perRow += 1) {
    const maxWidth = perRow * widest + (perRow - 1) * MODULE_SPACING
    const rows = layers.map(layer => wrapIntoRows(layer, maxWidth))
    const miss = Math.abs(Math.log(drawingWidth(rows) / drawingHeight(rows) / ROWS_ASPECT_RATIO))
    if (!best || miss < best.miss) {
      best = { rows, miss }
    }
  }

  return placeRows(best?.rows ?? [])
}

/** One layer's modules, in order, in rows no wider than `maxWidth` unless one module is. */
function wrapIntoRows(layer: readonly RowModule[], maxWidth: number): RowModule[][] {
  const rows: RowModule[][] = []
  let width = 0
  for (const module of layer) {
    const row = rows.at(-1)
    const widthWithIt = width + MODULE_SPACING + module.width
    if (row && widthWithIt <= maxWidth) {
      row.push(module)
      width = widthWithIt
    } else {
      rows.push([module])
      width = module.width
    }
  }

  return rows
}

function rowWidth(row: readonly RowModule[]): number {
  return row.reduce((sum, module) => sum + module.width, 0)
    + Math.max(row.length - 1, 0) * MODULE_SPACING
}

function rowHeight(row: readonly RowModule[]): number {
  return Math.max(...row.map(module => module.height), 0)
}

function drawingWidth(layers: readonly (readonly RowModule[][])[]): number {
  return Math.max(...layers.flat().map(rowWidth), 1)
}

function drawingHeight(layers: readonly (readonly RowModule[][])[]): number {
  const layerHeights = layers.map(rows =>
    rows.reduce((sum, row) => sum + rowHeight(row), 0)
    + Math.max(rows.length - 1, 0) * MODULE_SPACING
  )
  return Math.max(
    layerHeights.reduce((sum, height) => sum + height, 0)
    + Math.max(layers.length - 1, 0) * ROWS_LAYER_GAP,
    1
  )
}

/** Each layer's rows top to bottom, each row centred on the origin. */
function placeRows(layers: readonly (readonly RowModule[][])[]): Map<string, LayoutPoint> {
  const positions = new Map<string, LayoutPoint>()
  let top = 0

  for (const [layerIndex, rows] of layers.entries()) {
    if (layerIndex > 0) {
      top += ROWS_LAYER_GAP
    }

    for (const [rowIndex, row] of rows.entries()) {
      if (rowIndex > 0) {
        top += MODULE_SPACING
      }

      let left = -(rowWidth(row) / 2)
      for (const module of row) {
        if (module.isPlaced) {
          positions.set(module.name, { x: left, y: top })
        }
        left += module.width + MODULE_SPACING
      }
      top += rowHeight(row)
    }
  }

  return positions
}

/** What the `ngi:auto-layout` measure records of a layout as its detail. */
export type AutoLayoutTimingDetail = {
  engine: ModuleGraphAutoLayout['engine']
  modules: number
  /** Whether ELK was up and warm when the layout was asked for. */
  warm?: boolean
  runtime?: ElkRuntime
  reason?: AutoLayoutFallbackReason
  error?: string
}

/**
 * The detail of a layout's `ngi:auto-layout` measure: which engine placed the
 * modules, how many, whether ELK was warm when asked and where it ran, and why
 * it did not place them when it did not.
 */
export function autoLayoutTimingDetail(
  layout: ModuleGraphAutoLayout
): AutoLayoutTimingDetail {
  switch (layout.engine) {
    case 'elk':
      return {
        engine: 'elk',
        modules: layout.positions.size,
        warm: layout.warm,
        runtime: layout.runtime
      }
    case 'rows':
      return {
        engine: 'rows',
        modules: layout.positions.size,
        warm: layout.warm,
        reason: layout.reason,
        error: layout.error instanceof Error
          ? layout.error.message
          : String(layout.error)
      }
    case 'none':
      return { engine: 'none', modules: 0 }
    default: {
      const exhaustive: never = layout
      return exhaustive
    }
  }
}

/**
 * Records a User Timing measure — a layout's, or an engine's coming up.
 * Timing is instrumentation only: a browser without measure options, from
 * User Timing Level 3, goes without the measure rather than without the graph.
 */
export function recordUserTiming(measure: {
  name: string
  start: number
  end: number
  detail: unknown
}): void {
  try {
    performance.measure(measure.name, {
      start: measure.start,
      end: measure.end,
      detail: measure.detail
    })
  } catch {
    // Nothing is lost but the measure.
  }
}

/**
 * A small application's imports: a root importing most of the modules, one
 * module every other imports, imports that skip layers, a cycle — Accounts →
 * Catalog → Notifications → Accounts — and a module on its own.
 */
const WARM_UP_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  AppModule: ['AccountsModule', 'BillingModule', 'CatalogModule', 'CheckoutModule', 'DeliveryModule', 'InventoryModule', 'SharedModule'],
  AccountsModule: ['CatalogModule', 'CheckoutModule', 'SharedModule'],
  BillingModule: ['CheckoutModule', 'DeliveryModule', 'SharedModule'],
  CatalogModule: ['InventoryModule', 'NotificationsModule', 'SharedModule'],
  CheckoutModule: ['NotificationsModule', 'SharedModule'],
  DeliveryModule: ['ReportsModule', 'SharedModule'],
  InventoryModule: ['ReportsModule', 'SharedModule'],
  NotificationsModule: ['AccountsModule', 'SharedModule'],
  ReportsModule: ['SharedModule'],
  SharedModule: [],
  CoreModule: []
}

/**
 * A graph shaped like a real one, open and collapsed boxes and all, so a
 * warm-up runs every step a real layout takes, and the first real graph finds
 * ELK's code loaded, compiled and warm.
 */
export const WARM_UP_LAYOUT_INPUT: ModuleGraphLayoutInput = {
  root: 'AppModule',
  modules: Object.keys(WARM_UP_IMPORTS).map((name, index) => ({
    name,
    width: index % 3 === 0 ? 240 : 492,
    height: index % 2 === 0 ? 40 : 248
  })),
  imports: Object.entries(WARM_UP_IMPORTS).flatMap(([importer, imported]) =>
    imported.map(name => ({ importer, imported: name }))
  )
}

let bundledElk: Promise<ElkEngine> | undefined
let isBundledElkLoaded = false

/**
 * ELK's bundled build, imported on first use — it is over a megabyte and a
 * half — then kept for the page's lifetime. A failed import is forgotten, so
 * the next layout tries again.
 *
 * It lays out on the calling thread, which nothing can interrupt: what a
 * script or a test lays out with, and what a page that cannot make a worker
 * falls back to.
 */
export function loadBundledElk(): Promise<ElkEngine> {
  bundledElk ??= import('elkjs/lib/elk.bundled.js').then(
    ({ default: Elk }): ElkEngine => {
      const elk = new Elk()
      isBundledElkLoaded = true
      return { runtime: 'main-thread', layout: graph => elk.layout(graph) }
    },
    (error: unknown) => {
      bundledElk = undefined
      throw error
    }
  )

  return bundledElk
}

/**
 * The bundled build on this thread, as an engine source: ready as soon as it
 * is loaded, since it needs no worker to come up.
 */
export const bundledElkSource: ElkEngineSource = {
  isReady: () => isBundledElkLoaded,
  acquire: loadBundledElk,
  whenReady: () => bundledElk
    ? bundledElk.then(() => undefined)
    : Promise.reject(new ElkEngineFailure('ELK\'s bundled build is not loading'))
}

/**
 * The graph ELK is given — see `toElkGraph` — and the import each of its edges
 * stands for, by edge id: the one place an edge's id is tied to its import, so
 * ELK's answer is read back by the ids it was given.
 */
function elkGraphOf(input: ModuleGraphLayoutInput): {
  graph: ElkNode
  importsByEdgeId: ReadonlyMap<string, AutoLayoutImport>
} {
  const importsByEdgeId = new Map(
    importsBetween(input).map((moduleImport, index): [string, AutoLayoutImport] => [
      `${ELK_EDGE_ID_PREFIX}${index}`,
      moduleImport
    ])
  )
  const connected = new Set(
    [...importsByEdgeId.values()].flatMap(({ importer, imported }) => [importer, imported])
  )
  const rootFirst = [
    ...input.modules.filter(module => module.name === input.root),
    ...input.modules.filter(module => module.name !== input.root)
  ]

  return {
    graph: {
      id: ELK_GRAPH_ID,
      layoutOptions: { ...MODULE_GRAPH_ELK_OPTIONS },
      children: rootFirst.map(module => ({
        id: module.name,
        width: module.width,
        height: module.height,
        layoutOptions: {
          ...MODULE_NODE_OPTIONS,
          ...layerConstraint({ name: module.name, root: input.root, connected })
        }
      })),
      edges: [...importsByEdgeId].map(([id, { importer, imported }]) => ({
        id,
        sources: [importer],
        targets: [imported]
      }))
    },
    importsByEdgeId
  }
}

/** Each import between two of the modules once, a module's import of itself left out. */
function importsBetween(input: ModuleGraphLayoutInput): AutoLayoutImport[] {
  const names = new Set(input.modules.map(module => module.name))
  const seen = new Set<string>()

  return input.imports.filter(({ importer, imported }) => {
    const key = importRouteKey({ importer, imported })
    if (
      importer === imported
      || !names.has(importer)
      || !names.has(imported)
      || seen.has(key)
    ) {
      return false
    }

    seen.add(key)
    return true
  })
}

/** The root on top; a module with no imports either way at the bottom. */
function layerConstraint(params: {
  name: string
  root: string
  connected: ReadonlySet<string>
}): LayoutOptions {
  const { name, root, connected } = params
  if (name === root) {
    return IN_TOP_LAYER
  }

  return connected.has(name) ? {} : IN_BOTTOM_LAYER
}

/**
 * ELK's answer, checked: every module placed at a finite point, and each
 * import's route kept when it is one unbroken run of finite points. All of it
 * is moved so the drawing starts at the origin, on whole pixels.
 */
function readElkLayout(params: {
  laidOut: ElkNode
  modules: ModuleGraphLayoutInput['modules']
  importsByEdgeId: ReadonlyMap<string, AutoLayoutImport>
}): ElkModuleLayout {
  const { laidOut, modules, importsByEdgeId } = params
  const placed = new Map((laidOut.children ?? []).map(child => [child.id, child]))
  const corners = modules.map(({ name }) => {
    const child = placed.get(name)
    const x = child?.x
    const y = child?.y
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      throw new Error(`ELK left module ${name} without a position`)
    }

    return { name, x, y }
  })
  const left = Math.min(...corners.map(corner => corner.x))
  const top = Math.min(...corners.map(corner => corner.y))
  const shift = ({ x, y }: ElkPoint): LayoutPoint => ({
    x: Math.round(x - left),
    y: Math.round(y - top)
  })

  const routes = new Map<string, LayoutPoint[]>()
  for (const edge of laidOut.edges ?? []) {
    const moduleImport = importsByEdgeId.get(edge.id)
    const points = routePoints(edge)
    if (moduleImport && points) {
      routes.set(importRouteKey(moduleImport), points.map(shift))
    }
  }

  return {
    positions: new Map(corners.map(({ name, x, y }) => [name, shift({ x, y })])),
    routes
  }
}

/** An edge's route, start to end, when ELK drew it as one section of finite points. */
function routePoints(edge: ElkExtendedEdge): ElkPoint[] | undefined {
  const [section, ...more] = edge.sections ?? []
  if (!section || more.length > 0) {
    return undefined
  }

  const points: Partial<ElkPoint>[] = [
    section.startPoint,
    ...(section.bendPoints ?? []),
    section.endPoint
  ]
  return points.every(isFinitePoint) ? points : undefined
}

function isFinitePoint(point: Partial<ElkPoint> | undefined): point is ElkPoint {
  return isFiniteNumber(point?.x) && isFiniteNumber(point?.y)
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The layers, top first: breadth first from the root along the imports, then
 * every module the root does not reach, together in one layer at the bottom.
 */
function assignLayers(input: ModuleGraphLayoutInput): string[][] {
  const known = new Set(input.modules.map(module => module.name))
  const importsOf = new Map<string, string[]>()
  for (const { importer, imported } of input.imports) {
    importsOf.set(importer, [...(importsOf.get(importer) ?? []), imported])
  }

  const layers: string[][] = []
  const visited = new Set([input.root])
  const queue = [{ name: input.root, depth: 0 }]

  for (const { name, depth } of queue) {
    layers[depth] = [...(layers[depth] ?? []), name]
    for (const imported of importsOf.get(name) ?? []) {
      if (!visited.has(imported) && known.has(imported)) {
        visited.add(imported)
        queue.push({ name: imported, depth: depth + 1 })
      }
    }
  }

  const unreached = input.modules
    .map(module => module.name)
    .filter(name => !visited.has(name))
  return unreached.length > 0 ? [...layers, unreached] : layers
}
