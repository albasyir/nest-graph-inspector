# Graph JSON Contract — `GraphOutput` v3

This document describes the JSON contract as implemented in
`lib/src/types/graph-output.type.ts` and
`lib/src/types/graph-output.schema.ts`.

The normative source of truth is the JSON Schema published at:
`https://albasyir.github.io/nest-graph-inspector/schemas/graph-output-v3.schema.json`

The viewer enforces `version >= 3`.  Older payloads trigger an upgrade prompt.

---

## Top-level structure

```jsonc
{
  "version": "3",          // string, required — must equal "3" per JSON Schema const
  "root": "AppModule",     // string, required — class name of the root module
  "modules": { ... },      // object, required — keyed by module class name
  "cycles": { ... }        // object, required — circular dependency report
}
```

All four fields are required.  `additionalProperties` is `false` in the JSON
Schema, so unrecognised top-level fields are invalid.

---

## Module map — `modules`

`modules` is a plain object whose keys are **module class names** (strings such
as `"AppModule"`, `"UserModule"`).  Each value is a module descriptor.

### Module descriptor

```ts
type GraphOutputModule = {
  jsdoc?: string;              // optional — JSDoc comment from the class declaration
  imports: string[];           // required — list of imported module names
  exports: string[];           // required — list of exported provider token names
  providers: GraphOutputProvider[];    // required
  controllers: GraphOutputController[]; // required
}
```

| Field | Required | Notes |
|---|---|---|
| `jsdoc` | No | Extracted from source via ts-morph; absent when source is unavailable |
| `imports` | Yes | Array of module class name strings |
| `exports` | Yes | Array of provider token name strings |
| `providers` | Yes | May be empty `[]` |
| `controllers` | Yes | May be empty `[]` |

### Virtual module — `NestJSCoreModule`

When a provider's dependency originates from a NestJS core token (e.g.
`ModuleRef`, `Reflector`, `REQUEST`, `INQUIRER`, `ApplicationConfig`), the
library groups them under a synthetic module entry keyed `"NestJSCoreModule"`
(configurable via `nestCoreModuleName`).  This entry follows the same
`GraphOutputModule` shape.

---

## Provider descriptor

```ts
type GraphOutputProvider = {
  name: string;                         // required — provider class name / token string
  jsdoc?: string;                       // optional
  dependencies: GraphOutputDependencyRef[]; // required
  directRun?: DirectRunProviderMeta;    // optional — present when ts-morph finds public methods
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | The token string used to register the provider |
| `jsdoc` | No | Class-level JSDoc; absent when source unavailable |
| `dependencies` | Yes | May be empty `[]` |
| `directRun` | No | See Direct Run section below |

---

## Controller descriptor

```ts
type GraphOutputController = {
  name: string;                         // required
  jsdoc?: string;                       // optional
  dependencies: GraphOutputDependencyRef[]; // required
}
```

Controllers do not carry a `directRun` field.  The shape is otherwise
identical to a provider (minus `directRun`).

---

## Dependency reference — `GraphOutputDependencyRef`

Each entry in a provider's or controller's `dependencies` array is:

```ts
type GraphOutputDependencyRef = {
  providedBy: {
    type: string;    // currently always "module"
    name: string;    // name of the module that owns the dependency
  };
  token: string;     // provider token name
}
```

Both `providedBy` and `token` are required.

> **Open question:** `providedBy.type` is typed as `string` in TypeScript and
> the JSON Schema but the library only ever emits `"module"`.  Future values
> (e.g. `"global"`, `"dynamic"`) are not documented anywhere.

---

## Identifiers

- **Module identifiers** — the class name string as registered in
  `ModulesContainer` (e.g. `"UserModule"`).
- **Provider identifiers** — the injection token string (e.g. `"UserService"`,
  `"UserRepository"`).  Symbol tokens are not represented; only string-based
  tokens appear in the output.
- **Cycle node keys** (modules and controllers) — raw names as in the modules
  map.
- **Cycle node keys** (providers) — `"ModuleName:ProviderName"` composite
  strings in the `from` and `to` fields of provider cycles.

> **Open question:** Non-string injection tokens (e.g. `InjectionToken`,
> `Symbol`) are not documented.  The library resolves them via
> `InstanceWrapper`, but how they appear as the `token` string (or whether they
> are silently dropped) is not explicitly specified.

---

## Circular dependency representation — `cycles`

```ts
type GraphOutputCycles = {
  modules: GraphOutputCycle[];          // module-level cycles
  providers: GraphOutputProviderCycle[]; // provider-level cycles
  controllers: GraphOutputCycle[];      // controller-level cycles
}
```

All three arrays are required.

### `GraphOutputCycle` (modules and controllers)

```ts
type GraphOutputCycle = {
  id: number;              // required — monotonically increasing integer across all cycle types
  from: string;            // required — start node name
  to: string;              // required — end node name (closes the loop)
  type: 'direct' | 'indirect'; // required
  path: string[];          // required — full cycle path as name strings; last element repeats first
}
```

**`type` semantics:**
- `"direct"` — `from` and `to` mutually import each other (A → B → A), or
  a node imports itself (A → A).
- `"indirect"` — the cycle passes through at least one intermediate node
  (A → B → C → A).

**`path` format:**  
The first and last element are the same node name, forming a closed walk.  
Example: `["UserModule", "MobileModule", "ProductModule", "UserModule"]`

### `GraphOutputProviderCycle`

```ts
type GraphOutputProviderCycle = {
  id: number;
  from: string;   // "ModuleName:ProviderName"
  to: string;     // "ModuleName:ProviderName"
  type: 'direct' | 'indirect';
  path: GraphOutputProviderCyclePathItem[]; // structured path, not plain strings
}

type GraphOutputProviderCyclePathItem = {
  module: { name: string };
  provider: { name: string };
}
```

The `path` format differs between module/controller cycles (array of strings)
and provider cycles (array of objects).

> **Open question:** Controller cycles use `GraphOutputCycle` (string path
> with `"ModuleName:ProviderName"` composite keys), not
> `GraphOutputProviderCycle`.  This is inconsistent with provider cycles, which
> use a structured object path.  The site's `circular-dependency-issues.ts`
> handles this split: controller paths are decoded with
> `formatDependencyCyclePath` (splits on `:`), while provider paths use
> `formatProviderCyclePath`.  The inconsistency is present in both the
> TypeScript types and the JSON Schema.

---

## Direct Run metadata — `directRun`

Present on providers only; absent from controllers.

```ts
type DirectRunProviderMeta = {
  methods: DirectRunProviderMethod[];
}

type DirectRunProviderMethod = {
  name: string;           // required — method name
  parameterTypes: string; // required — TypeScript parameter list as a string, e.g. "[id: number]"
}
```

Both fields on `DirectRunProviderMethod` are required.  `methods` may be an
empty array if a provider has no public methods.

`parameterTypes` is a raw TypeScript signature string extracted by ts-morph.
It is used by the viewer's Direct Run UI for documentation; it is not parsed
programmatically.

> **Open question:** `directRun` is omitted entirely when ts-morph cannot
> locate the source file, not set to `null` or `{ methods: [] }`.  The viewer
> must treat `directRun` as optionally absent.

---

## Required vs. optional fields summary

| Field path | Required |
|---|---|
| `version` | ✅ |
| `root` | ✅ |
| `modules` | ✅ |
| `modules[name].imports` | ✅ |
| `modules[name].exports` | ✅ |
| `modules[name].providers` | ✅ |
| `modules[name].controllers` | ✅ |
| `modules[name].jsdoc` | ❌ optional |
| `provider.name` | ✅ |
| `provider.dependencies` | ✅ |
| `provider.jsdoc` | ❌ optional |
| `provider.directRun` | ❌ optional |
| `provider.directRun.methods` | ✅ (when directRun present) |
| `controller.name` | ✅ |
| `controller.dependencies` | ✅ |
| `controller.jsdoc` | ❌ optional |
| `dependency.providedBy` | ✅ |
| `dependency.providedBy.type` | ✅ |
| `dependency.providedBy.name` | ✅ |
| `dependency.token` | ✅ |
| `cycles.modules` | ✅ |
| `cycles.providers` | ✅ |
| `cycles.controllers` | ✅ |
| `cycle.id` | ✅ |
| `cycle.from` | ✅ |
| `cycle.to` | ✅ |
| `cycle.type` | ✅ |
| `cycle.path` | ✅ |

---

## Public exported TypeScript types

All of the following are re-exported from the library's public entry point
`lib/src/index.ts`:

From `graph-output.type.ts`:
- `GraphOutput`
- `GraphOutputModule`
- `GraphOutputProvider`
- `GraphOutputController`
- `GraphOutputDependencyRef`
- `GraphOutputCycles`
- `GraphOutputCycle`
- `GraphOutputCycleBase`
- `GraphOutputCycleType`
- `GraphOutputProviderCycle`
- `GraphOutputProviderCyclePathItem`

From `graph-output.schema.ts`:
- `GRAPH_OUTPUT_SCHEMA_VERSION` (constant `'3'`)
- `GRAPH_OUTPUT_JSON_SCHEMA` (the full JSON Schema object)

From `direct-run.type.ts`:
- `DirectRunProviderMethod`
- `DirectRunProviderMeta`
- `DirectRunResult`
- `DirectRunTraceRecorder`
- `RuntimeTrace`
- `RuntimeTraceHandle`
- `RuntimeTraceSpan`
- `RuntimeTraceSpanStatus`
- `RuntimeTraceSpanType`
- `RuntimeTraceStartContext`
- `RuntimeTraceEntrypoint`
- `RuntimeTraceStatus`

---

## Open questions

1. `providedBy.type` is always `"module"` today; the allowed value set is
   unspecified for future extension.
2. Non-string injection tokens (Symbols, classes used as tokens) — unclear
   whether they surface in the output or are silently filtered.
3. Controller cycles use string paths (like module cycles) while provider
   cycles use structured object paths — this inconsistency has no documented
   rationale.
4. `directRun` is absent when ts-morph source resolution fails; there is no
   documented fallback shape.
5. `cycle.id` increments across all three cycle categories (`modules`,
   `providers`, `controllers`) in a single shared counter, but this is not
   specified in the schema or types.
