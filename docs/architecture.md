# Architecture — Nest Graph Inspector

## Repository layout

```
nestjs-devtool/           ← monorepo root (pnpm workspaces)
├── lib/                  ← published NestJS package
│   └── src/              ← all reusable library implementation
├── demo/                 ← Nest demo / development host
│   ├── src/              ← demo application
│   ├── scripts/          ← build tooling (packages the demo for the site)
│   └── test/             ← e2e tests for the demo app
└── site/                 ← Nuxt 4 documentation + interactive viewer
    ├── app/              ← Nuxt app directory
    ├── content/          ← MDC documentation pages
    └── public/nodepod-demo/  ← generated demo payload the browser runs (gitignored)
```

The root `package.json` is private and contains no source.  Its scripts fan out
across the workspace: `dev`, `build`, and `build:site` each build the library
and then the demo payload, because the site cannot serve a demo it has not been
given.

---

## `lib/**`

### `lib` — the published package

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

## `demo/**`

### `demo/src` — demo / development application

A plain NestJS application (`AppModule`) that imports
`NestGraphInspectorModule.forRoot()` with `viewer`, `markdown`, `json` and
`http` outputs, the file ones writing into `demo/tmp/graph/`.  It serves two
purposes: a realistic module graph for manual testing, and the application the
documentation site runs inside the visitor's browser.

It knows nothing about the second one, and that is deliberate: it is an
ordinary NestJS project, copyable somewhere else and runnable there unchanged.
Everything the browser runtime needs differently lives in
`demo/scripts/build-nodepod-payload.ts`, which packages this application for the
site — see [The in-browser demo](#the-in-browser-demo).

It is **not** part of the published package.  Do not add production logic here.

---

## `site/**`

A Nuxt 4 application deployed to GitHub Pages.  It serves two distinct
functions:

1. **Documentation site** — MDC pages under `site/content/` rendered by
   `@nuxt/content`.
2. **Interactive graph viewer** — the `/view` route that loads a `GraphOutput`
   from a live NestJS endpoint and visualises it with Vue Flow.

The viewer fetches data from an endpoint URL at runtime; it never calls the
library directly.  That endpoint is either an application the visitor is running
themselves, or the demo application running inside the browser tab.  The site
has no direct source alias to the package; all graph behaviour goes through the
HTTP contract.

Key site modules:

| Path | Role |
|---|---|
| `app/stores/graph-inspector.ts` | Pinia store; fetches and validates `GraphOutput` from the live endpoint |
| `app/stores/nodepod-demo.ts` | Pinia store; downloads the demo payload, boots nodepod, spawns the demo application, and bridges requests to its virtual servers |
| `app/composables/use-nodepod-demo-graph.ts` | Starts the demo when a docs preview asks for it, and exposes the graph the running application reports |
| `app/composables/use-nodepod-demo-session.ts` | Restarts the demo behind a restored session, whose endpoint only the tab that started it can answer |
| `app/utils/nodepod-demo-endpoint.ts` | Endpoint plumbing for the in-browser demo: reads the viewer link out of the startup log and addresses the virtual servers |
| `app/utils/circular-dependency-issues.ts` | Derives `CircularDependencyIssue[]` from raw `GraphOutput.cycles` |
| `app/utils/direct-run-provider.ts` | Helper types and functions for Direct Run UI |
| `app/utils/supported-runtime.ts` | Package manager constants and install command helpers |
| `public/nodepod-demo/` | Generated demo payload (`main.js`, `sources.json`, `manifest.json`); built by `demo/scripts/build-nodepod-payload.ts` and gitignored |

---

## The in-browser demo

Everything the site shows as a demo — the graph previews in the documentation
pages, and "Open Demo" on `/view` — is the `demo/` application actually running,
on the [nodepod](https://www.npmjs.com/package/@scelar/nodepod) browser-native
Node.js runtime, in the visitor's own tab.  Nothing is captured ahead of time:
Direct Run really invokes provider methods, runtime traces and Direct Run
history really accumulate, and the JSDoc and parameter types in the graph come
from the sources of the application that is answering.

### The payload

`demo/scripts/build-nodepod-payload.ts` writes three files into
`site/public/nodepod-demo/`:

| File | What it is |
|---|---|
| `main.js` | The whole demo application bundled into one CommonJS file (~17 MB, ~2 MB gzipped) |
| `sources.json` | The demo's `.ts` sources plus a flattened `tsconfig.json`, so the library's ts-morph source reader still finds JSDoc and Direct Run parameter types |
| `manifest.json` | Revision, working directory, entry file, and the environment the application is started with |

### Two constraints shape this design

1. **Decorator metadata forces a tsc-then-bundle pipeline.**  Nest resolves
   constructor dependencies from `emitDecoratorMetadata` output, and TypeScript
   is the only compiler in this repository that emits it.  So the payload is
   built from the `nest build` output (`demo/dist/src/main.js`); esbuild only
   stitches the emitted JavaScript into a single file.  Bundling the
   TypeScript directly would produce an application whose providers cannot be
   injected.  Nest's optional peers (`@nestjs/microservices`,
   `@nestjs/websockets`, `class-validator`, `class-transformer`) stay external,
   so a missing feature fails where it would fail on a real machine.
2. **The service-worker scope rule forces a fetch bridge.**  nodepod would
   rather serve its virtual HTTP servers through a service worker, but it
   registers that worker with scope `/`, and GitHub Pages serves the site from
   `/nest-graph-inspector/` and cannot answer with `Service-Worker-Allowed`.
   The pod is therefore booted headless, and requests to the demo's servers are
   addressed under `<site base>/__nodepod__/<port>/…` and answered in the tab by
   a `fetch` bridge that calls `pod.request(port, …)`.
   `site/app/utils/nodepod-demo-endpoint.ts` owns that address space and is
   covered by `nodepod-demo-endpoint.test.ts`.

### What checks it

`pnpm --filter nest-graph-inspector-site run test:demo-payload`
(`site/scripts/verify-nodepod-payload.ts`) boots the built payload on the same
runtime — headless, on `worker_threads` instead of Web Workers — spawns it, and
reads the graph endpoint out of the startup log with the site's own parser.
It is the only thing that exercises the two couplings this design rests on: that
the bundle starts at all, and that the viewer link the library prints is still
in a shape the site can read. Every workflow that generates the site runs it
right after building the payload.

### Boot sequence

```
1. The visitor asks for it: "Run the demo application" in a docs preview, or
   "Open Demo" on /view
2. nodepod-demo store downloads manifest.json, main.js, and sources.json
3. Nodepod.boot({ files, workdir, env, headless: true })
4. The fetch bridge is installed for <site base>/__nodepod__/<port>/…
5. pod.spawn('node', ['main.js']) → the NestJS application starts
6. The store reads the printed viewer link out of the application's own startup
   log, and treats it as the bootstrap credential it is:
     - the endpoint keeps its path, rewritten onto the bridged address
     - the access token comes out of the URL and is handed to the graph store,
       which sends it as a header from then on
7. `/view` puts both in the tab's session and opens `/view/navigator`, which
   loads the graph through the same HTTP contract as any other endpoint
```

Nothing starts on its own. Downloading an application and booting a Node
runtime is not something a page should decide to do because it was scrolled
past, so every entry point is a click — and one pod then serves every preview on
the page and the viewer, so the payload is downloaded and the application booted
at most once per page load. A failure opens one dialog, wherever it was started
from, carrying what the application itself printed.

A viewer page names a view, not a graph, so a reload restores the endpoint from
the tab's session — and for the demo that endpoint is answerable only by the tab
that started it. `use-nodepod-demo-session.ts` recognises such an endpoint and
starts the demo again, which means a new port and a new token, so it replaces
the session rather than reusing it.

### What the payload build accommodates

The bundle is prepended with a few lines the application never sees, because the
browser runtime differs from Node in two ways it would otherwise fall over on:

- **Two `Buffer` implementations that do not recognise each other.**
  `require('buffer').Buffer` is not the global one, and each one's `isBuffer`
  rejects what the other made.  Express builds a response body with one and
  hands it to `etag`, which checks with the other, so every response from the
  demo's own REST routes is a 500.  The shim makes recognition symmetric and
  changes nothing about what is created.
- **A process ends when its event loop looks empty.**  Neither a virtual HTTP
  server nor an in-flight cross-origin `fetch` holds it open, and the inspector
  awaits one during startup — the npm lookup behind `latestVersion` in
  `information.json` — so without a timer the application exits underneath its
  own bootstrap, before it ever prints a viewer link.

Both belong to the runtime, not to the application, which is why they live in
the build rather than in `demo/src`.  `site/scripts/verify-nodepod-payload.ts`
calls one of the demo's own routes for exactly this reason: it is what fails
first when an accommodation stops working.

Known limitations, accepted deliberately:

- `SharedArrayBuffer` is unavailable without COOP/COEP headers, so nodepod
  falls back to full per-spawn snapshots.
- The AI chat's Ollama proxy has nothing to proxy to inside a browser, and
  answers the way it would for an application with no Ollama running.
- The payload is a few megabytes, downloaded once per visit.
- The pod lives as long as the page. Nothing tears it down on a route change,
  and the keep-alive timer means it never idles out either.
- If the application stops after the graph has loaded, the viewer keeps showing
  that graph while every new request to it fails; the exit line in the demo
  console is the only signal.

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
   `lib/**`.
2. **The site has no NestJS runtime dependency.** It must consume graph data
   through the HTTP contract, never injectable services or decorators.
3. **`demo/src` is not the library.** Changes to `demo/src` are
   demo-only and must not alter the public API in `lib/**`.
4. **`GraphOutput` is a versioned contract.** Any breaking change to the shape
   must increment `GRAPH_OUTPUT_SCHEMA_VERSION` in
   `lib/src/types/graph-output.schema.ts` and
   update the corresponding JSON Schema.  The viewer enforces
   `MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION = 3`.
5. **Output adapters are pluggable via `OutputAdapter<Config>`.** New output
   types must implement this port interface.
6. **The HTTP server is framework-independent.** `HttpServeAdapter` uses plain
   `node:http` and must not gain an Express/Fastify dependency.
7. **The demo payload is bundled from compiled JavaScript.**
   `demo/scripts/build-nodepod-payload.ts` must keep its entry point on the
   `nest build` output.  Pointing the bundler at `demo/src/**` drops the
   decorator metadata Nest resolves constructor dependencies from, and the
   application fails to boot in the browser.

---

## Open questions

- No monorepo-level `pnpm-workspace.yaml` was found during inspection; the
  workspace membership of `lib/`, `demo/`, and `site/` is inferred from `.npmrc` and
  directory convention.  Clarify whether a workspace file exists or is
  intentionally absent.
- The `demo/test/app.e2e-spec.ts` test calls `GET /` and expects `"Hello
  World!"`, but no controller serving that route exists in `demo/src`.  This
  test appears to be a leftover scaffold and may always fail.
