# Architecture — Nest Graph Inspector

## Repository layout

```
nestjs-devtool/           ← monorepo root (pnpm workspaces)
├── lib/                  ← published NestJS package
│   └── src/              ← all reusable library implementation
├── demo/                 ← Nest demo / development host
│   ├── src/              ← demo application
│   └── test/             ← e2e tests for the demo app
└── site/                 ← Nuxt 4 documentation + interactive viewer
    ├── app/              ← Nuxt app directory
    ├── content/          ← MDC documentation pages
    └── public/mock-graph/  ← static fixture used by "Load Example"
```

The root `package.json` is private and carries no scripts; it only declares the
pnpm workspace and `packageManager` field.

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
| `ViewerOutputAdapter` | Delegates to `HttpOutputAdapter` + `DirectRunOutputAdapter`; prints viewer URL |
| `FileOutputAdapter` | Writes Markdown dependency graph to disk |
| `JsonOutputAdapter` | Writes raw `GraphOutput` JSON to disk |
| `DirectRunOutputAdapter` | Registers provider method execution endpoints |
| `RuntimeTraceRecorder` | Records in-process call spans using `AsyncLocalStorage` |

Port interfaces under `src/ports/`:
- `OutputAdapter<Config>` — contract every output adapter implements.

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
library directly. The site has no direct source alias to the package; all graph
behaviour goes through the HTTP contract.

Key site modules:

| Path | Role |
|---|---|
| `app/stores/graph-inspector.ts` | Pinia store; fetches and validates `GraphOutput` from the live endpoint |
| `app/utils/circular-dependency-issues.ts` | Derives `CircularDependencyIssue[]` from raw `GraphOutput.cycles` |
| `app/utils/direct-run-provider.ts` | Helper types and functions for Direct Run UI |
| `app/utils/supported-runtime.ts` | Package manager constants and install command helpers |
| `app/composables/useWebLlmEngine.ts` | Owns the in-browser model: WebGPU support check, model catalog, download progress, streaming |
| `app/utils/web-llm-boundary.ts` | The wire shapes the engine and the chat model both speak, declared once |
| `app/utils/web-llm-langchain.ts` | `ChatWebLlm`: the engine dressed as a LangChain `BaseChatModel`, tool calling included |
| `app/utils/graph-agent-tools.ts` | The six tools the agent queries the graph with |
| `app/utils/graph-agent-run.ts` | The ReAct loop, with the cap that stops a small model looping |
| `app/composables/useGraphAgent.ts` | Agent mode as the panel sees it |
| `app/workers/web-llm.worker.ts` | Web worker the model runs in, so generation does not block the graph UI |
| `public/mock-graph/` | Static fixture (`output.json`, `output.md`, `information.json`) served from the site for "Load Example" |

### AI chat runs entirely in the browser

The AI assistant has no server side. `@mlc-ai/web-llm` downloads model weights
from HuggingFace into the browser's Cache API and runs inference on the visitor's
GPU through WebGPU, inside a web worker. The library's only contribution is the
graph Markdown the viewer already fetches from `/output.md`, which the site
budgets down to fit the model's context window before using it as the system
prompt. The graph, the question, and the answer never leave the machine, and
nothing has to be installed for the feature to work — at the cost of requiring a
WebGPU-capable browser, which the panel checks for before offering the chat.

### The chat talks to a LangChain model, not to web-llm

The panel never calls `@mlc-ai/web-llm`. It builds a `ChatWebLlm` — a LangChain
`BaseChatModel` wrapping the engine — and talks to that. The indirection buys one
thing, and it is the reason it exists: which model answers is a constructor
argument. Putting `@langchain/openai`, `@langchain/anthropic` or a later web-llm
release behind the same panel is a swap of one object, not a rewrite of the chat.
In-browser inference is the right default for a tool that discusses the
developer's own application, but it should not be the only thing this panel can
ever do.

The seam is `WebLlmStreamer` in `app/utils/web-llm-boundary.ts`: two functions,
`streamChat` and `interrupt`. `useWebLlmEngine` fills them from web-llm and
`ChatWebLlm` reads them, and neither knows anything else about the other — which
is also what makes the chat model, and the entire agent loop above it, testable
in a plain node script against a scripted engine, with no browser, no GPU and no
downloaded weights.

Tool calling is implemented on our side rather than delegated. web-llm has its
own function-calling path, but it refuses any model outside a five-entry list of
Hermes builds — and reading what it does once it accepts one shows the list is a
bet, not a capability: it interpolates the tool schemas into a system prompt,
constrains the reply with a JSON grammar, and parses the result back.
`ChatWebLlm` does both of those directly, so tools bind to **every** model in the
catalog, including the recommended 2 GB one. Constrained decoding is the stronger
half of that: a fine-tune makes well-formed output likely, a grammar at the
sampler makes it certain. What neither fixes is judgement — a 1.7B model still
picks the wrong tool sometimes — which is what the catalog's `toolCallingQuality`
is for, and it is a sentence the panel shows, never a condition it branches on.

Agent mode exists because the context window is 4096 tokens. The plain path puts
an excerpt of the graph Markdown in the prompt, and on a real application that
excerpt is most of the window and still not most of the graph. The agent inverts
it: almost no graph in the prompt, and six read-only tools the model queries for
the part the question needs. It is the better answer for a large graph and the
worse one for a small one, so the panel defaults by graph size and lets the
reader switch.

This replaced an HTTP proxy inside the library that forwarded chat requests from
the viewer origin to a local Ollama daemon. Deleting it removed a
request-forwarding relay from the library's attack surface: an endpoint installed
in the host application whose whole job was to take a caller-supplied body and
send it somewhere else. A feature that needs no server component should not ship
one, and the boundary the site consumes is now exactly the graph contract and
nothing more.

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
     - viewer → http + Direct Run endpoints + prints viewer URL
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

---

## Open questions

- No monorepo-level `pnpm-workspace.yaml` was found during inspection; the
  workspace membership of `lib/`, `demo/`, and `site/` is inferred from `.npmrc` and
  directory convention.  Clarify whether a workspace file exists or is
  intentionally absent.
- The `demo/test/app.e2e-spec.ts` test calls `GET /` and expects `"Hello
  World!"`, but no controller serving that route exists in `demo/src`.  This
  test appears to be a leftover scaffold and may always fail.
