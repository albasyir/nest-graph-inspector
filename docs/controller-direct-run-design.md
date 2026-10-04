# Design note — Controller Direct Run

Extends [Direct Run](./architecture.md#direct-run-and-runtime-tracing) to
controller instance methods. Read that section first; this note only covers
what differs for controllers. Companion docs to update alongside this feature:
[`graph-contract.md`](./graph-contract.md), [`public-api.md`](./public-api.md).

## Target identity

A Direct Run request now names a **target type** as well as a name, so a
controller and a same-named provider in the same module can never be confused
for one another:

```jsonc
POST /direct-run
{
  "module": "UserModule",
  "target": "controller",       // "provider" | "controller"; omitted defaults to "provider"
  "controller": "UserController", // read only when target is "controller"
  "provider": "UserService",      // read only when target is "provider" (existing field, unchanged)
  "method": "getUserById",
  "args": ["1"]
}
```

`target` is optional and defaults to `"provider"` so every existing Direct Run
client — anything built against `{ module, provider, method, args }` before
this feature — keeps working unmodified. The two name fields are separate
(`provider` / `controller`) rather than one generic `name`, precisely so a
request is unambiguous about which instance table it addresses: the backend
only ever reads the field that matches `target`, and only ever searches the
matching instance map. It never falls back from one to the other. A `target`
value that is neither `"provider"` nor `"controller"` is a deterministic `400`.

## Metadata collection: HTTP verb/path, only when Nest says so

A controller's `directRun.methods[]` entries carry an optional `http: {
method, path }`, populated from NestJS's own route-registration metadata
(`Reflect.getMetadata` with the `PATH_METADATA` / `METHOD_METADATA` keys
`@nestjs/common` decorators write), never guessed or parsed from source. It is
present only when Nest recorded that metadata for the method — a controller
method with no `@Get`/`@Post`/etc. decorator simply has no `http` field, the
same "absent means unavailable" convention the graph already uses for
`directRun` itself. The path is the controller's `@Controller()` prefix joined
with the method's own path; a `RouterModule` mount path, the global prefix
(`app.setGlobalPrefix`), versioning, and multiple `@Controller(['a','b'])`
prefixes or method paths are not reconstructed — only the first of each is
used — because this is a debugging aid, not a router simulation, and is never
used to decide anything at invocation time. The path shown can therefore
differ from the URL the application actually serves.

Runtime-trace instrumentation (`discovery.ts`) replaces every instrumented
prototype method with a wrapper function, so route metadata — attached via
`reflect-metadata` to the *original* function object — must be read after
unwrapping through `getOriginalTracedMethod()`, the same helper parameter-type
extraction already uses for this exact reason. Reading metadata off the
wrapper silently returns nothing; this is the one non-obvious step in the
extraction.

Method eligibility (which methods appear in `directRun.methods` at all) is
**identical** to providers: public, own-prototype methods, excluding
`constructor` and Nest lifecycle hook names, confirmed public by reading the
application's own sources (`SourceMetadataService.isPublicMethod`). `http` is
additional information layered on top, not a separate eligibility gate — a
controller method the graph would already advertise for a provider-shaped
class is advertised the same way here, plus `http` when Nest has it.

## JSON argument binding

Unchanged from providers: `args` binds positionally to the target method's
declared parameter count (single value for one parameter, array for more),
and the method is called directly — `method.call(instance, ...args)`. See the
limitation below.

## The limitation, stated once so it can be linked everywhere

**Direct Run is direct JavaScript instance method invocation for debugging. It
is not a Nest HTTP request pipeline.** For a controller method this means:

- No guards, interceptors, or pipes run.
- `@Body()`, `@Param()`, `@Query()`, and other param decorators are never
  consulted — `args` is bound positionally to the method's plain parameter
  list, not mapped from decorated request pieces.
- The HTTP verb and path shown alongside a method are informational only
  (read from Nest's route metadata, never simulated), so that a developer
  knows what the method would normally answer — Direct Run does not send an
  HTTP request to it, with or without that route.
- Nothing about the surrounding `@UseGuards()`/`@UseInterceptors()` stack on
  the controller or method is honored.

This must be visible in: the graph/schema docs, the public API doc, the
viewer's controller Direct Run drawer (a persistent note, not a tooltip), and
this file. It was already true of provider Direct Run; controllers make it
more likely to surprise someone, because a controller method's *name* often
reads like an HTTP action.

## Backend: explicit target recognition, not inherited-function luck

`DirectRunOutputAdapter.createRoute`'s instance/allow-list resolver callbacks
gain a leading `target` parameter (`(target, moduleName, name) => …`); nothing
about their external, per-target 2-arg shape
(`instanceLookup(moduleName, providerName)`,
`controllerInstanceLookup(moduleName, controllerName)`) changes, so
`NestGraphInspectorSetup` and `ViewerOutputAdapter` keep supplying four small,
independent closures — two existing (provider) and two new (controller) — and
`ViewerOutputAdapter` wraps them into the two target-dispatching callbacks
`createRoute` expects. A request is only ever resolved against the instance
map for its own declared target.

Provider invocation semantics are **unchanged** — permissive mode still allows
any callable method on the instance or its prototype (refusing only
`constructor`), exactly as `demo/test/graph-inspector-security.e2e-spec.ts`
already asserts and `docs/architecture.md` documents as deliberate. Controller
invocation, being new, is scoped tighter from the start, in both modes:

- `constructor` is refused (matches providers).
- Nest lifecycle hook names (`onModuleInit` and friends —
  `DIRECT_RUN_EXCLUDED_METHODS`, relocated to `direct-run.constants.ts` so
  both the metadata builder and the invocation guard share one list) are
  refused **even in permissive mode**. This is a deliberate divergence from
  provider permissive mode, which does not exclude them (see "Known deliberate
  risks" in `architecture.md`) — controllers get the more conservative
  behavior from day one since there is no existing DX contract to preserve.
- Method resolution only ever accepts a **direct controller method**: a
  function-valued own property of the instance or — when the instance has no
  own property of that name — a function-valued own property of the
  controller's own prototype. Nothing inherited resolves, whether from a base
  class or from `Object.prototype` (`toString`, `valueOf`, `hasOwnProperty`,
  …), and a prototype that is one of the shared built-ins
  (`BUILTIN_PROTOTYPES`, moved from `discovery.ts` to
  `direct-run.constants.ts` so both files share it without an import cycle)
  is never consulted.
- Both lookups read **property descriptors, never properties**. A property
  read of an accessor would run its getter — controller code — before
  anything has been allowed to run; an accessor descriptor has no `value`, so
  a getter is refused with `400` and never executed.
- Strict mode (`allowUnsafeMethods: false`) reuses the existing allow-list
  resolver unchanged: it was already safe for any target, since the allow-list
  itself only ever contains names `SourceMetadataService` confirmed are
  declared, public methods.
- Nonexistent names and target/name mismatches (a `target: "controller"`
  request naming something that is actually a provider, or vice versa) resolve
  to nothing in the target-appropriate instance map and get the existing 404
  shape (`"{Provider|Controller} {module}:{name} is unavailable."`), never a
  fallback lookup in the other map.

## DX defaults apply identically to both targets

`directRun.enabled: false` omits Direct Run metadata (`GraphOutputController.
directRun` and `GraphOutputProvider.directRun` alike) and every Direct Run
route, for both targets — `ViewerOutputAdapter`'s metadata-stripping now clears
both. `allowUnsafeMethods` and `maxBodySizeBytes` are read once per viewer
output, as today, and govern both targets from the same value; there is no
separate per-target override, because the whole point is that these are
instance-wide safety postures, not per-kind ones.

## Type/schema changes (additive to v3)

`GraphOutputController.directRun?: DirectRunControllerMeta` is new and
optional, and this change leaves `GRAPH_OUTPUT_SCHEMA_VERSION` at `'3'`. There
is no earlier precedent for that: `GraphOutputProvider.directRun` was already
part of the v3 schema in the first release that shipped v3 (v0.7.0), so this
is the first field added to v3 after it was published.

It is additive in one direction only. A graph produced before this field
existed omits it and still validates against the updated schema. The reverse
does not hold: the `controller` definition is `additionalProperties: false`,
so a graph that carries `controller.directRun` fails validation against the v3
schema as previously published, although both declare `version: '3'` and the
same `$id`. Consumers must use the schema and types that match the library
that produced the graph — the `output.schema.json` served by that same
inspector, or `GRAPH_OUTPUT_JSON_SCHEMA` and the types from the same package
version. Whether this calls for a version bump is an open schema-version
policy decision; this change does not make it.

New types, all additive exports from `direct-run.type.ts`:
`DirectRunTargetType`, `DirectRunHttpRoute`, `DirectRunControllerMethod`,
`DirectRunControllerMeta`.

## Viewer

Graph node rendering already distinguishes controllers from providers (badge
letter `C` vs `P`); this feature makes controller nodes *actionable* the same
way provider nodes are, without merging their identities. Selecting a graph
node generalizes from "selected provider" to "selected Direct Run target"
(`{ moduleName, targetType, targetName }`); the same drawer, tabs, JSON-args
editor, and run/inspect buttons are reused for both, with the drawer's eyebrow
label reading "Controller Action" vs "Provider Action" and a persistent
limitation note shown only for controllers. The outgoing request always states
`target` explicitly (never relies on the default) and uses the matching
`controller` / `provider` field.

The target's identity travels as the graph node id —
`controller-<module>-<name>` or `provider-<module>-<name>` — never as a bare
class name: the selection, the `directRunDrawerOpen` event, the navigator's
`direct-run-on` query, and the args editor's Monaco model path (which Monaco
also keys the JSON schema by) all carry the target type. A node id is resolved
by exact match against the graph's own providers and controllers, not parsed,
so a controller can never be resolved as a same-named provider in the same or
any other module.

## Explicitly out of scope for v1

- Re-running a controller span from the trace page (`TraceWaterfall.vue`). A
  re-run can only be sent as a provider: `RuntimeTraceSpan` carries no
  target-type field to say otherwise (`RuntimeTraceSpanInput.type` is accepted by
  `RuntimeTraceRecorder.recordSpan` today but never stored, a pre-existing
  gap this feature does not touch). Sent as a provider, a controller span
  does not reliably fail safely: it 404s only when the module has no provider
  of the same name, and otherwise invokes that provider's method instead. So
  "Rerun" is offered only for a span whose class the graph knows as a
  provider of that module and not also as a controller there — never for a
  controller span. Closing this needs `RuntimeTraceSpan`/
  `RuntimeTraceEntrypoint` to carry a target type end to end, which is a
  larger, separate change.
- Simulating a `RouterModule` mount path, `app.setGlobalPrefix()`, route
  versioning, or multiple `@Controller()` prefixes in the collected `http`
  metadata.
