# Changelog

All notable changes to the `nest-graph-inspector` package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Released versions are published from GitHub releases; the version in
`lib/package.json` on `main` is a placeholder and is not a released version.
See the [releases page](https://github.com/albasyir/nest-graph-inspector/releases)
for the published history.

## [Unreleased]

## [0.13.1] - 2026-10-04

### Changed

- **Centralized layout persistence under `ui.layout.saveAs: 'file' | 'runtime'`.** Layout persistence configuration is now configured centrally under `ui.layout.saveAs` (default `'file'`):
  - **File persistence target standardized to `./.muse`**: Target standardized to `./.muse` in the host project root, formatted with 2 spaces and serialized with atomic sequential writes.
  - **In-memory runtime persistence mode (`saveAs: 'runtime'`)**: Purely in RAM without modifying or creating files on disk.
  - **Removed legacy layout configuration**: Removed legacy output-level and module-level `layoutFilePath` configuration options.
  - **Exported updated public API types**: Exported updated public API types (`NestGraphInspectorUiOptions`, `NestGraphInspectorLayoutOptions`) and comprehensive documentation.

## [0.13.0] - 2026-10-04

### Added

- **Architecture Health & Diagnostics dashboard.** The Graph Issues page (`/view/issues`) has been upgraded from a basic circular dependency reporter into a comprehensive Architecture Health & Diagnostics dashboard for NestJS applications, analyzing `GraphOutput` for critical architectural issues, dead code, and misconfigurations:
  - **5 deterministic issue analyzers**:
    - **Circular Dependencies** (`error`): Detects module and provider dependency cycles with complete cycle paths and visual indicators.
    - **Duplicate Provider Registration** (`error`): Identifies provider tokens and classes registered across multiple modules without shared exports, preventing accidental duplicate singleton state divergence.
    - **Unused Module Imports** (`warning`): Detects modules imported by another module where none of their exported providers or controllers are injected or re-exported.
    - **Dead / Unconsumed Exports** (`info`): Flags providers exported by a module that are never injected or re-exported anywhere across the graph.
    - **Disconnected / Orphan Modules** (`warning`): Highlights standalone modules unreachable from the root application module via the import graph.
  - **Metric summary cards & category filter tabs**: Displays total issue count alongside error, warning, and cleanup metrics, with dedicated filter tabs showing per-category counts for targeted inspection.
  - **Interactive cycle diagrams & remediation guidance**: Issue cards provide concrete remediation advice and expand interactive SVG cycle diagrams for circular dependencies.
  - **Seamless Focus in Graph navigation**: Direct links from issue cards to `/view/navigator?focus-module=<ModuleName>` smoothly pan and frame the relevant module in the graph canvas.

## [0.12.0] - 2026-10-04

### Added

- **Distinct edge coloring by dependency type with semi-transparent blending.** The interactive graph viewer now visually distinguishes dependency lines by relationship type across both dark and light themes:
  - Module-to-module imports render in cyan (`#38bdf8`).
  - Provider-to-provider injections render in emerald (`#34d399`).
  - Controller-related dependencies render in purple (`#c084fc`).
  - Circular dependencies closing a cycle render in warning amber (`#fbbf24`).
  Edge paths and arrowheads use calibrated semi-transparent stroke opacities (0.4 base, 0.7 on hover, 0.95 when selected) and CSS `mix-blend-mode` (`screen` in dark mode, `multiply` in light mode) so intersecting and overlapping dependency paths blend cleanly rather than occluding one another.
- Added a `showControllerLines` toggle in the Graph Settings popover to optionally show or hide all controller dependency lines across the canvas.
- Updated the GraphViewer Legends card with visual swatches and indicators for each dependency line type and color.
- **Aggregated provider dependency lines for collapsed modules.** When a module is minimized or collapsed, internal providers and controllers are hidden from the canvas, and external dependencies entering or leaving them are dynamically aggregated and redrawn to or from the collapsed module container node. Dependencies connecting two collapsed modules are routed module-to-module, while internal dependencies between items within the same collapsed module are cleanly omitted. Aggregated lines preserve circular dependency detection and controller visibility gating.
- **Module zoom-to-focus action button beside minimize toggle.** Added a dedicated zoom-to-focus button in module headers next to the minimize/expand toggle. Triggering focus performs a smooth, animated camera transition (`fitView`, 650ms duration, 0.2 padding) that smoothly frames the module. When expanded, the camera automatically bounds the module container and all its internal providers and controllers; when collapsed, it neatly frames the collapsed module container.

## [0.11.0] - 2026-10-03

### Added

- **Persistent graph layout.** The interactive viewer now saves where you have
  arranged a graph's modules, providers, and controllers to a layout file in
  the host application's working tree — `./nest-graph-layout.json` by default —
  so the arrangement survives a page reload and can be committed to source
  control and shared with the rest of the team, instead of being recomputed
  from scratch in every browser tab.
- `layoutFilePath` is configurable on `NestGraphInspectorModuleOptions`,
  module-wide, and per `http` or `viewer` output. The output's own value wins
  over the module-wide one, which wins over the default, and a relative path
  resolves against `process.cwd()`.
- `GET /__graph-inspector/layout.json` and `GET /__graph-inspector/layout` read
  the saved layout from disk, returning the default empty layout,
  `{ version: '1', modules: {} }`, when no file exists yet.
  `POST /__graph-inspector/layout` and `POST /__graph-inspector/layout.json`
  are token-guarded: they validate the request body as a `GraphLayout` and
  persist it as formatted JSON, with writes to one file serialized so two
  overlapping saves cannot interleave into invalid JSON.
- A standalone recursive validator checks every layout before it is accepted
  or served — `additionalProperties` is rejected throughout, a `__proto__` key
  is refused outright rather than merged, and every coordinate must be a
  finite number. `GraphLayout`, `GraphLayoutModule`, `GraphLayoutPosition`,
  `validateGraphLayout`, `GRAPH_LAYOUT_SCHEMA_VERSION`,
  `GRAPH_LAYOUT_SCHEMA_ID`, and `GRAPH_LAYOUT_JSON_SCHEMA` are now exported
  from `lib`.
- **Incremental layout engine.** When a graph grows a module, provider, or
  controller that a saved layout does not know about, every node the layout
  does know about keeps its exact saved coordinates. A new module is placed in
  open canvas space by a non-overlapping bounding-box search run adjacent to
  the modules it imports or is imported by; a new provider or controller
  inside an existing module takes the next available slot in that module.
- The viewer gained a "Save layout" button with Saving / Saved / Error states,
  an "Auto layout" button that discards the saved arrangement and recomputes
  one, and a status badge showing whether the current arrangement is clean or
  has unsaved changes. Where there is no writable inspector endpoint to save
  to — the static demo viewer, or a library predating these routes — saving
  falls back to a downloaded file, and reading falls back to an in-memory or
  `sessionStorage` bridge, instead of the HTTP layout routes.

## [0.10.0] - 2026-10-03

### Added

- Direct Run now reaches controller methods, not just providers. A request
  names an explicit `target` (`"provider"` or `"controller"`, defaulting to
  `"provider"` so every existing client keeps working unmodified), and the
  server resolves it only against that target's own instance table — a
  provider and a controller sharing a name can never be confused for one
  another, and an unrecognised or mismatched target is a deterministic
  rejection. The graph now carries `directRun` metadata for controllers too,
  including an optional `http: { method, path }` per method read from Nest's
  own route metadata when available; the path does not include a
  `RouterModule` mount path, the global prefix, URI versioning, or any
  prefix but the first. Controller permissive mode is stricter than provider
  permissive mode by design: only a direct controller method — a
  function-valued own property of the instance, or a method declared on the
  controller's own class — may be invoked, and the constructor, Nest
  lifecycle hooks, getters (refused without running), and inherited methods
  are refused, even with `allowUnsafeMethods: true`. As with providers, this
  is direct JavaScript method invocation for debugging, not a Nest HTTP
  request pipeline — it does not simulate guards, interceptors, pipes, or
  parameter decorators. The viewer's execution sequence does not offer to
  re-run a controller span, since a trace does not record whether a class
  was a provider or a controller. See `docs/controller-direct-run-design.md`
  for the full design.
- Direct Run's `allowUnsafeMethods` and `maxBodySizeBytes` are now configurable
  per `viewer` output, or module-wide via `NestGraphInspectorModuleOptions.directRun`.
  `allowUnsafeMethods` defaults to `true`: any callable method on a provider's
  instance or prototype chain may be invoked, including ones TypeScript marks
  `private` or `protected`, favoring local development ergonomics over strict
  enforcement. Set it to `false` to restrict calls to the exact public methods
  advertised in that provider's Direct Run metadata. `maxBodySizeBytes` bounds
  the encoded request body Direct Run reads and defaults to 50 MiB, up from
  the previous fixed 1 MiB limit; set it to `0` or a negative number to remove
  the limit.
- `DiscoveryAdapter`'s runtime-trace instrumentation refuses to wrap prototypes
  shared by every object of their kind — `Object.prototype`, `Array.prototype`,
  `Function.prototype`, `Map.prototype`, `Promise.prototype`, and the rest of
  the built-ins — before any `defineProperty` call reaches them, so a provider
  whose prototype chain bottoms out at a plain object literal, array, or bare
  function is left uninstrumented instead of patching a shared prototype for
  the entire process.
- Each instrumented method's original, unwrapped implementation is now kept in
  a `WeakMap` so it can be recovered after tracing wraps it, fixing Direct
  Run's parameter-name extraction, which previously read the wrapper's own
  `(...args)` signature instead of the original method's parameter names.
- The graph viewer's AI chat now runs the model inside your browser. Pick a
  model, wait once for its weights to download into the browser cache, and every
  answer after that is generated on your own GPU through WebGPU — no daemon, no
  API key, nothing to install, and neither your graph nor your questions leave
  the machine. The chat needs a WebGPU-capable browser and says so up front
  instead of failing when you ask something; the rest of the viewer works
  everywhere it did before.
- The AI chat now answers on any graph the viewer can show, the in-browser demo
  and a graph read from disk included, so "Open Demo" is enough to try it
  without pointing the viewer at an application of your own. Answering used to
  mean reaching a proxy the inspected application served — which a demo running
  inside your tab has no way to reach, and a directory of static files does not
  serve at all. Now that the model runs in the browser, the graph's Markdown is
  all the chat needs. A graph emitted by a pre-v3 library is still the one case
  the chat stays off for.
- The viewer's AI chat can now answer by **looking things up in the graph**
  instead of reading an excerpt of it. In agent mode the model is given six
  read-only tools — list the modules, describe one, find a provider, trace a
  dependency chain, list the cycles, search the graph — and it calls them until
  it can answer. Every tool call and its result is shown in the transcript, so a
  slow answer is legible rather than a silence. The chat picks the mode that
  suits the graph on screen (looking things up wins once the graph stops fitting
  the 4096-token window; a single streamed answer is quicker on a small one) and
  a button in the prompt footer switches it either way.
- **Agent mode runs on every model in the list, including the recommended Qwen3
  1.7B at about 2 GB of VRAM.** It is not restricted to the tool-tuned Hermes
  builds. web-llm's own function-calling path does refuse anything outside a
  five-model allowlist, so the chat does not use it: it writes the tool schemas
  into the system prompt itself and constrains the decode with a grammar, and
  neither of those is looked up against a model list. What the Hermes builds
  (around 4 GB of VRAM, roughly twice the recommendation) actually buy is
  judgement — they pick the right tool more often and give up less — so they are
  offered as an optional upgrade and the panel says as much when a general model
  is selected. Nothing is disabled on that basis.
- The chat now fits the graph into the model's context window rather than
  sending all of it. The Mermaid diagram is dropped, whole module sections are
  kept until the budget runs out, and the model is told how many modules were
  left out, so a large graph produces an answer that admits what it could not
  see instead of one quietly built from a truncated prompt.
- The viewer shows the JSDoc a class was written with. Rest the pointer on a
  module title, a provider, or a controller and the comment above it appears
  beside the node; a node with nothing documented shows nothing, and the ones
  that do carry a dotted underline so you can tell them apart before hovering.
  The card can be read and scrolled without the pointer leaving it, and "Show
  JSDoc on hover" in the graph settings panel turns the whole thing off. The
  graph already carried these comments — this is the first surface that renders
  them, so no change to the library or the graph JSON was needed.
- The documentation site's demo is now the demo application itself, running in
  your browser on the [nodepod](https://www.npmjs.com/package/@scelar/nodepod)
  runtime, rather than a graph file committed into the site. Direct Run invokes
  real provider methods, runtime traces and Direct Run history accumulate as you
  use it, and the graph — JSDoc and Direct Run parameter types included — comes
  from the application that is answering. It starts when you ask for it — a
  preview waits behind "Run the demo application", and `/view` behind "Open
  Demo" — and the viewer header names it "Demo" rather than showing an address
  that only means something inside your tab.
- `pnpm --filter nest-graph-inspector-demo run build:nodepod` packages the demo
  for that runtime, and `pnpm --filter nest-graph-inspector-site run
  test:demo-payload` boots the packaged application headless and checks that it
  answers. Both run in CI ahead of every site build.
- Repository CI: lint, typecheck, tests on Node 20/22/24, and a full site build
  now run on every pull request and push to `main`.
- `lib` is linted (ESLint + typescript-eslint) and has a `typecheck` script.
- npm provenance attestation on published releases.
- Shared `tsconfig.base.json`, root `.editorconfig`, and `.nvmrc`.
- Community health files: contributing guide, code of conduct, issue and pull
  request templates, and this changelog.

### Changed

- The chat now talks to a LangChain chat model rather than to `@mlc-ai/web-llm`
  directly. This is an internal boundary with one purpose: which model answers is
  now a constructor argument, so putting a hosted provider behind the same panel
  later is a swap of one object instead of a rewrite. Nothing about running the
  model in your own browser changes — that is still the default and still the
  only provider on offer.
- The demo writes its graph files to `demo/tmp/graph/` instead of into the
  site's public directory. It is otherwise an ordinary NestJS project that knows
  nothing about running in a browser: what that runtime needs differently is
  prepended by the payload build.
- `lib` and `demo` compile under TypeScript `strict`.
- Spec files are type-checked. `ts-jest` no longer runs with `diagnostics: false`,
  so type errors in tests fail the build instead of being skipped.
- Published `.d.ts` files keep their JSDoc, and declaration/source maps ship with
  the package, so editors show option documentation and stack traces resolve.
- Releases run lint, typecheck, and tests before `npm publish`.
- pnpm no longer hoists dependencies (`shamefully-hoist=false`), so a package can
  only import what it declares.

### Removed

- **Breaking.** The Ollama proxy is gone. The `viewer` output no longer accepts
  an `ollama` option, `NestGraphInspectorOllamaProxyOptions` is no longer
  exported, and the library no longer opens a proxy or forwards a request
  anywhere. Delete the `ollama` key from your viewer output — passing it is now
  a type error — and stop running Ollama for the chat, which runs in the browser
  instead. Nothing else about the viewer output changes: the graph endpoint, the
  access token, and Direct Run are untouched.

  The feature never needed a server component, and the one it had was a relay:
  an endpoint installed in your application whose job was to take a
  caller-supplied body and send it to another origin. Removing it is the point,
  not a side effect.
- The committed graph fixture (`site/public/mock-graph/`) and
  `demo/scripts/mock-sync.ts`, which existed to keep it in step with the demo.
  The site runs the demo application instead.

### Fixed

- Direct Run now invokes only allowlisted public prototype methods and refuses
  lifecycle or unsafe methods, rejects requests over 1 MiB with `413`, defaults
  to enabled, retains the latest 100 trace records in FIFO order, and is covered
  by CI security end-to-end checks. The allowlist also excludes TypeScript-
  `private` methods, which compile down to ordinary callable prototype members
  and previously slipped through as "public" — Direct Run now reads the
  application's own sources to tell the two apart, the same way it already does
  for JSDoc and parameter types.
- The access token is built by encoding the HMAC digest buffer, rather than by
  asking `digest()` for `base64url`. A runtime that ignores that argument hands
  back raw bytes, and a token made of raw bytes does not survive the URL it
  travels in. On Node the token is unchanged.
- The npm lookup behind `latestVersion` in `information.json` is bounded to two
  seconds. It is awaited while the inspector installs its outputs — while your
  application is starting — so a network that neither answers nor refuses used
  to hold up `app.listen()` with it.
- The hosted graph viewer no longer keeps the inspector access token — or the
  graph endpoint — in its URL. The link printed by your application is spent on
  arrival, and the viewer settles on a plain `/view/navigator`, `/view/issues`,
  or `/view/execution-sequence`. The endpoint and token move into the tab's
  session, and every request authenticates with the `x-graph-inspector-token`
  header instead. This also repairs AI chat and Direct Run history in the viewer,
  whose URLs were built by appending a path onto a token-bearing query string.

  A viewer URL is therefore no longer shareable or bookmarkable: it names a view,
  not a graph. Reopening the printed link is how you get back to a graph, and a
  reload keeps working within the same tab. Links carrying the old
  `/view/<encoded>/issues` shape still land on the view they named.
- The graph viewer's entry page no longer discards the graph a tab is on. Its
  endpoint poller probes without committing, so visiting `/view` — or the
  viewer's own "Try Another URL" — and going back keeps the graph and its token.
- An unusable path below a viewer page (`/view/navigator/anything`) returns to
  the viewer entry page instead of waiting on a spinner that never resolves.
- Every `/view/**` page now requires the access token for the graph it would
  show. Without one the viewer returns to `/view`, since the token is no longer
  in the URL and the link printed by your application is the only thing that
  hands one over. A graph on the site's own origin is exempt from that check —
  which is where the bundled demo runs, though it prints and presents a token of
  its own like any other application. An inspector configured with
  `accessToken.enabled: false`, or with `accessToken.logToken: false`, prints a
  link carrying no token and cannot be opened in the hosted viewer.
- The graph viewer's reload button now stays busy for the whole reload rather
  than only its middle request, and the viewer shows its loading state for the
  whole of a reload started from the header.
- Retrying a graph that has stopped answering no longer reports the last reason.
  A 401 is not remembered across attempts, so an application that went down is
  reported as unreachable rather than as needing an access token — and an
  endpoint that never answered says so, instead of "no data received".
- `demo`'s test script no longer exits non-zero when it finds no tests.

