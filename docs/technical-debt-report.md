# Technical Debt Report

**Scope:** Current repository implementation, configuration, tests, and documentation.  
**Method:** Findings below are backed by files present in the repository. This report does not infer roadmap intent.

## Priority summary

| Priority | Finding | Category |
|---|---|---|
| Critical | Default viewer exposes unauthenticated Direct Run over a wildcard-CORS HTTP server | Architectural risk |
| High | `NestGraphInspectorSetup` is a 1,619-line orchestration and domain-logic class | Maintainability / extension risk |
| High | Site consumes library types through internal source paths instead of the library public entry point | Architectural boundary risk |
| High | The library e2e test is a stale Nest scaffold and does not test a route the demo app provides | Test reliability |
| High | No CI job runs library tests, linting, type checking, or package build | Validation gap |
| Medium | Output extension is closed over a union, core dispatch record, DI registration, and internal-only port | Difficult-to-extend API |
| Medium | Direct Run uses internal-only configuration injected through type intersections and casts | Difficult-to-extend API |
| Medium | Graph schema version is duplicated as a literal and as the schema constant | Duplicated implementation |
| Medium | CORS/preflight and URL/path normalization are implemented independently in multiple adapters | Duplicated implementation |
| Medium | Graph cycle serialization is inconsistent between provider and controller cycles | Inconsistent contract / naming |
| Medium | Documentation gives conflicting status and shape descriptions for implemented features | Missing / stale documentation |
| Medium | `demo/docs/` and `site/content/` overlap as documentation surfaces | Overlapping directories / unclear ownership |
| Low | Root contains both pnpm and npm lockfiles | Tooling ambiguity |
| Low | `site/README.md` remains the Nuxt Docs Template README | Stale documentation |
| Low | `site/app/composables/` exists but is empty | Unclear directory responsibility |

---

## Critical

### TD-01 — Default viewer enables unauthenticated Direct Run on a wildcard-CORS server

**Evidence**

- `lib/src/nest-graph-inspector.module.ts` makes
  `viewer` the default output, and its default viewer configuration includes
  `directRun: { path: '/direct-run' }`.
- The same default viewer configuration spreads `HttpOutputAdapter.defaultConfig`,
  whose host is `0.0.0.0` and port is `53371`.
- `lib/src/adapters/viewer-output.adapter.ts` registers
  Direct Run routes whenever the internal `directRun.path` is set.
- `lib/src/adapters/direct-run-output.adapter.ts`
  accepts a request body containing `module`, `provider`, `method`, and `args`,
  resolves the provider instance, then calls `method.call(instance, ...args)`.
  Its checks validate only required fields, provider availability, method existence,
  and argument count/shape.
- `lib/src/adapters/http-serve.adapter.ts` applies
  `Access-Control-Allow-Origin: *`, broad methods, and `Access-Control-Allow-Headers: *`
  to every request before routing. The Direct Run route has no separate access
  control.

**Impact**

Starting the module with its default output creates an HTTP endpoint capable of
executing discovered provider methods. The current implementation has no
authentication, authorization, provider allowlist, method allowlist, or origin
restriction around that endpoint. Because the server uses `0.0.0.0` by default
and publishes wildcard CORS headers, network and browser exposure must be treated
as part of the default behavior.

**Why this is debt**

The feature is enabled by default, while its safety boundary is entirely implicit
in deployment topology. The user-facing README still calls Direct Run “coming
soon,” so the behavior is not clearly communicated to users.

**Related code**

- `lib/src/nest-graph-inspector.module.ts`
- `lib/src/adapters/viewer-output.adapter.ts`
- `lib/src/adapters/direct-run-output.adapter.ts`
- `lib/src/adapters/http-serve.adapter.ts`

---

## High

### TD-02 — `NestGraphInspectorSetup` combines seven responsibilities in one 1,619-line class

**Evidence**

`lib/src/nest-graph-inspector.setup.ts` is 1,619
lines and currently performs all of the following:

1. NestJS root-module discovery through `ModulesContainer`.
2. Module-tree construction and flattening.
3. Provider, controller, import, export, and injection-token extraction.
4. Source lookup and JSDoc extraction using ts-morph.
5. Runtime mutation/instrumentation of provider and controller instances for tracing.
6. Direct Run method metadata extraction and TypeScript type-string rendering.
7. `ModuleMap` → `GraphOutput` enrichment and graph-cycle detection.
8. Output defaulting, adapter selection, dispatch, and logging.

It directly imports NestJS internals, ts-morph, every output adapter, the output
port, the runtime recorder, intermediate graph types, and final graph types.

**Impact**

Changes to extraction, trace instrumentation, Direct Run metadata, graph
serialization, cycle detection, or output dispatch are all concentrated in one
class. Tests must construct it with a large dependency set, and unrelated changes
risk conflicting in the same file.

**Why this is debt**

The existing adapter layer separates output mechanics, but equivalent boundaries
are absent for extraction, enrichment, trace instrumentation, and cycle analysis.
The file is already substantially larger than any other library source module.

**Related code**

- `lib/src/nest-graph-inspector.setup.ts`
- `lib/src/nest-graph-inspector.setup.spec.ts`

---

### TD-03 — The site bypasses the package public API and imports library types from internal source paths

**Evidence**

`site/nuxt.config.ts` defines `@library` as an alias to `../library`, then site
files import types with paths such as:

```ts
@lib/src/types/graph-output.type
@lib/src/types/direct-run.type
```

Current uses include:

- `site/app/stores/graph-inspector.ts`
- `site/app/utils/circular-dependency-issues.ts`
- `site/app/utils/direct-run-provider.ts`
- `site/app/components/content/RuntimeGraphPreview.vue`
- `site/app/components/content/RuntimeGraphDirectRunPreview.vue`

The npm package itself exposes only `"."` in its `exports` map, and `index.ts`
already re-exports both graph-output and direct-run types.

**Impact**

The site is coupled to the library's internal source layout
(`libs/nest-graph-inspector/src/types/...`) rather than its declared public entry
point. Moving a type file or tightening package/export boundaries can break the
site even when the library's public API remains unchanged.

**Why this is debt**

This duplicates the ownership of the contract: the library claims a root public
entry point, while the site treats source-file paths as a contract. The repository
instructions say the frontend should integrate through the reusable library's
public API; current imports do not do that.

**Related code**

- `site/nuxt.config.ts`
- `lib/package.json`
- `lib/src/index.ts`
- Site files listed above

---

### TD-04 — The only e2e test is a stale scaffold that does not match the demo application

**Evidence**

`demo/test/app.e2e-spec.ts` imports `AppModule`, starts a Nest app, then
expects `GET /` to return `200` and `"Hello World!"`.

A repository-wide search finds `"Hello World!"` only in that test. The demo app
under `demo/src/` contains no root controller or endpoint that returns this
response.

**Impact**

`pnpm test:e2e` does not validate the graph inspector's actual integration path
and is expected to fail against the current application. This makes a documented
validation command unreliable.

**Related code**

- `demo/test/app.e2e-spec.ts`
- `demo/test/jest-e2e.json`
- `demo/src/app.module.ts`

---

### TD-05 — CI deploys the site but does not validate the reusable library

**Evidence**

`.github/workflows/deploy-site.yml` is the only workflow. It installs dependencies
and runs `pnpm exec nuxt generate` in `site/`, then deploys GitHub Pages.

The reusable package provides `pnpm build` and `pnpm test` in `lib/package.json`.
The demo host provides `pnpm build`, `pnpm lint`, `pnpm test`, and
`pnpm test:e2e` in `demo/package.json`. No GitHub Actions workflow runs them.
The workflow also does not run `site` linting or type checking.

**Impact**

A change can be merged and deployed while library unit tests, library build,
library linting, site linting, site type checking, and e2e tests are not executed
by CI.

**Related files**

- `.github/workflows/deploy-site.yml`
- `lib/package.json`
- `demo/package.json`
- `site/package.json`

---

## Medium

### TD-06 — Adding an output type requires core changes in several unrelated locations

**Evidence**

Current outputs are represented by the closed `NestGraphInspectorOutput`
discriminated union in `nest-graph-inspector.type.ts`. To add a new output type,
the implementation must modify at least:

1. The `NestGraphInspectorOutput` union.
2. The `Record<NestGraphInspectorOutput['type'], OutputAdapter>` construction in
   `NestGraphInspectorSetup`.
3. `NestGraphInspectorModule` provider registration.
4. The `outputAdapters` map wiring in the setup-service constructor.
5. Tests and user-facing configuration documentation.

`OutputAdapter<Config>` exists in `src/ports/output.adapter.ts`, but it is not
re-exported from `index.ts`; therefore it is not a documented extension point for
library consumers.

**Impact**

The adapter abstraction is only partially extensible: it abstracts built-in output
implementations but does not provide a supported registration mechanism for new
output types. Every extension changes central library code and public union types.

**Related code**

- `lib/src/nest-graph-inspector.type.ts`
- `lib/src/nest-graph-inspector.setup.ts`
- `lib/src/nest-graph-inspector.module.ts`
- `lib/src/ports/output.adapter.ts`

---

### TD-07 — Direct Run crosses the public/internal configuration boundary through type widening and casts

**Evidence**

The public viewer configuration exposes only:

```ts
type NestGraphInspectorViewerDirectRunOptions = { path?: string }
```

`NestGraphInspectorSetup.mergeViewerDirectRunOptions()` adds two internal values:
`historyDirPath` and `instanceLookup`. `ViewerOutputAdapter` then defines a
separate `ViewerOutputInternalConfig` type and casts its public
`ViewerOutputConfig` parameter to that type:

```ts
const internalConfig = config as ViewerOutputInternalConfig;
```

`HttpOutputAdapter` uses the same pattern with `HttpOutputInternalOptions`, adding
an internal `httpAdapter` field to its public `http` output configuration type.

**Impact**

The public output configuration is not the actual configuration the adapters
consume. Internal capabilities are transported through structural intersections
and casts, making the flow harder to type-check, harder to reuse, and difficult
for an external adapter or alternate Direct Run implementation to extend.

**Related code**

- `lib/src/nest-graph-inspector.setup.ts`
- `lib/src/adapters/viewer-output.adapter.ts`
- `lib/src/adapters/http-output.adapter.ts`
- `lib/src/nest-graph-inspector.type.ts`

---

### TD-08 — Graph schema version is duplicated instead of sourced from the schema constant

**Evidence**

- `lib/src/types/graph-output.schema.ts` exports
  `GRAPH_OUTPUT_SCHEMA_VERSION = '3'`.
- `lib/src/nest-graph-inspector.setup.ts` returns
  `version: '3'` directly in `createModuleMapFromModuleTree()`.

**Impact**

A schema-version update can change the schema constant while leaving generated
output on the old version, or vice versa. No shared source enforces that the two
values remain aligned.

**Related code**

- `lib/src/types/graph-output.schema.ts`
- `lib/src/nest-graph-inspector.setup.ts`

---

### TD-09 — CORS/preflight and path normalization are implemented independently in several adapters

**Evidence**

CORS:

- `HttpServeAdapter` unconditionally sets wildcard CORS headers and has its own
  `isCorsPreflightRequest()` / `sendCorsPreflight()` implementation.
- `ProxyAdapter` separately implements `getCorsHeaders()`, `applyCors()`,
  `handleCorsPreflight()`, and its own `isCorsPreflightRequest()`; it supports
  origin allowlists and credentials.

Path/origin normalization:

- `HttpOutputAdapter.normalizePath()`.
- `HttpServeAdapter.normalizePath()` and `normalizeOrigin()`.
- `ProxyAdapter.normalizePath()` and `normalizeUrl()`.

The implementations do not have identical policy: `HttpOutputAdapter` leaves a
trailing slash, `ProxyAdapter` removes one, and `HttpServeAdapter` normalizes only
a leading slash (except `'*'`).

**Impact**

HTTP and proxy behavior is spread across components that must agree at runtime.
Path handling and CORS policy can change independently and create route or browser
behavior differences. The split CORS policy is also relevant to TD-01.

**Related code**

- `lib/src/adapters/http-serve.adapter.ts`
- `lib/src/adapters/proxy.adapter.ts`
- `lib/src/adapters/http-output.adapter.ts`

---

### TD-10 — Cycle data uses two incompatible path representations for the same dependency-domain concept

**Evidence**

`GraphOutputCycles` declares:

```ts
type GraphOutputCycles = {
  modules: GraphOutputCycle[];           // path: string[]
  providers: GraphOutputProviderCycle[]; // path: { module, provider }[]
  controllers: GraphOutputCycle[];       // path: string[]
}
```

In `NestGraphInspectorSetup.findDependencyCycles()`, provider cycles are converted
through `toProviderCycle()` into structured path items. Controller cycles are
returned as the original `GraphOutputCycle`, whose path contains composite strings
such as `"ModuleName:ControllerName"`.

The site must maintain separate formatting paths in
`site/app/utils/circular-dependency-issues.ts`: `formatProviderCyclePath()` for
provider cycles and `formatDependencyCyclePath()` for controller cycles.

**Impact**

Consumers cannot use one traversal/rendering strategy for all dependency cycles.
Adding another node category or altering identifiers requires category-specific
code in both producer and consumer. This inconsistency is already documented as
an open question in `docs/graph-contract.md`.

**Related code**

- `lib/src/types/graph-output.type.ts`
- `lib/src/nest-graph-inspector.setup.ts`
- `site/app/utils/circular-dependency-issues.ts`

---

### TD-11 — User-facing documentation is stale or conflicts with current implementation

**Evidence**

1. The root `README.md` calls **Direct Run** “coming soon.”
   The repository currently implements Direct Run endpoint registration, provider
   invocation, trace recording, histories, static mock histories, and viewer UI.

2. `site/content/2.configuration/2.outputs.md` describes JSON output as “the raw
   module map.” `JsonOutputAdapter.execute()` serializes `GraphOutput`, which is
   an enriched format containing `GraphOutputDependencyRef` objects, `cycles`, and
   optional `directRun` metadata. The intermediate raw `ModuleMap` is not written
   by that adapter.

3. The same outputs page calls JSON a “stable data artifact,” while its warning at
   the top says output formats beyond the Web Viewer are under active iteration
   and “format-level breaking changes may land between releases.”

4. `NestGraphInspectorViewerDirectRunOptions`, `DirectRunResult`, runtime trace
   types, the schema import use case, and Direct Run security/exposure behavior
   have no dedicated user-facing documentation.

**Impact**

Consumers may make configuration and security decisions from documentation that
does not describe what the package currently does or writes.

**Related files**

- `README.md`
- `site/content/2.configuration/2.outputs.md`
- `lib/src/adapters/json-output.adapter.ts`
- `lib/src/adapters/direct-run-output.adapter.ts`
- `lib/src/types/direct-run.type.ts`

---

### TD-12 — Documentation ownership overlaps across `docs/`, `site/content/`, and `demo/docs/`

**Evidence**

- Root `docs/` contains contributor/maintainer documents such as architecture,
  graph contract, development guidelines, maintainers guide, public API, and this
  report.
- `site/content/` contains user-facing MDC docs for installation, configuration,
  and internals; it is rendered and deployed through Nuxt.
- `demo/docs/` contains standalone static HTML files (`index.html`,
  `diagram.html`, `logo.png`) that describe the same project. No current script
  was found that generates or deploys those files.

**Impact**

There are three documentation locations with partially overlapping technical
scope. A change to configuration, graph behavior, or public API has no single
obvious documentation source of truth.

**Related directories**

- `docs/`
- `site/content/`
- `demo/docs/`

---

## Low

### TD-13 — Root contains both `pnpm-lock.yaml` and `package-lock.json`

**Evidence**

- Root `package.json` declares `packageManager: "pnpm@10.33.0"`.
- `pnpm-workspace.yaml` defines the `lib`, `demo`, and `site` workspace packages.
- Both `pnpm-lock.yaml` and `package-lock.json` exist at the repository root.

**Impact**

Two lockfile formats can create ambiguity about which package manager should be
used to change dependencies. The GitHub Pages workflow uses pnpm, so
`pnpm-lock.yaml` is the lockfile that CI consumes.

**Related files**

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `package-lock.json`
- `.github/workflows/deploy-site.yml`

---

### TD-14 — `site/README.md` is still the uncustomized Nuxt Docs Template README

**Evidence**

`site/README.md` identifies itself as “Nuxt Docs Template,” links to the template
demo, and instructs users to run `npm create nuxt@latest -- -t ui/docs`. It does
not describe Nest Graph Inspector's site, graph viewer, MCP tools, or local
library integration.

**Impact**

Contributors entering through `site/` receive misleading project-specific setup
and ownership information.

**Related files**

- `site/README.md`
- `site/nuxt.config.ts`
- `site/AGENTS.md`

---

### TD-15 — `site/app/composables/` has no current responsibility in implementation

**Evidence**

`site/app/composables/` exists but contains no files. Shared reactive logic is
currently placed in Pinia stores or page/component code.

**Impact**

The directory name suggests a supported placement for composables, but the
repository gives no project-specific convention for when logic should use it
rather than a store or utility. This is a small ownership ambiguity rather than a
functional defect.

**Related directories**

- `site/app/composables/`
- `site/app/stores/`
- `site/app/utils/`

---

## Not classified as debt

The following were inspected but are not reported as problems because the current
repository provides a clear implementation-backed role:

- `demo/src/` is a demo/development application and intentionally contains
  circular dependency examples used for graph inspection.
- `demo/tmp/graph/` is generated runtime output and `demo/scripts/mock-sync.ts`
  clearly copies it to the static site fixture.
- `OutputAdapter` and `ProxyGateway` are useful internal seams even though custom
  extension is not currently public; the debt is the absence of a public
  registration path, not the existence of the interfaces.
- `site/public/mock-graph/` deliberately contains generated static data and Direct
  Run histories used by the viewer’s “Load Example” mode.
