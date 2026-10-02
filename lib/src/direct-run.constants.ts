/**
 * Names Direct Run metadata never advertises as a callable "method" on a
 * provider or controller instance: the constructor, and Nest lifecycle hooks.
 * Shared by graph metadata (which methods get advertised) and the invocation
 * guard: strict mode inherits the exclusion through that metadata, and
 * controller permissive mode checks it by name. Provider permissive mode
 * refuses only `constructor`, by design (see `docs/architecture.md`).
 */
export const DIRECT_RUN_EXCLUDED_METHODS = new Set([
  'constructor',
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

/**
 * Prototypes shared by every object of their kind. Runtime-trace
 * instrumentation (`discovery.ts`) refuses to wrap a method found here,
 * because that would patch it for the entire process — every array, every
 * promise — not just the instance being instrumented. Controller Direct Run
 * (`direct-run-output.adapter.ts`) refuses to resolve a method through one,
 * because a method found here is never one the controller declares.
 */
export const BUILTIN_PROTOTYPES = new Set<object>(
  [
    Object.prototype,
    Array.prototype,
    Function.prototype,
    Map.prototype,
    Set.prototype,
    WeakMap.prototype,
    WeakSet.prototype,
    Promise.prototype,
    Error.prototype,
    RegExp.prototype,
    Date.prototype,
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    Symbol.prototype,
  ].filter((prototype): prototype is object => !!prototype),
);
