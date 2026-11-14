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

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A "list" endpoint: a routed `GET` handler that takes no arguments, on a
 * path without parameters. One can be called over HTTP and through Direct
 * Run alike knowing nothing about the application — it needs no input, and a
 * `GET` changes nothing by convention. The shallowest path wins, a
 * controller's own root, then alphabetical order, so the choice is the same
 * on every run.
 */
export function listEndpointOf(graph: GraphOutput): RoutedHandler {
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

  const [first] = handlers;

  if (!first) {
    throw new Error(
      'The graph advertises no GET handler that takes no arguments on a path without parameters, so there is nothing these suites can call without knowing the application. Give one of the demo\'s controllers such a "list" route.',
    );
  }

  return first;
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
