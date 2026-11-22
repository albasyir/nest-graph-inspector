/**
 * One module among the others, laid out as a tournament bracket that opens
 * both ways: what it needs to its left, what needs it to its right.
 *
 * The navigator answers "how do all the modules fit together"; this answers
 * it for one module at a time. The module sits in the middle. The modules it
 * imports stand one column to its left, the modules those import one column
 * further, and so on — and the modules importing it fan out to its right the
 * same way. Each side is a breadth-first walk of the imports, one way or the
 * other, so a module stands once per side, at its shortest distance, however
 * many ways lead to it; a cycle can never make a walk go round for ever. A
 * module that stands on both sides is on a cycle with the one in the middle —
 * it needs it and is needed by it — and says so.
 *
 * Each side shows as many levels as it is asked for, and the two are asked for
 * separately. A branch that goes on past the last level drawn ends in a stub
 * counting the modules waiting one level further along it.
 *
 * Every import is drawn from the module imported to the module importing it,
 * as the navigator draws an import, so arrows run left to right across the
 * whole bracket: into the middle from what it needs, out of it to what needs
 * it. The breadth-first tree of each side is drawn solid, as bracket
 * connectors; an import between two modules already drawn on the same side is
 * drawn as a dashed link instead of standing a module twice. An import back
 * into the middle is the one never drawn again on its side: the module making
 * it always stands one level into the other side, joined to the middle there.
 * An import on a cycle the graph reports carries that cycle's `#id`.
 *
 * Pure data in, pure data out — the component only renders what this returns,
 * and the layout is the same for the same graph every time.
 */
import type { GraphOutput, GraphOutputModule } from 'nest-graph-inspector'
import {
  formatCircularEdgeLabel,
  getCircularEdgeGeometry,
  unionRects,
  type CircularEdgeRect,
  type CircularEdgeSide,
  type CircularLabelSpot
} from './circular-dependency-edge.ts'
import { getDirectRunNodeId } from './direct-run-provider.ts'
import { roundedPolylinePath, type EdgePoint } from './graph-viewer-edges.ts'
import { encodeModuleId } from './module-id.ts'

/**
 * A side of the bracket: `left` holds what the module in the middle needs —
 * its imports, theirs, and so on — and `right` what needs it.
 */
export type BracketSide = 'left' | 'right'

export const BRACKET_SIDES: readonly BracketSide[] = ['left', 'right']

/** How many levels a side shows when nothing else is asked for. */
export const DEFAULT_BRACKET_DEPTH = 3

export type ModuleDependencyBracketInput = {
  graph: Pick<GraphOutput, 'modules'> & Partial<Pick<GraphOutput, 'root' | 'cycles'>>
  /** The module in the middle. */
  center: string
  /**
   * How many levels each side is asked to show. Anything under 1, or not a
   * whole number, is read as the nearest depth there is; a side with fewer
   * levels shows all it has.
   */
  depth: Readonly<Record<BracketSide, number>>
  /** `regular` when absent. */
  size?: BracketSize
}

/** Where a node is drawn, in flow coordinates, and its size. */
type NodeBox = {
  id: string
  position: EdgePoint
  width: number
  height: number
}

/** What the card in the middle says about its module. */
export type BracketCenterStats = {
  providers: number
  controllers: number
  imports: number
  exports: number
  /**
   * Node ids of the providers, then the controllers, of the module that
   * advertise a method Direct Run can call, in the order the module declares
   * them.
   */
  runnableNodeIds: string[]
}

export type BracketCenterNode = NodeBox & {
  kind: 'center'
  moduleName: string
  isRoot: boolean
  /** The module is on a cycle: some module stands on both sides, or it imports itself. */
  isOnCycle: boolean
  stats: BracketCenterStats
}

export type BracketModuleNode = NodeBox & {
  kind: 'module'
  moduleName: string
  side: BracketSide
  /** How many imports away from the middle: 1 for the module's own. */
  level: number
  isRoot: boolean
  /**
   * The module stands on both sides — it needs the module in the middle and
   * is needed by it — so the two are on a cycle. Read from every level, drawn
   * or not.
   */
  isOnCycleWithCenter: boolean
}

/** Where a branch goes on past the last level drawn. */
export type BracketStubNode = NodeBox & {
  kind: 'stub'
  side: BracketSide
  /** The level the modules it counts stand on, one past the last drawn. */
  level: number
  /** The node id of the module whose branch it ends. */
  parentId: string
  /** Distinct modules one level further along the branch, none of them drawn. */
  moduleCount: number
  /** Their names, in code-unit order. */
  moduleNames: string[]
}

/** Stands in for a side with no module on it at all. */
export type BracketEmptyNode = NodeBox & {
  kind: 'empty'
  side: BracketSide
}

/** The heading over a column. */
export type BracketLevelNode = NodeBox & {
  kind: 'level'
  side: BracketSide
  level: number
  /** Modules in the column. */
  moduleCount: number
}

export type BracketNode
  = | BracketCenterNode
    | BracketModuleNode
    | BracketStubNode
    | BracketEmptyNode
    | BracketLevelNode

/** A handle every bracket node has: one of each kind on each side. */
export type BracketHandle = 'left-source' | 'left-target' | 'right-source' | 'right-target'

/**
 * What an edge draws: an import on a side's breadth-first tree (`tree`), an
 * import between two modules already drawn on that side (`link`), a branch
 * running on into its stub (`stub`), or a module importing itself (`self`).
 */
export type BracketEdgeKind = 'tree' | 'link' | 'stub' | 'self'

export type BracketEdge = {
  id: string
  /** The module imported — or, for a stub edge, the end of the branch. */
  source: string
  /** The module importing it — or, for a stub edge, the stub. */
  target: string
  sourceHandle: BracketHandle
  targetHandle: BracketHandle
  kind: BracketEdgeKind
  /** The side it is drawn on; `null` for the module in the middle importing itself. */
  side: BracketSide | null
  /**
   * The ids of the module cycles the graph reports that this import is a
   * step of, ascending; empty for an import on none, and for a stub edge.
   */
  cycleIds: number[]
  /** SVG path data the edge is drawn along, in flow coordinates. */
  path: string
  /** Where its `#id` label goes, for an edge on a reported cycle; `null` otherwise. */
  label: CircularLabelSpot | null
}

export type BracketSideSummary = {
  /** The depth asked for, read as a whole number of at least 1. */
  requested: number
  /**
   * Levels drawn: the depth asked for, or every level the side has when it
   * has fewer; `0` for a side with no module on it.
   */
  depth: number
  /** Levels the side has, drawn or not. */
  available: number
  /** A level past the last one drawn exists. */
  hasMore: boolean
  /** Modules drawn on the side. */
  shown: number
  /** Modules on the side, drawn or not. */
  total: number
}

export type ModuleDependencyBracket = {
  center: string
  /** The size it was laid out at. */
  size: BracketSize
  nodes: BracketNode[]
  edges: BracketEdge[]
  sides: Record<BracketSide, BracketSideSummary>
  /** Everything drawn, edges and their labels included: what a fit frames. */
  bounds: CircularEdgeRect
}

/**
 * How large a bracket is drawn: at its full size, or compact enough for a
 * phone to show the module and the first level of each side at once, at a
 * size their names read at.
 */
export type BracketSize = 'regular' | 'compact'

/** Every length the layout works in, in flow pixels, for one size of bracket. */
type BracketMetrics = {
  /**
   * The module in the middle is the page's subject, so its card is the
   * largest on the canvas, and tall enough for its name, its four counts and
   * the Direct Run button.
   */
  centerWidth: number
  centerHeight: number
  moduleWidth: number
  moduleHeight: number
  stubWidth: number
  emptyHeight: number
  levelLabelHeight: number
  /** Between the top of the tallest column and the column headings. */
  levelLabelGap: number
  /**
   * Between two columns: room for the bracket's connectors, which turn
   * halfway across, for the lanes either side of that — a cycle's own way
   * into its module, and the links — and for a cycle label on a connector's
   * own stretch.
   */
  columnGap: number
  /** Between the rows a column's modules stand on: room to breathe, and for a channel. */
  rowGap: number
  /** How far out of its column a link's first lane runs, and how far apart lanes are. */
  laneStart: number
  laneStep: number
  /** Lanes beside a column: they stay clear of the gap's middle, where the brackets turn. */
  laneCount: number
  /** How far apart two links turning in one lane keep: a corner's radius each. */
  laneClearance: number
  /** How round an edge's corners are. */
  cornerRadius: number
  /**
   * How near the middle of a module's side, where the bracket's own connector
   * comes in, a cycle's port may be, and how close two ports may be: for a
   * module card, and for the taller card in the middle, whose ports spread
   * down its height.
   */
  portStepModule: number
  portStepCenter: number
  /**
   * How near its corner a module's last port may be — and the middle card's,
   * whose corners are rounder: past the curve, so an arrow meets a flat side.
   */
  portCornerClearance: number
  centerPortCornerClearance: number
  /** How far along its own stretch of connector a tree edge's label sits. */
  treeLabelInset: number
  /** How far apart two links crossing in one gap between rows run. */
  channelStep: number
  /**
   * A cycle label's size, as `getBracketLabelBox` reckons it: the padding and
   * border around its text, a character of its text, generously, and its
   * height.
   */
  labelChromeWidth: number
  labelCharacterWidth: number
  labelHeight: number
  /**
   * Whether a label with nowhere clear to go is drawn anyway, over what it
   * must cover, or left off — where the gaps are too narrow for one to cover
   * only a little.
   */
  isCrowdedLabelDrawn: boolean
  /**
   * How large a module's loop to itself is drawn, against the loop the
   * navigator draws: drawn in towards its handle where the gap beside the
   * card is narrower than that loop reaches.
   */
  selfLoopScale: number
}

const METRICS: Readonly<Record<BracketSize, BracketMetrics>> = {
  regular: {
    centerWidth: 360,
    centerHeight: 196,
    moduleWidth: 264,
    moduleHeight: 44,
    stubWidth: 148,
    emptyHeight: 72,
    levelLabelHeight: 28,
    levelLabelGap: 20,
    columnGap: 112,
    rowGap: 24,
    laneStart: 16,
    laneStep: 8,
    laneCount: 5,
    laneClearance: 8,
    cornerRadius: 8,
    portStepModule: 8,
    portStepCenter: 24,
    portCornerClearance: 6,
    centerPortCornerClearance: 18,
    treeLabelInset: 28,
    channelStep: 4,
    // The navigator's label, with its icon: more than the bracket's pill needs.
    labelChromeWidth: 31,
    labelCharacterWidth: 7,
    labelHeight: 20,
    isCrowdedLabelDrawn: true,
    selfLoopScale: 1
  },
  // A 390px phone holds the module and both first levels: 105 + 26 + 100 +
  // 26 + 105 = 362 flow pixels, drawn at 0.98. Module names are set at
  // 11.5px, two lines at most, broken between their words: the demo's
  // longest word, "Recommendation", takes 97 of a card's 105. In a 26px gap
  // the lanes beside each column, 6 and 9 out, keep 4px off its middle, at 13,
  // and a cycle's "#1" fits between the cards, 24px wide.
  compact: {
    centerWidth: 100,
    centerHeight: 182,
    moduleWidth: 105,
    moduleHeight: 46,
    stubWidth: 84,
    emptyHeight: 58,
    levelLabelHeight: 24,
    levelLabelGap: 12,
    columnGap: 26,
    rowGap: 12,
    laneStart: 6,
    laneStep: 3,
    laneCount: 2,
    laneClearance: 6,
    cornerRadius: 4,
    portStepModule: 7,
    portStepCenter: 16,
    portCornerClearance: 5,
    centerPortCornerClearance: 14,
    treeLabelInset: 13,
    channelStep: 3,
    labelChromeWidth: 10,
    labelCharacterWidth: 7,
    labelHeight: 20,
    isCrowdedLabelDrawn: false,
    // The navigator's loop reaches 44px out, past a 26px gap: half of it
    // keeps within, clear of the next column's cards.
    selfLoopScale: 0.5
  }
}

/**
 * The box a cycle label takes up on the canvas, as the layout keeps it clear
 * of cards and other labels: the pill the view draws at that size, with room
 * to spare.
 */
export function getBracketLabelBox(spot: CircularLabelSpot, text: string, size: BracketSize): CircularEdgeRect {
  return getLabelBox(spot, text, METRICS[size])
}

function getLabelBox(spot: CircularLabelSpot, text: string, m: BracketMetrics): CircularEdgeRect {
  const width = m.labelChromeWidth + m.labelCharacterWidth * text.length
  return {
    x: spot.labelX - spot.labelAnchor.x * width,
    y: spot.labelY - spot.labelAnchor.y * m.labelHeight,
    width,
    height: m.labelHeight
  }
}

/** The pitch between rows, and half the gap between them, where a channel between them runs. */
function rowPitchOf(m: BracketMetrics): number {
  return m.moduleHeight + m.rowGap
}

const LABEL_CENTERED = {
  labelTransform: 'translate(-50%, -50%)',
  labelAnchor: { x: 0.5, y: 0.5 }
} as const

/** The node id of the module in the middle. */
export const BRACKET_CENTER_ID = 'center'

/**
 * The bracket around `input.center`, or `null` when the graph has no such
 * module.
 *
 * The walks and the order of each column are linear in the modules and
 * imports the graph holds, give or take the sorting of a column; routing an
 * edge looks at the lanes beside its columns and, for a link reaching back
 * past the next column, at the gaps between the rows it crosses — so a graph
 * of hundreds of modules still lays out within a frame (the tests time 300).
 */
export function buildModuleDependencyBracket(
  input: ModuleDependencyBracketInput
): ModuleDependencyBracket | null {
  const { graph, center } = input
  const size = input.size ?? 'regular'
  const m = METRICS[size]
  const centerModule = Object.hasOwn(graph.modules, center)
    ? graph.modules[center]
    : undefined
  if (!centerModule) {
    return null
  }

  const adjacency = buildAdjacency(graph.modules)
  const cycleIdsByImport = indexModuleCycles(graph.cycles?.modules)
  const walks: Record<BracketSide, SideWalk> = {
    left: walkSide(adjacency.left, center),
    right: walkSide(adjacency.right, center)
  }
  const isOnBothSides = (moduleName: string) =>
    moduleName !== center
    && walks.left.distance.has(moduleName)
    && walks.right.distance.has(moduleName)
  const importsItself = (adjacency.left.get(center) ?? []).includes(center)

  const centerNode: BracketCenterNode = {
    kind: 'center',
    id: BRACKET_CENTER_ID,
    moduleName: center,
    position: { x: -m.centerWidth / 2, y: -m.centerHeight / 2 },
    width: m.centerWidth,
    height: m.centerHeight,
    isRoot: graph.root === center,
    isOnCycle: importsItself || [...walks.left.distance.keys()].some(isOnBothSides),
    stats: getCenterStats(center, centerModule)
  }

  const buildSide = (side: BracketSide) => {
    const walk = walks[side]
    const requested = readDepth(input.depth[side])
    const depth = Math.min(requested, walk.deepest)
    const layout = layoutSide({
      side,
      center,
      walk,
      depth,
      neighbours: adjacency[side],
      parentsOf: adjacency[otherSide(side)],
      isRoot: moduleName => graph.root === moduleName,
      isOnBothSides,
      // On the left the parent imports the module; on the right the module
      // imports its parent.
      isCycleStep: (parent, moduleName) => cycleIdsByImport.has(side === 'left'
        ? getImportKey(parent, moduleName)
        : getImportKey(moduleName, parent)),
      m
    })
    const summary: BracketSideSummary = {
      requested,
      depth,
      available: walk.deepest,
      hasMore: walk.deepest > depth,
      shown: layout.modules.size,
      total: walk.distance.size - 1
    }

    return { layout, summary }
  }

  const left = buildSide('left')
  const right = buildSide('right')
  const layouts: Record<BracketSide, SideLayout> = { left: left.layout, right: right.layout }

  const nodes: BracketNode[] = [centerNode, ...left.layout.nodes, ...right.layout.nodes]
  nodes.push(...getLevelLabels(nodes, layouts, m))

  const routePoints: EdgePoint[] = []
  const edges = routeEdges({
    center: centerNode,
    importsItself,
    layouts,
    walks,
    adjacency,
    cycleIdsByImport,
    nodes,
    routePoints,
    m
  })

  return {
    center,
    size,
    nodes,
    edges,
    sides: { left: left.summary, right: right.summary },
    bounds: getBracketBounds(nodes, edges, routePoints, m)
  }
}

/**
 * The node id of a module drawn on a side. The name goes through
 * `encodeModuleId`, which escapes the `:` it is joined with, so no two modules
 * — on one side or across both — ever share an id.
 */
export function getBracketModuleNodeId(side: BracketSide, moduleName: string): string {
  return `${side}:${encodeModuleId(moduleName)}`
}

function getStubNodeId(side: BracketSide, moduleName: string): string {
  return `stub-${side}:${encodeModuleId(moduleName)}`
}

function otherSide(side: BracketSide): BracketSide {
  return side === 'left' ? 'right' : 'left'
}

function readDepth(depth: number): number {
  return Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : DEFAULT_BRACKET_DEPTH
}

/** Who imports whom, both ways: each list in the graph's own order, without repeats. */
type Adjacency = Record<BracketSide, ReadonlyMap<string, readonly string[]>>

/**
 * Each module's imports (`left`, what it needs) and the modules importing it
 * (`right`, what needs it). An import naming a module the graph does not
 * describe goes nowhere it could be drawn, and is left out; one listed twice
 * counts once.
 */
function buildAdjacency(modules: GraphOutput['modules']): Adjacency {
  const imports = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()

  for (const moduleName of Object.keys(modules)) {
    imports.set(moduleName, [])
    dependents.set(moduleName, [])
  }

  for (const [moduleName, mod] of Object.entries(modules)) {
    const own = imports.get(moduleName) ?? []
    for (const imported of mod.imports) {
      const importers = dependents.get(imported)
      if (!importers || own.includes(imported)) {
        continue
      }

      own.push(imported)
      importers.push(moduleName)
    }
  }

  return { left: imports, right: dependents }
}

/** One side's breadth-first walk from the module in the middle. */
type SideWalk = {
  /** Each module the walk reached, with how many steps it took; the middle is 0. */
  distance: Map<string, number>
  /** The module each one was first reached from: its parent on the side's tree. */
  parent: Map<string, string>
  /** The furthest any module stands; 0 for a side with none. */
  deepest: number
}

/**
 * The breadth-first walk of one side. A module is reached once, at its
 * shortest distance, so a cycle — or a module importing itself — only ever
 * leads back to a module already reached, and the walk ends.
 */
function walkSide(
  neighbours: ReadonlyMap<string, readonly string[]>,
  center: string
): SideWalk {
  const distance = new Map<string, number>([[center, 0]])
  const parent = new Map<string, string>()
  const queue = [center]
  let deepest = 0

  // An array iterator reads the length afresh each step, so the modules
  // queued as it goes are walked too.
  for (const moduleName of queue) {
    const nextDistance = (distance.get(moduleName) ?? 0) + 1

    for (const next of neighbours.get(moduleName) ?? []) {
      if (distance.has(next)) {
        continue
      }

      distance.set(next, nextDistance)
      parent.set(next, moduleName)
      deepest = nextDistance
      queue.push(next)
    }
  }

  return { distance, parent, deepest }
}

/** A side laid out: its nodes, and the module nodes by module name. */
type SideLayout = {
  depth: number
  nodes: Array<BracketModuleNode | BracketStubNode | BracketEmptyNode>
  modules: Map<string, BracketModuleNode>
  /** Each stub, with the module whose branch it ends. */
  stubs: Array<{ stub: BracketStubNode, branch: BracketModuleNode }>
}

/**
 * Lays one side out as a bracket: each module in the column of its level, and
 * — as in a tournament bracket — each one nearer the middle placed halfway
 * down the rows its own branch takes, so no branch crosses another. Siblings
 * are ordered by where all their parents on the side stand in the column
 * before — every module there importing them on the left, or imported by them
 * on the right, not only the one the walk came from — which keeps the dashed
 * links between branches short; the first column, whose one parent is the
 * middle, is in name order. A parent's children on a reported cycle with it
 * stand above or below the rest, by where they would have stood, so the
 * cycle's own connectors come into the parent clear of the upright its other
 * branches share, never across it.
 */
function layoutSide(params: {
  side: BracketSide
  center: string
  walk: SideWalk
  depth: number
  neighbours: ReadonlyMap<string, readonly string[]>
  /** Each module's neighbours the other way: its parents on this side. */
  parentsOf: ReadonlyMap<string, readonly string[]>
  isRoot: (moduleName: string) => boolean
  isOnBothSides: (moduleName: string) => boolean
  /** Whether the import joining a module to its parent on the walk is on a reported cycle. */
  isCycleStep: (parent: string, moduleName: string) => boolean
  m: BracketMetrics
}): SideLayout {
  const { side, center, walk, depth, neighbours, parentsOf, isCycleStep, m } = params
  const layout: SideLayout = { depth, nodes: [], modules: new Map(), stubs: [] }
  const direction = side === 'left' ? -1 : 1

  if (depth === 0) {
    layout.nodes.push({
      kind: 'empty',
      id: `empty-${side}`,
      side,
      position: { x: getColumnX(direction, m.moduleWidth, m), y: -m.emptyHeight / 2 },
      width: m.moduleWidth,
      height: m.emptyHeight
    })
    return layout
  }

  // The side's tree, as far as it is drawn.
  const children = new Map<string, string[]>()
  for (const [moduleName, steps] of walk.distance) {
    const parent = walk.parent.get(moduleName)
    if (parent === undefined || steps > depth) {
      continue
    }

    const siblings = children.get(parent) ?? []
    siblings.push(moduleName)
    children.set(parent, siblings)
  }

  // Each column top to bottom: every parent's children together, in the order
  // their parents stand, and among themselves by where their parents stand.
  const columns: string[][] = []
  let previous = [center]
  for (let level = 1; level <= depth; level += 1) {
    const indexInPrevious = new Map(previous.map((moduleName, index) => [moduleName, index]))
    const column: string[] = []

    for (const parent of previous) {
      const sorted = (children.get(parent) ?? [])
        .map(moduleName => ({
          moduleName,
          key: level === 1 ? 0 : getBarycenter(parentsOf.get(moduleName) ?? [], indexInPrevious)
        }))
        .sort((left, right) =>
          left.key - right.key || compareText(left.moduleName, right.moduleName)
        )
        .map(entry => entry.moduleName)
      const ordered = putCycleStepsAtTheEnds(sorted, moduleName => isCycleStep(parent, moduleName))

      children.set(parent, ordered)
      // A module at a time: one module of a large graph can import more than a
      // call can take arguments.
      for (const moduleName of ordered) {
        column.push(moduleName)
      }
    }

    columns.push(column)
    previous = column
  }

  // How many rows each branch takes: a module on the last level drawn takes
  // one, the stub ending its branch standing beside it on the same row.
  const rows = new Map<string, number>()
  for (let level = depth; level >= 1; level -= 1) {
    for (const moduleName of columns[level - 1] ?? []) {
      const branchRows = (children.get(moduleName) ?? [])
        .reduce((total, child) => total + (rows.get(child) ?? 1), 0)
      rows.set(moduleName, Math.max(1, branchRows))
    }
  }

  // Rows top-down: each module halfway down the rows its branch takes, and the
  // whole side centred on the middle.
  const rowCenter = new Map<string, number>()
  const place = (moduleName: string, firstRow: number) => {
    rowCenter.set(moduleName, firstRow + (rows.get(moduleName) ?? 1) / 2)

    let row = firstRow
    for (const child of children.get(moduleName) ?? []) {
      place(child, row)
      row += rows.get(child) ?? 1
    }
  }
  place(center, -sumRows(columns[0] ?? [], rows) / 2)

  for (const [index, column] of columns.entries()) {
    const level = index + 1
    for (const moduleName of column) {
      const node: BracketModuleNode = {
        kind: 'module',
        id: getBracketModuleNodeId(side, moduleName),
        moduleName,
        side,
        level,
        position: {
          x: getColumnX(direction * level, m.moduleWidth, m),
          y: (rowCenter.get(moduleName) ?? 0) * rowPitchOf(m) - m.moduleHeight / 2
        },
        width: m.moduleWidth,
        height: m.moduleHeight,
        isRoot: params.isRoot(moduleName),
        isOnCycleWithCenter: params.isOnBothSides(moduleName)
      }
      layout.nodes.push(node)
      layout.modules.set(moduleName, node)
    }
  }

  // A branch that goes on past the last level drawn ends in a stub naming
  // the distinct modules one level further along it.
  for (const moduleName of columns[depth - 1] ?? []) {
    const branch = layout.modules.get(moduleName)
    const moduleNames = (neighbours.get(moduleName) ?? [])
      .filter(next => walk.distance.get(next) === depth + 1)
      .sort(compareText)
    if (!branch || moduleNames.length === 0) {
      continue
    }

    const stub: BracketStubNode = {
      kind: 'stub',
      id: getStubNodeId(side, moduleName),
      side,
      level: depth + 1,
      parentId: branch.id,
      moduleCount: moduleNames.length,
      moduleNames,
      position: {
        x: getColumnX(direction * (depth + 1), m.stubWidth, m),
        y: branch.position.y
      },
      width: m.stubWidth,
      height: m.moduleHeight
    }
    layout.nodes.push(stub)
    layout.stubs.push({ stub, branch })
  }

  return layout
}

/**
 * A parent's children with those on a reported cycle with it moved to the
 * ends, so their own lines into the parent pass above and below the upright
 * its other children share, never across it: the first half of them, in the
 * order they sorted in, above the rest, the others below — an odd one out
 * above if it sorted into the first half of all the children. As many above
 * as below keeps the parent, which stands halfway down its children, level
 * with the ones between. With no child of the bracket's own — no upright to
 * keep clear of — or no cycle among them, the order stands.
 */
function putCycleStepsAtTheEnds(sorted: readonly string[], isCycleStep: (moduleName: string) => boolean): string[] {
  const steps = sorted.filter(isCycleStep)
  if (steps.length === 0 || steps.length === sorted.length) {
    return [...sorted]
  }

  const oddOne = steps.length % 2 === 1 ? steps[(steps.length - 1) / 2] : undefined
  const isOddOneAbove = oddOne !== undefined && sorted.indexOf(oddOne) < sorted.length / 2
  const aboveCount = Math.floor(steps.length / 2) + (isOddOneAbove ? 1 : 0)
  return [
    ...steps.slice(0, aboveCount),
    ...sorted.filter(moduleName => !isCycleStep(moduleName)),
    ...steps.slice(aboveCount)
  ]
}

function sumRows(moduleNames: readonly string[], rows: ReadonlyMap<string, number>): number {
  return moduleNames.reduce((total, moduleName) => total + (rows.get(moduleName) ?? 1), 0)
}

/**
 * Where a module's parents stand in the column before, on average — its key
 * for its place among its siblings. Only parents in that column count; its
 * parent on the tree always is one.
 */
function getBarycenter(
  parents: readonly string[],
  indexInPrevious: ReadonlyMap<string, number>
): number {
  let sum = 0
  let count = 0
  for (const parent of parents) {
    const index = indexInPrevious.get(parent)
    if (index !== undefined) {
      sum += index
      count += 1
    }
  }

  return count > 0 ? sum / count : Number.POSITIVE_INFINITY
}

/**
 * The x of a node `width` wide in `column`: 0 is the middle, negative columns
 * run left and positive ones right. A node narrower than a column — a stub —
 * keeps to the column's side nearer the middle, beside the branch it ends.
 */
function getColumnX(column: number, width: number, m: BracketMetrics): number {
  if (column === 0) {
    return -m.centerWidth / 2
  }

  const reach = m.centerWidth / 2
    + m.columnGap
    + (Math.abs(column) - 1) * (m.moduleWidth + m.columnGap)

  return column > 0 ? reach : -reach - width
}

/** Every column drawn gets a heading, level with the others above the tallest column. */
function getLevelLabels(
  nodes: readonly BracketNode[],
  layouts: Readonly<Record<BracketSide, SideLayout>>,
  m: BracketMetrics
): BracketLevelNode[] {
  // One node at a time: a large graph draws more cards than a call can take
  // arguments.
  let top = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    top = Math.min(top, node.position.y)
  }
  const labels: BracketLevelNode[] = []

  for (const side of BRACKET_SIDES) {
    const { depth, modules } = layouts[side]
    const counts = new Map<number, number>()
    for (const node of modules.values()) {
      counts.set(node.level, (counts.get(node.level) ?? 0) + 1)
    }

    for (let level = 1; level <= depth; level += 1) {
      labels.push({
        kind: 'level',
        id: `level-${side}-${level}`,
        side,
        level,
        moduleCount: counts.get(level) ?? 0,
        position: {
          x: getColumnX(side === 'left' ? -level : level, m.moduleWidth, m),
          y: top - m.levelLabelGap - m.levelLabelHeight
        },
        width: m.moduleWidth,
        height: m.levelLabelHeight
      })
    }
  }

  return labels
}

/** The facts the card in the middle shows, read from the module itself. */
function getCenterStats(moduleName: string, mod: GraphOutputModule): BracketCenterStats {
  return {
    providers: mod.providers.length,
    controllers: mod.controllers.length,
    imports: mod.imports.length,
    exports: mod.exports.length,
    runnableNodeIds: [
      ...mod.providers
        .filter(provider => (provider.directRun?.methods.length ?? 0) > 0)
        .map(provider => getDirectRunNodeId('provider', moduleName, provider.name)),
      ...mod.controllers
        .filter(controller => (controller.directRun?.methods.length ?? 0) > 0)
        .map(controller => getDirectRunNodeId('controller', moduleName, controller.name))
    ]
  }
}

/** One import as a key: who imports, then what. JSON, so no name runs into another. */
function getImportKey(importer: string, imported: string): string {
  return JSON.stringify([importer, imported])
}

/**
 * Each import the graph's module cycles run through, with the cycles it is a
 * step of. A cycle's path names each module in import order, the last
 * repeating the first, so each module imports the next.
 */
function indexModuleCycles(
  cycles: GraphOutput['cycles']['modules'] | undefined
): Map<string, number[]> {
  const byImport = new Map<string, number[]>()

  for (const cycle of cycles ?? []) {
    for (let index = 0; index < cycle.path.length - 1; index += 1) {
      const importer = cycle.path[index]
      const imported = cycle.path[index + 1]
      if (importer === undefined || imported === undefined) {
        continue
      }

      const key = getImportKey(importer, imported)
      const ids = byImport.get(key) ?? []
      if (!ids.includes(cycle.id)) {
        ids.push(cycle.id)
      }
      byImport.set(key, ids)
    }
  }

  for (const ids of byImport.values()) {
    ids.sort((left, right) => left - right)
  }

  return byImport
}

/**
 * Every edge of the bracket, routed and labelled.
 *
 * Each import is drawn once per side it shows on. On the left a module's
 * imports are the side's next level; on the right the modules importing it
 * are. The walk's first way to a module is its tree edge, any other import
 * between two modules drawn on that side a dashed link, and an import back
 * into the middle is left to the other side, where the module making it
 * stands one level in, joined to the middle by its tree edge.
 */
function routeEdges(params: {
  center: BracketCenterNode
  importsItself: boolean
  layouts: Readonly<Record<BracketSide, SideLayout>>
  walks: Readonly<Record<BracketSide, SideWalk>>
  adjacency: Adjacency
  cycleIdsByImport: ReadonlyMap<string, number[]>
  /** Every node drawn, which a link's label must not cover. */
  nodes: readonly BracketNode[]
  /** Collects every point a route turns at or passes, for the bounds. */
  routePoints: EdgePoint[]
  m: BracketMetrics
}): BracketEdge[] {
  const { center, layouts, walks, adjacency, cycleIdsByImport, m } = params
  const cardsByColumn = new Map<number, CircularEdgeRect[]>()
  for (const node of params.nodes) {
    if (node.kind === 'module' || node.kind === 'stub') {
      const column = getColumn(node)
      const cards = cardsByColumn.get(column) ?? []
      cards.push({ x: node.position.x, y: node.position.y, width: node.width, height: node.height })
      cardsByColumn.set(column, cards)
    }
  }
  const router = createRouter(params.routePoints, cardsByColumn, m)
  const edges: RoutedEdge[] = []
  const cycleIdsOf = (importer: string, imported: string) =>
    [...(cycleIdsByImport.get(getImportKey(importer, imported)) ?? [])]

  if (params.importsItself) {
    edges.push(router.selfLoop(center, null, cycleIdsOf(center.moduleName, center.moduleName)))
  }

  for (const side of BRACKET_SIDES) {
    const { modules, stubs } = layouts[side]
    const walk = walks[side]
    // On the left the parent imports the module; on the right the module
    // imports its parent.
    const routeStep = (step: CycleStep, cyclePort?: number) => side === 'left'
      ? router.route({ kind: 'tree', side, source: step.node, target: step.parent, cycleIds: step.cycleIds, cyclePort })
      : router.route({ kind: 'tree', side, source: step.parent, target: step.node, cycleIds: step.cycleIds, cyclePort })

    // The bracket's own connectors first; those on a reported cycle after
    // them, each into a port of its own.
    const cycleSteps: CycleStep[] = []
    for (const node of modules.values()) {
      const parentName = walk.parent.get(node.moduleName)
      const parent = parentName === center.moduleName
        ? center
        : modules.get(parentName ?? '')
      if (!parent) {
        continue
      }

      const cycleIds = side === 'left'
        ? cycleIdsOf(parent.moduleName, node.moduleName)
        : cycleIdsOf(node.moduleName, parent.moduleName)
      if (cycleIds.length > 0) {
        cycleSteps.push({ node, parent, cycleIds })
      } else {
        edges.push(routeStep({ node, parent, cycleIds }))
      }
    }

    for (const step of assignCyclePorts(cycleSteps, m)) {
      edges.push(routeStep(step, step.port))
    }

    for (const node of modules.values()) {
      for (const next of adjacency[side].get(node.moduleName) ?? []) {
        if (next === node.moduleName) {
          edges.push(router.selfLoop(node, side, cycleIdsOf(next, next)))
          continue
        }

        // The middle is never in `modules`: an import back into it is drawn on
        // the other side. A module not drawn here has no node to join.
        const other = modules.get(next)
        if (!other || walk.parent.get(next) === node.moduleName) {
          continue
        }

        edges.push(side === 'left'
          ? router.route({
              kind: 'link',
              side,
              source: other,
              target: node,
              cycleIds: cycleIdsOf(node.moduleName, next)
            })
          : router.route({
              kind: 'link',
              side,
              source: node,
              target: other,
              cycleIds: cycleIdsOf(next, node.moduleName)
            }))
      }
    }

    for (const { stub, branch } of stubs) {
      edges.push(side === 'left'
        ? router.route({ kind: 'stub', side, source: stub, target: branch, cycleIds: [] })
        : router.route({ kind: 'stub', side, source: branch, target: stub, cycleIds: [] }))
    }
  }

  return labelEdges(edges, params.nodes, m)
}

/** A connector of the bracket on a reported cycle: a module and the one the walk came from. */
type CycleStep = {
  node: BracketModuleNode
  parent: BracketCenterNode | BracketModuleNode
  cycleIds: number[]
}

/**
 * Where each step of a cycle comes into the module nearer the middle: a port
 * of its own on that module's side — level with the module it comes from when
 * that height is on the side, so the connector runs straight across, else as
 * near it as the side allows — above the middle the bracket's own connector
 * comes in by for a module standing higher, below it for one standing level
 * or lower, and never nearer the middle, or another port, than a step. On the
 * tall card in the middle the ports spread down its height. The module
 * furthest away takes the port furthest out, and is routed first, to the lane
 * nearest the module it comes into — so a module's cycle connectors nest, and
 * never cross one another.
 */
function assignCyclePorts(steps: readonly CycleStep[], m: BracketMetrics): Array<CycleStep & { port: number }> {
  const byParent = new Map<string, CycleStep[]>()
  for (const step of steps) {
    const group = byParent.get(step.parent.id) ?? []
    group.push(step)
    byParent.set(step.parent.id, group)
  }

  const placed: Array<CycleStep & { port: number }> = []
  for (const group of byParent.values()) {
    const parent = group[0]?.parent
    if (!parent) {
      continue
    }

    const middle = parent.position.y + parent.height / 2
    const step = parent.kind === 'center' ? m.portStepCenter : m.portStepModule
    const reach = parent.height / 2 - (parent.kind === 'center' ? m.centerPortCornerClearance : m.portCornerClearance)
    const distanceOf = (entry: CycleStep) => entry.node.position.y + entry.node.height / 2 - middle

    for (const isAbove of [true, false]) {
      const half = group
        .filter(entry => (distanceOf(entry) < 0) === isAbove)
        .sort((first, second) =>
          Math.abs(distanceOf(second)) - Math.abs(distanceOf(first))
          || compareText(first.node.id, second.node.id))
      // A step apart, or as far apart as the side has room for.
      const spacing = half.length > 1 ? Math.min(step, (reach - step) / (half.length - 1)) : step

      let outermost = reach
      for (const [index, entry] of half.entries()) {
        const innermost = step + (half.length - 1 - index) * spacing
        const offset = Math.max(innermost, Math.min(outermost, Math.abs(distanceOf(entry))))
        placed.push({ ...entry, port: isAbove ? -offset : offset })
        outermost = offset - spacing
      }
    }
  }

  return placed
}

/**
 * Labels every edge on a reported cycle with its `#ids`.
 *
 * A tree edge's label goes where it settled while routing: on the stretch
 * beside the module further out, which only that edge runs along. A loop's
 * goes beside the loop. A dashed link turns in a lane beside other lanes and
 * close to a column of cards, so its label is placed after those: on its own
 * upright, reaching from it into the open gap — away from the cards the lane
 * hugs — at the first height, from the middle out, where it covers no card and
 * no label placed before it.
 */
function labelEdges(routed: readonly RoutedEdge[], nodes: readonly BracketNode[], m: BracketMetrics): BracketEdge[] {
  const taken: CircularEdgeRect[] = nodes.map(node => ({
    x: node.position.x,
    y: node.position.y,
    width: node.width,
    height: node.height
  }))

  for (const { edge, label } of routed) {
    if (edge.cycleIds.length > 0 && label) {
      const box = getLabelBox(label, formatCircularEdgeLabel(edge.cycleIds), m)
      // Where the gaps are too narrow for a label to cover only a little,
      // one that would cover a card or another label is left off.
      if (!m.isCrowdedLabelDrawn && taken.some(other => boxesOverlap(box, other))) {
        continue
      }
      edge.label = label
      taken.push(box)
    }
  }

  for (const { edge, lane, points } of routed) {
    if (edge.cycleIds.length === 0 || !lane) {
      continue
    }

    const text = formatCircularEdgeLabel(edge.cycleIds)
    edge.label = placeLaneLabel({ lane, route: points, text, taken, m })
    if (edge.label) {
      taken.push(getLabelBox(edge.label, text, m))
    }
  }

  return routed.map(({ edge }) => edge)
}

type RoutedNode = BracketCenterNode | BracketModuleNode | BracketStubNode

/**
 * An edge as the router leaves it: the points its route runs through, and
 * where its label goes — settled already, for a route with a stretch only it
 * runs along, or to be placed along its `lane`.
 */
type RoutedEdge = {
  edge: BracketEdge
  points: EdgePoint[]
  label: CircularLabelSpot | null
  lane: LabelLane | null
}

/**
 * A link's upright: where along it a label may sit, and which way the label
 * reaches from it — away from the cards the lane runs beside, or both ways
 * from an upright halfway across a gap.
 */
type LabelLane = {
  x: number
  top: number
  bottom: number
  reach: 'left' | 'right' | 'both'
}

/** Between a label and the lane it reaches from, and around a label it must clear. */
const LANE_LABEL_GAP = 3
const LANE_LABEL_CLEARANCE = 3
/** How far apart the heights a label is tried at along its lane are. */
const LANE_LABEL_STEP = 6

/**
 * A link's label: beside its lane, reaching away from the cards the lane
 * hugs, at the first height from the lane's middle out that is clear; else
 * centred on the first clear spot along the rest of its route — a lane with
 * both ends on one row has no height to offer — longest stretch first, each
 * from its middle out; else at the lane's middle, covering what it must — or,
 * at a size whose gaps leave nothing it could cover only a little of, nowhere.
 */
function placeLaneLabel(params: {
  lane: LabelLane
  route: readonly EdgePoint[]
  text: string
  taken: readonly CircularEdgeRect[]
  m: BracketMetrics
}): CircularLabelSpot | null {
  const { lane, route, text, taken, m } = params
  const spotAt = (y: number): CircularLabelSpot => {
    switch (lane.reach) {
      case 'left':
        return {
          labelX: lane.x - LANE_LABEL_GAP,
          labelY: y,
          labelTransform: 'translate(-100%, -50%)',
          labelAnchor: { x: 1, y: 0.5 }
        }
      case 'right':
        return {
          labelX: lane.x + LANE_LABEL_GAP,
          labelY: y,
          labelTransform: 'translate(0, -50%)',
          labelAnchor: { x: 0, y: 0.5 }
        }
      case 'both':
        return { labelX: lane.x, labelY: y, ...LABEL_CENTERED }
      default: {
        const _exhaustive: never = lane.reach
        return _exhaustive
      }
    }
  }

  const middle = (lane.top + lane.bottom) / 2
  const heights = [middle]
  for (let step = LANE_LABEL_STEP; middle - step >= lane.top; step += LANE_LABEL_STEP) {
    heights.push(middle - step, middle + step)
  }

  const candidates = [
    ...heights.map(spotAt),
    ...getStretchSpots(route).map(point => ({ labelX: point.x, labelY: point.y, ...LABEL_CENTERED }))
  ]
  for (const spot of candidates) {
    const box = grow(getLabelBox(spot, text, m), LANE_LABEL_CLEARANCE)
    if (!taken.some(other => boxesOverlap(box, other))) {
      return spot
    }
  }

  return m.isCrowdedLabelDrawn ? spotAt(middle) : null
}

/** Points along a route a label may be centred on: longest stretch first, each from its middle out. */
function getStretchSpots(route: readonly EdgePoint[]): EdgePoint[] {
  const stretches = route
    .slice(1)
    .map((end, index) => {
      const start = route[index] ?? end
      return { start, end, length: Math.hypot(end.x - start.x, end.y - start.y) }
    })
    .filter(stretch => stretch.length > 0)
    .sort((left, right) => right.length - left.length)

  return stretches.flatMap(({ start, end, length }) => {
    const offsets = [0]
    for (let offset = LANE_LABEL_STEP; offset <= length / 2; offset += LANE_LABEL_STEP) {
      offsets.push(offset, -offset)
    }

    return offsets.map((offset) => {
      const t = 0.5 + offset / length
      return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
    })
  })
}

/** How far a channel keeps from the cards it runs between. */
const CHANNEL_CLEARANCE = 2

/**
 * A channel's working lengths for one size: where in a gap a link may cross
 * — its middle first, then a step to either side — what running a step off
 * the middle costs in detour (more than the step saves, so a link takes the
 * middle of a free gap whenever one is near), and the longest way round a
 * link takes to keep off another link's crossing.
 */
function channelOf(m: BracketMetrics) {
  return {
    halfRowGap: m.rowGap / 2,
    step: m.channelStep,
    shifts: [0, -m.channelStep, m.channelStep] as const,
    shiftCost: m.channelStep * 2 + 1,
    detourLimit: rowPitchOf(m) * 4
  }
}

/** Where a link reaching back past the next column crosses the columns between. */
type Crossing = { y: number, left: number, right: number }

/**
 * A run of columns a link crosses, as a channel through them is looked for:
 * the heights their cards block, clearance included — open spans, top to
 * bottom, merged where they overlap, so whether a height is clear of every
 * card is one binary search — and the middles of the gaps above and below
 * each card, once each, since cards level across the columns share them.
 */
type CrossedColumns = {
  blocked: ReadonlyArray<readonly [number, number]>
  gapMiddles: readonly number[]
}

function getCrossedColumns(cards: readonly CircularEdgeRect[], m: BracketMetrics): CrossedColumns {
  const { halfRowGap } = channelOf(m)
  const spans = cards
    .map((card): [number, number] => [card.y - CHANNEL_CLEARANCE, card.y + card.height + CHANNEL_CLEARANCE])
    .sort((above, below) => above[0] - below[0])
  const blocked: Array<[number, number]> = []

  for (const span of spans) {
    const last = blocked.at(-1)
    // Open spans that only touch leave the height they touch at clear.
    if (last && span[0] < last[1]) {
      last[1] = Math.max(last[1], span[1])
    } else {
      blocked.push(span)
    }
  }

  const gapMiddles = new Set<number>()
  for (const card of cards) {
    gapMiddles.add(card.y - halfRowGap)
    gapMiddles.add(card.y + card.height + halfRowGap)
  }

  return { blocked, gapMiddles: [...gapMiddles] }
}

/**
 * The height a link crosses `columns` at, between `left` and `right`, without
 * passing behind any of their cards: the height it is going at when that is
 * free — anywhere between its two ends costs the same length — else the free
 * channel nearest it, halfway between two rows, above the top row or below
 * the bottom one. It keeps off the heights other links already cross at, and
 * the `stubs` other edges leave the columns at its two ends by, moving to
 * another gap or a step to one side of the middle of this one; only when that
 * would take it far out of its way does it share the nearest channel. Above
 * the topmost card is always free, so there is always one.
 */
function findChannel(params: {
  columns: CrossedColumns
  crossings: readonly Crossing[]
  /**
   * The heights edges leave the columns at the link's two ends by, each
   * column's in ascending order, but for the height of the link's own card.
   */
  stubs: ReadonlyArray<{ heights: readonly number[], own: number }>
  fromY: number
  toY: number
  left: number
  right: number
  m: BracketMetrics
}): number {
  const { columns: { blocked, gapMiddles }, crossings, stubs, fromY, toY, left, right } = params
  const channel = channelOf(params.m)
  const isClearOfCards = (y: number) => {
    let low = 0
    let high = blocked.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const span = blocked[middle]
      if (!span) {
        return true
      }
      if (y <= span[0]) {
        high = middle - 1
      } else if (y >= span[1]) {
        low = middle + 1
      } else {
        return false
      }
    }
    return true
  }
  const nearby = crossings.filter(crossing => crossing.left < right && crossing.right > left)
  const isClearOfLinks = (y: number) =>
    !stubs.some(stub => hasValueNear(stub.heights, y, channel.step, stub.own))
    && !nearby.some(crossing => Math.abs(crossing.y - y) < channel.step)

  let nearest: { y: number, cost: number } | null = null
  let nearestFree: { y: number, cost: number } | null = null
  const isBetter = (y: number, cost: number, than: { y: number, cost: number } | null) =>
    !than
    || cost < than.cost
    || (cost === than.cost && Math.abs(y - fromY) < Math.abs(than.y - fromY))

  for (const middle of [fromY, toY, ...gapMiddles]) {
    for (const shift of channel.shifts) {
      const y = middle + shift
      if (!isClearOfCards(y)) {
        continue
      }

      const cost = (shift === 0 ? 0 : channel.shiftCost) + Math.abs(y - fromY) + Math.abs(y - toY)
      if (isBetter(y, cost, nearest)) {
        nearest = { y, cost }
      }
      if (isBetter(y, cost, nearestFree) && isClearOfLinks(y)) {
        nearestFree = { y, cost }
      }
    }
  }

  if (nearestFree && nearest && nearestFree.cost <= nearest.cost + channel.detourLimit) {
    return nearestFree.y
  }
  return nearest?.y ?? fromY
}

/**
 * Whether any value of `sorted`, in ascending order, lies less than `distance`
 * from `y` — other than `except`.
 */
function hasValueNear(sorted: readonly number[], y: number, distance: number, except: number): boolean {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((sorted[middle] ?? Number.POSITIVE_INFINITY) <= y - distance) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  for (let index = low; index < sorted.length; index += 1) {
    const value = sorted[index] ?? Number.POSITIVE_INFINITY
    if (value >= y + distance) {
      return false
    }
    if (value !== except) {
      return true
    }
  }
  return false
}

function grow(rect: CircularEdgeRect, by: number): CircularEdgeRect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

/** Whether two boxes share any area: touching edges do not count. */
function boxesOverlap(left: CircularEdgeRect, right: CircularEdgeRect): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height
}

/** A node's column: 0 for the middle, negative to its left. */
function getColumn(node: RoutedNode): number {
  if (node.kind === 'center') {
    return 0
  }

  return node.side === 'left' ? -node.level : node.level
}

/**
 * Routes edges across the bracket. Every edge leaves and enters a node by its
 * left or right side and turns only at right angles:
 *
 * - A tree or stub edge into the next column out turns halfway across the
 *   gap, so the branches of one module share one upright, the way a bracket
 *   joins them. A tree edge on a reported cycle is the exception: it turns in
 *   a lane beside the module nearer the middle and comes into a port of its
 *   own on that module's side (`assignCyclePorts`), so the cycle's colour
 *   runs unbroken from one module to the next.
 * - A link into the next column out turns in a lane beside that column
 *   instead — halfway across it would run along another module's upright —
 *   and crosses the gap level with the module nearer the middle, where only
 *   that module's own branches run.
 * - A link back towards the middle leaves its module by the side facing the
 *   middle, turns in a lane of its own in the gap beside the column it ends
 *   in, and comes into that column from its far side. One reaching back past
 *   the next column first turns beside its own and crosses the columns
 *   between in a free channel between their rows (`findChannel`), so it never
 *   passes behind their cards.
 * - A link within one column runs round the column's outer side, in a lane of
 *   its own.
 *
 * Lanes keep to either side of a gap's middle, where the brackets turn, each
 * family of them beside one column — so no lane runs along an upright. Two
 * links share a lane only where they never meet in it (`takeLane`), so edges
 * that join no card in common never run along one another while a gap has
 * lanes to spare.
 */
function createRouter(
  routePoints: EdgePoint[],
  /** The cards standing in each column, by column. */
  cardsByColumn: ReadonlyMap<number, readonly CircularEdgeRect[]>,
  m: BracketMetrics
) {
  /** Each family of lanes beside a column, and the heights each lane is taken over. */
  const lanes = new Map<string, Array<Array<readonly [number, number]>>>()
  const crossings: Crossing[] = []
  /** Where each column's cards send edges into the gaps beside it: their middles, top to bottom. */
  const stubHeightsByColumn = new Map(
    [...cardsByColumn.entries()].map(([column, cards]) => [
      column,
      cards.map(card => card.y + card.height / 2).sort((above, below) => above - below)
    ])
  )
  /** Each run of columns links cross, worked out once for all of them. */
  const crossedByRun = new Map<string, CrossedColumns>()
  /** The columns strictly between `nearer` and `further`, by their column numbers. */
  const getCrossed = (nearer: number, further: number): CrossedColumns => {
    const key = `${nearer}:${further}`
    const known = crossedByRun.get(key)
    if (known) {
      return known
    }

    const cards: CircularEdgeRect[] = []
    for (let column = nearer + 1; column < further; column += 1) {
      // A card at a time: a column of a large graph holds more than a call
      // can take arguments.
      for (const card of cardsByColumn.get(column) ?? []) {
        cards.push(card)
      }
    }
    const crossed = getCrossedColumns(cards, m)
    crossedByRun.set(key, crossed)
    return crossed
  }

  /**
   * How far from its column a link turns, between `fromY` and `toY`: in the
   * lane nearest the column that no other link turns in over those heights,
   * or — beside a column too crowded for that — the one fewest others share.
   * A gap with no column beyond it has no brackets turning in its middle, so
   * there lanes go on out as far as the links need.
   */
  const takeLane = (key: string, fromY: number, toY: number, isOuterGap = false): number => {
    const top = Math.min(fromY, toY) - m.laneClearance
    const bottom = Math.max(fromY, toY) + m.laneClearance
    const family = lanes.get(key) ?? []
    lanes.set(key, family)
    const meets = ([start, end]: readonly [number, number]) => start < bottom && end > top

    let chosen = family.findIndex(taken => !taken.some(meets))
    if (chosen === -1 && (isOuterGap || family.length < m.laneCount)) {
      chosen = family.length
      family.push([])
    }
    if (chosen === -1) {
      let fewestMet = Number.POSITIVE_INFINITY
      for (const [index, taken] of family.entries()) {
        const met = taken.filter(meets).length
        if (met < fewestMet) {
          chosen = index
          fewestMet = met
        }
      }
    }

    family[chosen]?.push([top, bottom])
    return chosen * m.laneStep + m.laneStart
  }
  /** Whether nothing stands beyond a column, on the side away from the middle. */
  const isOutermost = (side: BracketSide, column: number) =>
    !cardsByColumn.has(side === 'left' ? column - 1 : column + 1)
  /** Whether a card of `column`, other than the one whose middle is `own`, has its middle near `y`. */
  const isLevelWithAnother = (column: number, y: number, own: number) =>
    hasValueNear(stubHeightsByColumn.get(column) ?? [], y, m.laneStep, own)

  /**
   * Where a link between neighbouring columns turns, given the points it
   * leaves and enters by on the module nearer the middle (`inner`) and the one
   * further out (`outer`). It turns in a lane beside the column further out,
   * crossing the gap level with the module nearer the middle, where only that
   * module's own connectors run. Where a module further out stands level with
   * that one, the links into it would run along the crossing: the link turns
   * beside the column nearer the middle instead, and crosses level with the
   * module further out — unless a module stands level with that one too.
   */
  const turnBetweenNeighbours = (
    side: BracketSide,
    inner: EdgePoint,
    outer: EdgePoint,
    innerColumn: number,
    outerColumn: number
  ): { x: number, reach: LabelLane['reach'] } => {
    // From the column further out towards the middle.
    const inwards = side === 'left' ? 1 : -1
    const hugsInner = isLevelWithAnother(outerColumn, inner.y, outer.y)
      && !isLevelWithAnother(innerColumn, outer.y, inner.y)
    if (hugsInner) {
      const offset = takeLane(`same:${side}:${innerColumn}`, inner.y, outer.y)
      return { x: inner.x - inwards * offset, reach: side }
    }

    const offset = takeLane(`back:${side}:${Math.min(innerColumn, outerColumn)}`, inner.y, outer.y)
    return { x: outer.x + inwards * offset, reach: side === 'left' ? 'right' : 'left' }
  }

  function route(params: {
    kind: Exclude<BracketEdgeKind, 'self'>
    side: BracketSide
    source: RoutedNode
    target: RoutedNode
    cycleIds: number[]
    /**
     * For a connector of the bracket on a reported cycle: how far up (less
     * than 0) or down its port is on the side of the module nearer the middle.
     */
    cyclePort?: number
  }): RoutedEdge {
    const { kind, side, source, target, cycleIds, cyclePort } = params
    const sourceColumn = getColumn(source)
    const targetColumn = getColumn(target)
    let points: EdgePoint[]
    let handles: readonly [BracketHandle, BracketHandle]
    let label: CircularLabelSpot | null = null
    let lane: LabelLane | null = null
    const upright = (x: number, from: EdgePoint, to: EdgePoint, reach: LabelLane['reach']): LabelLane => ({
      x,
      top: Math.min(from.y, to.y),
      bottom: Math.max(from.y, to.y),
      reach
    })

    if (sourceColumn < targetColumn && kind === 'link') {
      // A link into the next column out that is no branch of the bracket
      // would, turning halfway across, run along the upright of another
      // module's branches and read as one of them: it turns in a lane instead
      // (`turnBetweenNeighbours`).
      const from = rightOf(source)
      const to = leftOf(target)
      const turn = side === 'left'
        ? turnBetweenNeighbours(side, to, from, targetColumn, sourceColumn)
        : turnBetweenNeighbours(side, from, to, sourceColumn, targetColumn)
      points = from.y === to.y
        ? [from, to]
        : [from, { x: turn.x, y: from.y }, { x: turn.x, y: to.y }, to]
      handles = ['right-source', 'left-target']
      lane = upright(turn.x, from, to, turn.reach)
    } else if (sourceColumn < targetColumn && cyclePort !== undefined) {
      // A step of a reported cycle leaves the bracket's shared upright, so its
      // colour is not lost in the branches' own: it turns in a lane beside the
      // module nearer the middle and comes into a port of its own on that
      // module's side. Its label sits on the stretch beside the module further
      // out, which only it runs along.
      handles = ['right-source', 'left-target']
      const isLevel = rightOf(source).y === leftOf(target).y
      if (isLevel) {
        // Level with the module it comes into, it would run along the middle
        // the bracket's connectors share: it runs straight across instead, as
        // far down both sides as its port is.
        const from = { x: rightOf(source).x, y: rightOf(source).y + cyclePort }
        const to = { x: leftOf(target).x, y: leftOf(target).y + cyclePort }
        points = [from, to]
        label = side === 'left'
          ? { labelX: from.x + m.treeLabelInset, labelY: from.y, ...LABEL_CENTERED }
          : { labelX: to.x - m.treeLabelInset, labelY: to.y, ...LABEL_CENTERED }
      } else if (side === 'left') {
        // The module nearer the middle is the one importing: the target.
        const from = rightOf(source)
        const port = { x: leftOf(target).x, y: leftOf(target).y + cyclePort }
        const turn = port.x - takeLane(`same:${side}:${targetColumn}`, from.y, port.y)
        points = from.y === port.y
          ? [from, port]
          : [from, { x: turn, y: from.y }, { x: turn, y: port.y }, port]
        label = { labelX: from.x + m.treeLabelInset, labelY: from.y, ...LABEL_CENTERED }
      } else {
        // The module nearer the middle is the one imported: the source.
        const port = { x: rightOf(source).x, y: rightOf(source).y + cyclePort }
        const to = leftOf(target)
        const turn = port.x + takeLane(`same:${side}:${sourceColumn}`, port.y, to.y)
        points = port.y === to.y
          ? [port, to]
          : [port, { x: turn, y: port.y }, { x: turn, y: to.y }, to]
        label = { labelX: to.x - m.treeLabelInset, labelY: to.y, ...LABEL_CENTERED }
      }
    } else if (sourceColumn < targetColumn) {
      const from = rightOf(source)
      const to = leftOf(target)
      const turn = (from.x + to.x) / 2
      points = from.y === to.y
        ? [from, to]
        : [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = ['right-source', 'left-target']
      // A tree edge's label goes on the stretch only it runs along: beside the
      // module further out, before the branches of its parent join.
      if (kind === 'tree') {
        const spot = side === 'left'
          ? { x: from.x + m.treeLabelInset, y: from.y }
          : { x: to.x - m.treeLabelInset, y: to.y }
        label = { labelX: spot.x, labelY: spot.y, ...LABEL_CENTERED }
      }
    } else if (sourceColumn > targetColumn) {
      const from = leftOf(source)
      const to = rightOf(target)
      const turnKey = `back:${side}:${targetColumn}`
      // On the left the lane hugs the column it ends in, on the right the
      // column across the gap from it: its label reaches away from either.
      const turnAt = (offset: number) => side === 'left' ? to.x + offset : to.x + m.columnGap - offset
      const reach = side === 'left' ? 'right' : 'left'
      handles = ['left-source', 'right-target']

      if (sourceColumn - targetColumn === 1) {
        const turn = side === 'left'
          ? turnBetweenNeighbours(side, from, to, sourceColumn, targetColumn)
          : turnBetweenNeighbours(side, to, from, targetColumn, sourceColumn)
        points = [from, { x: turn.x, y: from.y }, { x: turn.x, y: to.y }, to]
        lane = upright(turn.x, from, to, turn.reach)
      } else {
        // Further than the next column, a straight run would pass behind the
        // cards of the columns between and read as an edge of theirs. It
        // crosses them in the free channel between their rows nearest the
        // way it is going — off the middles of the other cards at its two
        // ends, where their edges leave them — turning into it in a lane
        // beside its own column, of the family already turning there, and
        // out of it beside the column it ends in.
        const channel = findChannel({
          columns: getCrossed(targetColumn, sourceColumn),
          crossings,
          stubs: [
            { heights: stubHeightsByColumn.get(sourceColumn) ?? [], own: from.y },
            { heights: stubHeightsByColumn.get(targetColumn) ?? [], own: to.y }
          ],
          fromY: from.y,
          toY: to.y,
          left: to.x,
          right: from.x,
          m
        })
        const exit = side === 'left'
          ? from.x - takeLane(`same:${side}:${sourceColumn}`, from.y, channel, isOutermost(side, sourceColumn))
          : from.x - takeLane(`back:${side}:${sourceColumn - 1}`, from.y, channel)
        const turn = turnAt(takeLane(turnKey, channel, to.y))
        crossings.push({ y: channel, left: Math.min(exit, turn), right: Math.max(exit, turn) })
        points = [
          from,
          { x: exit, y: from.y },
          { x: exit, y: channel },
          { x: turn, y: channel },
          { x: turn, y: to.y },
          to
        ]
        lane = upright(turn, { x: turn, y: channel }, to, reach)
      }
    } else {
      const from = side === 'left' ? leftOf(source) : rightOf(source)
      const to = side === 'left' ? leftOf(target) : rightOf(target)
      const offset = takeLane(`same:${side}:${sourceColumn}`, from.y, to.y, isOutermost(side, sourceColumn))
      const turn = side === 'left' ? from.x - offset : from.x + offset
      points = [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = side === 'left'
        ? ['left-source', 'left-target']
        : ['right-source', 'right-target']
      lane = upright(turn, from, to, side)
    }

    routePoints.push(...points)

    return {
      edge: {
        id: getEdgeId(kind, source.id, target.id),
        source: source.id,
        target: target.id,
        sourceHandle: handles[0],
        targetHandle: handles[1],
        kind,
        side,
        cycleIds,
        path: roundedPolylinePath(points, m.cornerRadius),
        label: null
      },
      points,
      label,
      lane
    }
  }

  /**
   * A module importing itself: a loop out of its outer side — or, for the
   * module in the middle, out of its top, clear of both sides' brackets —
   * drawn as the module deep dive draws one, or smaller, drawn in towards its
   * handle, where the gap beside the card is narrower than that loop reaches
   * (`selfLoopScale`).
   */
  function selfLoop(
    node: BracketCenterNode | BracketModuleNode,
    side: BracketSide | null,
    cycleIds: number[]
  ): RoutedEdge {
    const loopSide: CircularEdgeSide = side ?? 'top'
    const anchor = loopSide === 'top'
      ? { x: node.position.x + node.width / 2, y: node.position.y }
      : loopSide === 'left' ? leftOf(node) : rightOf(node)
    const geometry = getCircularEdgeGeometry({
      sourceX: anchor.x,
      sourceY: anchor.y,
      sourcePosition: loopSide,
      targetX: anchor.x,
      targetY: anchor.y,
      targetPosition: loopSide,
      isSelfLoop: true
    })
    const s = m.selfLoopScale
    const inwards = (point: EdgePoint): EdgePoint => s === 1
      ? point
      : { x: anchor.x + (point.x - anchor.x) * s, y: anchor.y + (point.y - anchor.y) * s }
    const [start, first, second, end] = geometry.points
    const points = [inwards(start), inwards(first), inwards(second), inwards(end)] as const
    const path = s === 1
      ? geometry.path
      : `M ${points[0].x},${points[0].y} C ${points[1].x},${points[1].y} ${points[2].x},${points[2].y} ${points[3].x},${points[3].y}`
    const labelSpot = inwards({ x: geometry.labelX, y: geometry.labelY })

    // A Bézier curve stays inside its control points.
    routePoints.push(...points)

    return {
      edge: {
        id: getEdgeId('self', node.id, node.id),
        source: node.id,
        target: node.id,
        sourceHandle: 'right-source',
        targetHandle: 'right-target',
        kind: 'self',
        side,
        cycleIds,
        path,
        label: null
      },
      points: [...points],
      label: {
        labelX: labelSpot.x,
        labelY: labelSpot.y,
        labelTransform: geometry.labelTransform,
        labelAnchor: geometry.labelAnchor
      },
      lane: null
    }
  }

  return { route, selfLoop }
}

function getEdgeId(kind: BracketEdgeKind, source: string, target: string): string {
  return `${kind}:${JSON.stringify([source, target])}`
}

function leftOf(node: NodeBox): EdgePoint {
  return { x: node.position.x, y: node.position.y + node.height / 2 }
}

function rightOf(node: NodeBox): EdgePoint {
  return { x: node.position.x + node.width, y: node.position.y + node.height / 2 }
}

/**
 * The box holding every node, every point an edge's route passes and every
 * cycle label, at the size a label is drawn on a canvas at its own scale.
 */
function getBracketBounds(
  nodes: readonly BracketNode[],
  edges: readonly BracketEdge[],
  routePoints: readonly EdgePoint[],
  m: BracketMetrics
): CircularEdgeRect {
  const rects: CircularEdgeRect[] = [
    ...nodes.map(node => ({
      x: node.position.x,
      y: node.position.y,
      width: node.width,
      height: node.height
    })),
    ...routePoints.map(point => ({ x: point.x, y: point.y, width: 0, height: 0 }))
  ]

  for (const edge of edges) {
    if (edge.label) {
      rects.push(getLabelBox(edge.label, formatCircularEdgeLabel(edge.cycleIds), m))
    }
  }

  return unionRects(rects) ?? { x: 0, y: 0, width: 0, height: 0 }
}

/** Code-unit order, the same everywhere, unlike a locale's. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
