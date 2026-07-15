# Architecture — Nest Graph Inspector

## Repository layout

```
nestjs-devtool/           ← monorepo root (pnpm workspaces)
├── library/              ← NestJS library workspace
│   ├── libs/nest-graph-inspector/   ← published npm package
│   │   └── src/                     ← all library implementation
│   ├── src/              ← demo / development application
│   └── test/             ← e2e tests for the demo app
└── site/                 ← Nuxt 4 documentation + interactive viewer
    ├── app/              ← Nuxt app directory
    ├── content/          ← MDC documentation pages
    └── public/mock-graph/  ← static fixture used by "Load Example"
```

The root `package.json` is private and carries no scripts; it only declares the
pnpm workspace and `packageManager` field.

---

## `library/**`

### `library/libs/nest-graph-inspector` — the published package

This is the only artifact that ships to npm as `nest-graph-inspector`.

Responsibilities:
- Inject itself into a NestJS application via `NestGraphInspectorModule`.
- Walk the live `ModulesContainer` at startup to build an internal `ModuleMap`.
- Enrich the `ModuleMap` into a `GraphOutput` (adds dependency refs, cycle
  detection, JSDoc extraction via ts-morph, and Direct Run metadata).
- Dispatch the `GraphOutput` to one or more configured output adapters.

Key internal classes:

| Class | Role |
|---|---|
| `NestGraphInspectorModule` | NestJS `@Module` entry point; owns the default config |
| `NestGraphInspectorSetup` | `OnModuleInit` service; orchestrates graph extraction and adapter dispatch |
| `HttpServeAdapter` | Standalone Node.js HTTP server (no Express/Fastify dependency) |
| `HttpOutputAdapter` | Registers JSON + Markdown + schema routes on an HTTP server |
| `ViewerOutputAdapter` | Delegates to `HttpOutputAdapter` + `ProxyAdapter`; prints viewer URL |
| `FileOutputAdapter` | Writes Markdown dependency graph to disk |
| `JsonOutputAdapter` | Writes raw `GraphOutput` JSON to disk |
| `ProxyAdapter` | Forwards Ollama AI requests from the viewer origin |
| `DirectRunOutputAdapter` | Registers provider method execution endpoints |
| `RuntimeTraceRecorder` | Records in-process call spans using `AsyncLocalStorage` |

Port interfaces under `src/ports/`:
- `OutputAdapter<Config>` — contract every output adapter implements.
- `ProxyGateway` — contract for the Ollama proxy.

Type definitions under `src/types/`:
- `graph-output.type.ts` — TypeScript types for the `GraphOutput` contract.
- `graph-output.schema.ts` — JSON Schema (draft 2020-12) for `GraphOutput`;
  the schema version constant (`GRAPH_OUTPUT_SCHEMA_VERSION = '3'`) is the
  authoritative version gate.
- `direct-run.type.ts` — types for Direct Run and runtime tracing.
- `module-map.type.ts`, `module.type.ts`, `module-provider.type.ts`,
  `module-controller.type.ts` — intermediate internal representation used
  during extraction before enrichment.

### `library/src` — demo / development application

A plain NestJS application (`AppModule`) that imports
`NestGraphInspectorModule.forRoot()` with multiple outputs configured.  Its
only purpose is to provide a realistic module graph for manual testing and to
generate the mock fixture used by the viewer.

It is **not** part of the published package.  Do not add production logic here.

---

## `site/**`

A Nuxt 4 application deployed to GitHub Pages.  It serves two distinct
functions:

1. **Documentation site** — MDC pages under `site/content/` rendered by
   `@nuxt/content`.
2. **Interactive graph viewer** — the `/view` route that loads a `GraphOutput`
   from a live NestJS endpoint and visualises it with Vue Flow.

The viewer fetches data from a user-supplied URL at runtime; it never calls the
library directly.  The only coupling to the library is a path alias:

```ts
// site/nuxt.config.ts
alias: { '@library': fileURLToPath(new URL('../library', import.meta.url)) }
```

This alias lets the site import TypeScript types from the library source
without going through the npm package:

```ts
import type { GraphOutput } from '@library/libs/nest-graph-inspector/src/types/graph-output.type'
```

**Important:** the site imports library types only — never runtime code.  All
graph behaviour at runtime goes through the HTTP contract.

Key site modules:

| Path | Role |
|---|---|
| `app/stores/graph-inspector.ts` | Pinia store; fetches and validates `GraphOutput` from the live endpoint |
| `app/utils/circular-dependency-issues.ts` | Derives `CircularDependencyIssue[]` from raw `GraphOutput.cycles` |
| `app/utils/direct-run-provider.ts` | Helper types and functions for Direct Run UI |
| `app/utils/supported-runtime.ts` | Package manager constants and install command helpers |
| `public/mock-graph/` | Static fixture (`output.json`, `output.md`, `information.json`) served from the site for "Load Example" |

---

## Framework-specific extraction vs. framework-agnostic consumption

The design enforces a strict boundary at the HTTP + JSON layer:

```
NestJS app (runtime)
  └── NestGraphInspectorModule
        └── NestGraphInspectorSetup
              ├── reads  ModulesContainer   ← NestJS-specific
              ├── produces GraphOutput JSON ← framework-agnostic contract
              └── serves  /output.json      ← HTTP boundary

Interactive Viewer (site)
  └── fetch /output.json                   ← no NestJS dependency
        └── renders graph
```

The `GraphOutput` JSON schema is the single, versioned contract that separates
the two sides.  The site must not assume anything about how the data was
generated; the library must not assume how the data will be rendered.

---

## Main data flow

```
1. Developer imports NestGraphInspectorModule in their root module
2. NestJS bootstraps → NestGraphInspectorSetup.onModuleInit() fires
3. ModulesContainer is walked → ModuleMap is built
     - provider and controller dependencies are resolved
     - JSDoc comments are extracted via ts-morph (optional; skipped if source not found)
     - Direct Run method signatures are extracted via ts-morph
4. ModuleMap is enriched → GraphOutput is produced
     - dependency tokens become GraphOutputDependencyRef (with providedBy)
     - cycle detection runs for modules, providers, and controllers
5. GraphOutput is dispatched to all configured OutputAdapters in parallel
     - json  → writes JSON file
     - markdown → writes Markdown file (Mermaid + text)
     - http  → registers routes on a standalone Node.js HTTP server
     - viewer → http + Ollama proxy + Direct Run endpoints + prints viewer URL
6. Viewer site fetches /information.json (endpoint discovery)
             then fetches /output.json (GraphOutput)
             then fetches /output.md  (Markdown)
7. Pinia store validates GraphOutput version (≥ 3) and exposes data to Vue components
8. Vue Flow renders the module/provider graph; issue finder surfaces cycles
```

---

## Architectural boundaries contributors must preserve

1. **The library has no UI dependency.** Do not import frontend packages into
   `library/libs/**`.
2. **The site has no NestJS runtime dependency.** Only TypeScript types may be
   imported via `@library` alias; never injectable services or decorators.
3. **`library/src` is not the library.** Changes to `library/src` are
   demo-only and must not alter the public API in `library/libs/**`.
4. **`GraphOutput` is a versioned contract.** Any breaking change to the shape
   must increment `GRAPH_OUTPUT_SCHEMA_VERSION` in
   `library/libs/nest-graph-inspector/src/types/graph-output.schema.ts` and
   update the corresponding JSON Schema.  The viewer enforces
   `MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION = 3`.
5. **Output adapters are pluggable via `OutputAdapter<Config>`.** New output
   types must implement this port interface.
6. **The HTTP server is framework-independent.** `HttpServeAdapter` uses plain
   `node:http` and must not gain an Express/Fastify dependency.

---

## Open questions

- No monorepo-level `pnpm-workspace.yaml` was found during inspection; the
  workspace membership of `library/` and `site/` is inferred from `.npmrc` and
  directory convention.  Clarify whether a workspace file exists or is
  intentionally absent.
- The `library/test/app.e2e-spec.ts` test calls `GET /` and expects `"Hello
  World!"`, but no controller serving that route exists in `library/src`.  This
  test appears to be a leftover scaffold and may always fail.
