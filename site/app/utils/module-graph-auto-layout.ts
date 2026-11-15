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
 * between modules, so a line never has to pass behind one. When ELK cannot
 * start, throws, or takes too long — a layout past its deadline is stopped,
 * engine and all — the modules fall back to the rows the viewer drew before
 * it.
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

/** Why the modules were laid out in rows instead. */
export type AutoLayoutFallbackReason = 'error' | 'timeout'

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
    /** What ELK failed with, or the timeout. */
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
 * The ELK a page's layouts share. A layout that runs past its deadline aborts
 * it: the engine stops — a worker is terminated, with whatever it was laying
 * out — and the next layout starts another.
 */
export type ElkEngineSource = {
  /** Whether a layout asked for now would start at once: ELK up and warm. */
  isReady: () => boolean
  /** The engine, started if it is not running yet. */
  acquire: () => Promise<ElkEngine>
  /** Stops the engine and anything it is laying out. */
  abort: () => void
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
 * How long a layout may take, waiting for ELK to start included, before it is
 * stopped and the modules fall back to rows: room for ELK's script on a slow
 * connection, short of a wait nobody would sit through in front of a blank
 * canvas.
 */
export const AUTO_LAYOUT_TIMEOUT_MS = 5000

/**
 * The gap between modules, side by side in a layer and from one layer to the
 * next: the gap the viewer has always left between rows of modules.
 */
const MODULE_SPACING = LAYOUT_GEOMETRY.moduleGapY

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
 * Lays the modules out: with ELK when it starts and answers in time, and
 * otherwise in rows, saying why. A layout still running at the deadline is
 * abandoned with the engine running it. Never rejects.
 */
export async function autoLayoutModuleGraph(params: {
  input: ModuleGraphLayoutInput
  engines?: ElkEngineSource
  timeoutMs?: number
}): Promise<ModuleGraphAutoLayout> {
  const {
    input,
    engines = bundledElkSource,
    timeoutMs = AUTO_LAYOUT_TIMEOUT_MS
  } = params
  if (input.modules.length === 0) {
    return { engine: 'none', positions: new Map() }
  }

  // Whether ELK was up and warm, as this layout found it once it had the
  // engine: a source still being imported cannot say before then.
  let warm = false
  const seeWhetherWarm = () => {
    warm = engines.isReady()
  }
  try {
    const { runtime, positions, routes } = await withTimeout({
      work: layoutWith({ input, engines, onEngine: seeWhetherWarm }),
      timeoutMs
    })
    return { engine: 'elk', runtime, warm, positions, routes }
  } catch (error) {
    const isTimeout = error instanceof AutoLayoutTimeoutError
    if (isTimeout) {
      // Whatever ELK is still doing for this layout is thrown away, and so is
      // the engine doing it: a worker is stopped, and the next layout starts
      // a fresh one rather than queueing behind a layout nobody awaits.
      engines.abort()
    }

    return {
      engine: 'rows',
      warm,
      positions: layoutModuleRows(input),
      reason: isTimeout ? 'timeout' : 'error',
      error
    }
  }
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
 * The rows the viewer drew before ELK, and draws when ELK fails: each module
 * in the layer of its shortest import path from the root, each module the
 * root does not reach in a layer of its own below those, and each layer one
 * row centred under the root's.
 */
export function layoutModuleRows(
  input: ModuleGraphLayoutInput
): Map<string, LayoutPoint> {
  const boxes = new Map(input.modules.map(module => [module.name, module]))
  const positions = new Map<string, LayoutPoint>()
  let top = 0

  for (const row of assignRows(input)) {
    const rowWidth = row.reduce(
      (sum, name) => sum + (boxes.get(name) ?? DEFAULT_MODULE_BOX).width,
      Math.max(row.length - 1, 0) * LAYOUT_GEOMETRY.moduleGapX
    )
    let left = -(rowWidth / 2)
    let rowHeight = 0

    for (const name of row) {
      const box = boxes.get(name) ?? DEFAULT_MODULE_BOX
      if (boxes.has(name)) {
        positions.set(name, { x: left, y: top })
      }
      rowHeight = Math.max(rowHeight, box.height)
      left += box.width + LAYOUT_GEOMETRY.moduleGapX
    }

    top += rowHeight + LAYOUT_GEOMETRY.moduleGapY
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
 * The bundled build on this thread, as an engine source. A layout on this
 * thread cannot be stopped part way, so `abort` leaves it to finish.
 */
export const bundledElkSource: ElkEngineSource = {
  isReady: () => isBundledElkLoaded,
  acquire: loadBundledElk,
  abort: () => undefined
}

class AutoLayoutTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The automatic layout took longer than ${timeoutMs} ms`)
    this.name = 'AutoLayoutTimeoutError'
  }
}

/**
 * `work`, or a timeout once `timeoutMs` has passed without it settling.
 *
 * ELK in a worker is stopped at the deadline. ELK on this thread — the
 * fallback where no worker can be made — cannot be: a layout running past the
 * deadline holds the deadline back until it has finished and queued its
 * answer. So the timeout waits one more turn for an answer already queued: by
 * then the visitor has waited for that layout, and rows would throw it away.
 */
function withTimeout<T>(params: {
  work: Promise<T>
  timeoutMs: number
}): Promise<T> {
  const { work, timeoutMs } = params

  return new Promise<T>((resolve, reject) => {
    let lastTurn: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(() => {
      lastTurn = setTimeout(() => reject(new AutoLayoutTimeoutError(timeoutMs)), 0)
    }, timeoutMs)
    const clearTimers = () => {
      clearTimeout(deadline)
      clearTimeout(lastTurn)
    }

    work.then(
      (value) => {
        clearTimers()
        resolve(value)
      },
      (error: unknown) => {
        clearTimers()
        reject(error)
      }
    )
  })
}

async function layoutWith(params: {
  input: ModuleGraphLayoutInput
  engines: ElkEngineSource
  /** Called with the engine in hand, before it is given the graph. */
  onEngine: () => void
}): Promise<ElkModuleLayout & { runtime: ElkRuntime }> {
  const elk = await params.engines.acquire()
  params.onEngine()
  const laidOut = await layoutModuleGraphWithElk({ input: params.input, elk })
  return { ...laidOut, runtime: elk.runtime }
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
 * The rows, top first: breadth first from the root along the imports, then
 * each module the root does not reach in a new row of its own.
 */
function assignRows(input: ModuleGraphLayoutInput): string[][] {
  const known = new Set(input.modules.map(module => module.name))
  const importsOf = new Map<string, string[]>()
  for (const { importer, imported } of input.imports) {
    importsOf.set(importer, [...(importsOf.get(importer) ?? []), imported])
  }

  const rows = new Map<number, string[]>()
  const addToRow = (depth: number, name: string) => {
    rows.set(depth, [...(rows.get(depth) ?? []), name])
  }
  const visited = new Set([input.root])
  const queue = [{ name: input.root, depth: 0 }]

  for (const { name, depth } of queue) {
    addToRow(depth, name)
    for (const imported of importsOf.get(name) ?? []) {
      if (!visited.has(imported) && known.has(imported)) {
        visited.add(imported)
        queue.push({ name: imported, depth: depth + 1 })
      }
    }
  }

  for (const { name } of input.modules) {
    if (!visited.has(name)) {
      addToRow(Math.max(...rows.keys(), 0) + 1, name)
    }
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => row)
}
