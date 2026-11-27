/**
 * Where a module's page is, and what its address says it shows.
 *
 * `/view/navigator/modules/<id>` is one module's page, `<id>` its name through
 * `encodeModuleId`. Its query holds the rest, so an address can be shared and
 * a reload opens the page as it was. A change of any of it replaces the
 * address rather than adding a step to Back, which is for places: the module
 * re-centred from, or the graph the page was opened from.
 *
 * The query:
 *
 * - `view=inside` — what the module declares: its providers, its controllers,
 *   and where its dependencies come from. Without it, the page shows the
 *   module among the others: what it needs and what needs it, as a bracket.
 * - `left`, `right` — how many levels each side of that bracket shows, left
 *   out at the default.
 * - `direct-run-on` — the provider or controller whose Direct Run panel is
 *   open, by its graph node id. Direct Run belongs to the inside view, so an
 *   address carrying it opens there, `view` or not — as a deep-dive link from
 *   before the page had two views does.
 *
 * A documentation preview cannot open the page directly: the page draws the
 * graph the tab holds, and a preview's graph is not the tab's until `/view`
 * hands it over. So a preview links to `/view?preview=true&module=<name>`,
 * with the page's own query beside it, and `/view` sends the visitor on to the
 * module's page once the graph is in place.
 */
import type { GraphOutput } from 'nest-graph-inspector'
import { findDirectRunTarget } from './direct-run-provider.ts'
import { getModuleNodeId } from './graph-viewer-focus.ts'
import type { BracketFraming } from './module-bracket-viewport.ts'
import { DEFAULT_BRACKET_DEPTH, type BracketSide } from './module-dependency-bracket.ts'
import { encodeModuleId } from './module-id.ts'
import {
  PREVIEW_MODULE_PARAMETER,
  readFirstQueryValue as readFirst,
  readHandedOverModule
} from './module-page-hand-off.ts'

/** The two views of a module's page. */
export type ModulePageView = 'dependencies' | 'inside'

/** What a module page's address says, every part read or defaulted. */
export type ModulePageState = {
  view: ModulePageView
  /** How many levels each side of the bracket is asked to show. */
  depth: Record<BracketSide, number>
  /** Node id of the provider or controller whose Direct Run panel is open. */
  directRunOn: string | null
}

/** What to put in a module page's address: anything left out is the default. */
export type ModulePageStateInput = {
  view?: ModulePageView
  depth?: Partial<Record<BracketSide, number>>
  directRunOn?: string | null
}

/** A route location, as `navigateTo` and `NuxtLink` take one. */
export type ModulePageLocation = {
  path: string
  query: Record<string, string>
}

/**
 * Where the links of a module's dependency bracket lead.
 *
 * - `pages` — the bracket is a module's page in the viewer. Another module is
 *   a link to its own page, a new step Back returns from; Direct Run is a
 *   link to this module's inside view, in place of the address.
 * - `in-place` — the bracket is a demo on a page of its own, which keeps the
 *   visitor there: another module is asked for with `recenter`, and the
 *   address is left alone. Direct Run leaves that page for where `leaveFor`
 *   says, a new step Back returns from. `framing` says how it opens: `whole`
 *   shows all of it wherever that reads, which only a demo asks for — a
 *   module's page always opens in focus.
 */
export type BracketNavigation
  = | { kind: 'pages' }
    | {
      kind: 'in-place'
      leaveFor: (moduleName: string, state: ModulePageStateInput) => ModulePageLocation
      framing: BracketFraming
    }

/** A module's page, and what it opens on, before it becomes an address. */
export type ModulePageTarget = {
  moduleName: string
  state: ModulePageStateInput
}

/**
 * The deepest a side may be asked for in an address: far past any graph a
 * person reads, and short of a number a stray digit makes absurd.
 */
export const MAX_REQUESTED_BRACKET_DEPTH = 999

const VIEW_PARAMETER = 'view'
const DIRECT_RUN_PARAMETER = 'direct-run-on'

/** The path of a module's page. */
export function buildModulePagePath(moduleName: string): string {
  return `/view/navigator/modules/${encodeModuleId(moduleName)}`
}

/**
 * Reads a module page's query. A value that is missing, malformed or out of
 * range is the default: a depth must be a whole number from 1 to
 * {@link MAX_REQUESTED_BRACKET_DEPTH}, written as digits.
 */
export function parseModulePageQuery(query: Readonly<Record<string, unknown>>): ModulePageState {
  const directRunOn = readFirst(query[DIRECT_RUN_PARAMETER]) || null

  return {
    view: readFirst(query[VIEW_PARAMETER]) === 'inside' || directRunOn ? 'inside' : 'dependencies',
    depth: {
      left: readDepth(query.left),
      right: readDepth(query.right)
    },
    directRunOn
  }
}

/**
 * The query that says `state`, every default left out, so the plainest view
 * of a module has the plainest address. Open on a Direct Run target, it is the
 * inside view.
 */
export function buildModulePageQuery(state: ModulePageStateInput): Record<string, string> {
  const query: Record<string, string> = {}

  if (state.view === 'inside' || state.directRunOn) {
    query[VIEW_PARAMETER] = 'inside'
  }

  for (const side of ['left', 'right'] as const) {
    const depth = state.depth?.[side]
    if (depth !== undefined && depth !== DEFAULT_BRACKET_DEPTH) {
      query[side] = String(depth)
    }
  }

  if (state.directRunOn) {
    query[DIRECT_RUN_PARAMETER] = state.directRunOn
  }

  return query
}

/** Where a module's page is, open on `state`. */
export function buildModulePageLocation(
  moduleName: string,
  state: ModulePageStateInput = {}
): ModulePageLocation {
  return { path: buildModulePagePath(moduleName), query: buildModulePageQuery(state) }
}

/**
 * Where a documentation preview sends the visitor for a module's page:
 * `/view`, which hands the preview's graph to the tab first.
 */
export function buildPreviewModulePageLocation(
  moduleName: string,
  state: ModulePageStateInput = {}
): ModulePageLocation {
  return {
    path: '/view',
    query: {
      preview: 'true',
      [PREVIEW_MODULE_PARAMETER]: moduleName,
      ...buildModulePageQuery(state)
    }
  }
}

/**
 * The module page `/view?preview=true&module=<name>` hands over to, open as
 * its query asks; `undefined` for any other `/view` address, which opens the
 * viewer as it always has. Which module, if any, is `readHandedOverModule`'s
 * to say: the ELK warm-up reads the same rule.
 */
export function resolvePreviewModulePage(
  query: Readonly<Record<string, unknown>>
): ModulePageLocation | undefined {
  const moduleName = readHandedOverModule(query)
  if (moduleName === null) {
    return undefined
  }

  return buildModulePageLocation(moduleName, parseModulePageQuery(query))
}

/**
 * Where a click on a node of the module graph leads: a module to its own
 * page; a provider or a controller to its module's inside view, with Direct
 * Run open on it. `null` for a node the graph does not name. A provider or
 * controller is matched by its node id exactly, never by a class name, so a
 * controller never lands on a same-named provider.
 */
export function resolveNodeModulePage(
  graph: Pick<GraphOutput, 'modules'>,
  nodeId: string
): ModulePageTarget | null {
  const modulePrefix = getModuleNodeId('')
  if (nodeId.startsWith(modulePrefix)) {
    const moduleName = nodeId.slice(modulePrefix.length)
    return Object.hasOwn(graph.modules, moduleName) ? { moduleName, state: {} } : null
  }

  const target = findDirectRunTarget(graph, nodeId)

  return target
    ? { moduleName: target.moduleName, state: { view: 'inside', directRunOn: target.nodeId } }
    : null
}

function readDepth(value: unknown): number {
  const text = readFirst(value)
  if (!/^\d+$/.test(text)) {
    return DEFAULT_BRACKET_DEPTH
  }

  const depth = Number(text)
  return depth >= 1 && depth <= MAX_REQUESTED_BRACKET_DEPTH ? depth : DEFAULT_BRACKET_DEPTH
}
