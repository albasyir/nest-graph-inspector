import type { GraphOutput } from 'nest-graph-inspector';
import type { RecordedTrace } from './inspector-api';

/** How a method that takes no parameters reads in Direct Run metadata. */
const NO_PARAMETERS = '[]';

/** Anything in a route path that stands for a value: `:id`, `*`, `(\d+)`, `?`. */
const ROUTE_PARAMETER = /[:*?(]/;

/** A controller method Nest routes a request to. */
export type RoutedHandler = {
  readonly moduleName: string;
  readonly controllerName: string;
  readonly methodName: string;
  readonly http: { readonly method: string; readonly path: string };
};

/** A provider method, named the way a Direct Run request names it. */
export type ProviderMethod = {
  readonly moduleName: string;
  readonly providerName: string;
  readonly methodName: string;
};

/** A list that holds at least one item. */
type NonEmpty<T> = readonly [T, ...T[]];

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every "list" endpoint the graph advertises: a routed `GET` handler that
 * takes no arguments, on a path without parameters. One can be called over
 * HTTP and through Direct Run alike knowing nothing about the application —
 * it needs no input, and a `GET` changes nothing by convention. The
 * shallowest path comes first, a controller's own root before its
 * sub-routes, then alphabetical order, so the order is the same on every run.
 *
 * Throws when there is none, since then these suites have nothing to call.
 */
export function listEndpointsOf(graph: GraphOutput): NonEmpty<RoutedHandler> {
  const handlers = Object.entries(graph.modules).flatMap(
    ([moduleName, module]) =>
      module.controllers.flatMap((controller) =>
        (controller.directRun?.methods ?? []).flatMap((method) =>
          method.http?.method === 'GET' &&
          method.parameterTypes === NO_PARAMETERS &&
          !ROUTE_PARAMETER.test(method.http.path)
            ? [
                {
                  moduleName,
                  controllerName: controller.name,
                  methodName: method.name,
                  http: method.http,
                },
              ]
            : [],
        ),
      ),
  );

  handlers.sort(
    (left, right) =>
      pathDepth(left.http.path) - pathDepth(right.http.path) ||
      compareText(left.http.path, right.http.path) ||
      compareText(left.moduleName, right.moduleName) ||
      compareText(left.controllerName, right.controllerName) ||
      compareText(left.methodName, right.methodName),
  );

  const [first, ...rest] = handlers;

  if (!first) {
    throw new Error(
      'The graph advertises no GET handler that takes no arguments on a path without parameters, so there is nothing these suites can call without knowing the application. Give one of the demo\'s controllers such a "list" route.',
    );
  }

  return [first, ...rest];
}

/**
 * The first of {@link listEndpointsOf}: the list endpoint a check that
 * calls just one of them calls, the same one on every run.
 */
export function listEndpointOf(graph: GraphOutput): RoutedHandler {
  return listEndpointsOf(graph)[0];
}

/**
 * The first provider method a trace recorded that Direct Run can call again
 * with no arguments: a span whose class the graph lists as a provider of its
 * module — and not also as a controller there, which a trace cannot tell
 * apart — whose advertised method takes no parameters.
 */
export function providerMethodIn({
  graph,
  trace,
}: {
  graph: GraphOutput;
  trace: RecordedTrace;
}): ProviderMethod | undefined {
  for (const { moduleName, className, methodName } of trace.spans) {
    if (!moduleName || !className || !methodName) {
      continue;
    }

    const module = Object.hasOwn(graph.modules, moduleName)
      ? graph.modules[moduleName]
      : undefined;
    const provider = module?.providers.find(
      (candidate) => candidate.name === className,
    );
    const isController = module?.controllers.some(
      (candidate) => candidate.name === className,
    );
    const method = provider?.directRun?.methods.find(
      (candidate) => candidate.name === methodName,
    );

    if (provider && !isController && method?.parameterTypes === NO_PARAMETERS) {
      return { moduleName, providerName: className, methodName };
    }
  }

  return undefined;
}

/** Every cycle the graph reports: module, provider and controller cycles. */
export function cycleCount(graph: GraphOutput): number {
  return (
    graph.cycles.modules.length +
    graph.cycles.providers.length +
    graph.cycles.controllers.length
  );
}

/**
 * A side of a module's dependencies, as the viewer's module page draws them:
 * what the module needs — its imports, theirs, and so on (`left`) — or what
 * needs it (`right`).
 */
export type DependencySide = 'left' | 'right';

/**
 * Each module's neighbours on one side: the modules it imports (`left`), or
 * the modules importing it (`right`). Only modules the graph describes, each
 * once, in the graph's order.
 */
export function dependencyNeighbours(
  graph: GraphOutput,
  side: DependencySide,
): ReadonlyMap<string, readonly string[]> {
  const neighbours = new Map<string, string[]>(
    Object.keys(graph.modules).map((name) => [name, []]),
  );

  for (const [name, module] of Object.entries(graph.modules)) {
    for (const imported of new Set(module.imports)) {
      if (!neighbours.has(imported)) {
        continue;
      }

      const [from, to] = side === 'left' ? [name, imported] : [imported, name];
      neighbours.get(from)?.push(to);
    }
  }

  return neighbours;
}

/**
 * The levels of one side of a module's dependencies: the modules one import
 * away, then two, and so on, each module once at its shortest distance, the
 * module itself on neither side. Each level's names sorted.
 */
export function dependencyLevels(
  graph: GraphOutput,
  moduleName: string,
  side: DependencySide,
): string[][] {
  const neighbours = dependencyNeighbours(graph, side);
  const seen = new Set([moduleName]);
  const levels: string[][] = [];
  let current = [moduleName];

  while (current.length > 0) {
    const next = current.flatMap((name) =>
      (neighbours.get(name) ?? []).filter((candidate) => {
        if (seen.has(candidate)) {
          return false;
        }
        seen.add(candidate);
        return true;
      }),
    );

    if (next.length > 0) {
      levels.push([...next].sort(compareText));
    }
    current = next;
  }

  return levels;
}

/**
 * What the module page's stubs say past the last level drawn on a side: for
 * each module on that level whose branch goes on, how many modules one level
 * further it reaches — sorted, as a multiset.
 */
export function dependencyStubCounts(
  graph: GraphOutput,
  moduleName: string,
  side: DependencySide,
  depth: number,
): number[] {
  const levels = dependencyLevels(graph, moduleName, side);
  const beyond = new Set(levels[depth] ?? []);
  const neighbours = dependencyNeighbours(graph, side);

  return (levels[depth - 1] ?? [])
    .map(
      (name) =>
        (neighbours.get(name) ?? []).filter((next) => beyond.has(next)).length,
    )
    .filter((count) => count > 0)
    .sort((left, right) => left - right);
}

/**
 * The first module, by name, with more than `depth` levels on both sides of
 * its dependencies: one whose page has more to show either way than it shows
 * at that depth. Throws when there is none.
 */
export function moduleWithDeepDependencies(
  graph: GraphOutput,
  depth: number,
): string {
  const found = Object.keys(graph.modules)
    .sort(compareText)
    .find(
      (name) =>
        dependencyLevels(graph, name, 'left').length > depth &&
        dependencyLevels(graph, name, 'right').length > depth,
    );

  if (!found) {
    throw new Error(
      `No module of the graph has more than ${depth} levels of dependencies each way, so the module page has no deeper level to show on either side. Give the demo a deeper chain of imports.`,
    );
  }

  return found;
}

/** The module a reported module cycle starts from. Throws when the graph reports none. */
export function moduleOnCycle(graph: GraphOutput): string {
  const [cycle] = graph.cycles.modules;

  if (!cycle) {
    throw new Error(
      'The graph reports no module cycle, so there is no module on one to check. The demo keeps two on purpose.',
    );
  }

  return cycle.from;
}
