# Maintainers Guide — Directory Ownership

This document covers every major directory in the repository.
Use it to determine where new code, tests, docs, or scripts belong before touching any files.

Related reading:
- `docs/architecture.md` — high-level data flow and architectural boundaries
- `docs/graph-contract.md` — the `GraphOutput` JSON contract
- `docs/development-guidelines.md` — decision tree, backward-compat rules, and step-by-step capability guide

---

## Quick reference

| Directory | What it is | Who changes it |
|---|---|---|
| `/` (root) | Monorepo plumbing | Maintainer |
| `.codex/` | AI-agent config | Maintainer |
| `.github/` | CI and community files | Maintainer |
| `docs/` | Contributor and maintainer docs | Anyone |
| `lib/` | Published npm package | Library agent |
| `lib/src/` | All library source code | Library agent |
| `lib/src/adapters/` | Output channel implementations | Library agent |
| `lib/src/ports/` | Port interfaces (contracts) | Library agent |
| `lib/src/types/` | Public TypeScript types + JSON Schema | Library agent |
| `demo/src/` | Demo / development app | Library agent |
| `demo/test/` | E2E tests for the demo app | Library agent |
| `demo/scripts/` | Mock-fixture tooling | Maintainer |
| `demo/docs/` | Static HTML docs (legacy) | Maintainer |
| `lib/dist/` | Published package build output — never edit | Tooling |
| `demo/tmp/` | Runtime graph output — never commit | Dev only |
| `site/` | Nuxt 4 documentation + viewer | Frontend agent / maintainer |
| `site/app/` | Nuxt app directory | Frontend agent |
| `site/app/assets/` | Global CSS | Frontend agent |
| `site/app/components/` | Vue components | Frontend agent |
| `site/app/composables/` | Auto-imported Vue composables | Frontend agent |
| `site/app/layouts/` | Page layout wrappers | Frontend agent |
| `site/app/pages/` | Route pages | Frontend agent |
| `site/app/stores/` | Pinia state stores | Frontend agent |
| `site/app/utils/` | Framework-agnostic utility functions | Frontend agent |
| `site/content/` | MDC documentation pages | Anyone |
| `site/public/` | Static assets served as-is | Frontend agent / maintainer |
| `site/public/mock-graph/` | "Load Example" fixture data | Maintainer (generated) |
| `site/server/` | Nitro server-side handlers | Frontend agent |
| `site/server/mcp/tools/` | MCP tool definitions | Frontend agent |
| `site/server/routes/` | Nitro API routes | Frontend agent |
| `site/.claude/` | Claude AI agent skill references | Maintainer |

---

## Root `/`

**Purpose:** Monorepo coordination layer.

**What belongs here:**
- `pnpm-workspace.yaml` — declares `library` and `site` as workspace packages.
- `package.json` — private root manifest; holds the monorepo name and `packageManager` field only.
- `pnpm-lock.yaml` — shared lockfile managed by pnpm.
- `package-lock.json` — appears to be a secondary lockfile; its presence alongside `pnpm-lock.yaml` is unusual (see Open questions).
- `.npmrc` — `shamefully-hoist=true`; required because some packages assume a flat `node_modules`.
- `.gitignore`, `.gitattributes` — repo-wide VCS hygiene.
- `README.md` — project overview, quick start, and links.
- `SECURITY.md` — vulnerability reporting policy.
- `LICENSE` — MIT.
- `AGENTS.md` — AI-agent delegation rules for the whole repo.

**What does NOT belong here:**
- Application source code.
- Package-specific dependencies.
- Build artifacts.

**Important dependencies:** None beyond pnpm itself.

**Related:** `lib/`, `demo/`, `site/`, `.github/`.

---

## `.codex/`

**Purpose:** Configuration for Codex CLI multi-agent orchestration.

**What belongs here:**
- `config.toml` — top-level agent settings (`max_threads = 4`, `max_depth = 1`).
- `agents/frontend.toml` — definition for the `frontend` sub-agent; scoped to `site/**`.
- `agents/library.toml` — definition for the `library` sub-agent; scoped to `lib/**` and `demo/**`.

**What does NOT belong here:**
- Application code, tests, or scripts.

**Important dependencies:** Codex CLI.

**Related:** `AGENTS.md`, `demo/AGENTS.md`, `site/AGENTS.md`.

---

## `.github/`

**Purpose:** GitHub-specific automation and community files.

### `.github/workflows/deploy-site.yml`

The release pipeline. It triggers when a GitHub release is published:
1. Checks out the release tag, installs dependencies, derives the package version from that tag (removing a leading `v`), builds `nest-graph-inspector`, and publishes it to npm.
2. After publishing succeeds, checks out the same release tag, generates the Nuxt site with the GitHub Pages preset, and uploads the static site artifact.
3. Deploys that artifact to GitHub Pages.

**Note:** There is no CI pipeline that runs library unit tests (`pnpm test`) or linting. Those must be run locally before merging.

### `.github/dependabot.yml`

Watches `npm` packages at `/` (root) on a weekly schedule. Does not separately watch `lib/`, `demo/`, or `site/` subdirectories.

**Uncertain:** Whether Dependabot picks up `demo/package.json` and `site/package.json` through the root config is not confirmed from config inspection alone.

### `.github/FUNDING.yml`

Donation links (GitHub Sponsors, Saweria). Not a technical file.

**What does NOT belong here:**
- Manual library publishing scripts; the release workflow builds and publishes the package.

---

## `docs/`

**Purpose:** Contributor and maintainer technical documentation.

**What belongs here:**
- Architecture decisions, contracts, and guidelines targeted at contributors and AI agents.
- Files in this directory are separate from the user-facing documentation site (`site/content/`).

**Current contents:**
- `architecture.md` — repo structure, data flow, and architectural boundaries.
- `graph-contract.md` — the `GraphOutput` JSON contract.
- `development-guidelines.md` — decision tree and step-by-step capability guide.
- `maintainers-guide.md` — this file.

**What does NOT belong here:**
- User-facing installation or configuration docs (those live in `site/content/`).
- Generated files.

**Related:** `site/content/`.

---

## `lib/` and `demo/`

**Purpose:** `lib/` is the published NestJS package. `demo/` is its NestJS demo and development host, including e2e tests, mock-fixture tooling, and legacy static docs.

**Owner:** `library` agent (see `demo/AGENTS.md`).

**Important workspace files:** `lib/package.json` and `lib/tsconfig.lib.json` define the published package. `demo/package.json`, `demo/nest-cli.json`, `demo/tsconfig.json`, and `demo/tsconfig.build.json` define the Nest demo host.

---

### `lib/`

**Purpose:** The single publishable package (`nest-graph-inspector` on npm). Everything inside is part of the public contract.

**`package.json` highlights:**
- `"name": "nest-graph-inspector"`, `"version": "0.3.0"`
- `"main": "./src/index.js"` — points to compiled output (`dist/libs/nest-graph-inspector/src/` after build).
- `peerDependencies`: `@nestjs/common ^10 || ^11`, `@nestjs/core ^10 || ^11`.
- Only one runtime dependency: `ts-morph ^28` (used for JSDoc and Direct Run method extraction).

**`tsconfig.lib.json`:** Extends root config; compiles `src/**` into `../../dist/libs/nest-graph-inspector`.

---

### `lib/src/`

**Purpose:** All library source code. This is the only directory that gets compiled and published.

**What belongs here:**
- NestJS module (`nest-graph-inspector.module.ts`), setup service, config builder.
- Output adapters (one file per output channel).
- Port interfaces.
- Public TypeScript types and JSON Schema.
- Runtime trace recorder.
- `index.ts` (the public entry point — only symbols exported here are public API).
- Unit tests (`*.spec.ts`) co-located with the files they test.

**What does NOT belong here:**
- Demo application code.
- Frontend packages or browser APIs.
- Express/Fastify adapters (HTTP layer uses plain `node:http`).

---

#### `lib/src/index.ts`

**Purpose:** The single public entry point. Only symbols re-exported here are part of the public API.

**Rule:** If you add a new type or class intended for consumers, re-export it here. If it's internal, do not add it.

---

#### `lib/src/nest-graph-inspector.module.ts`

**Purpose:** The NestJS `@Module` consumers import. Holds `defaultOptions` and registers all providers.

**Belongs here:** Module registration, default configuration values.

**Does not belong here:** Business logic (that goes in `NestGraphInspectorSetup`).

---

#### `lib/src/nest-graph-inspector.setup.ts`

**Purpose:** The `OnModuleInit` service that drives all graph extraction. The largest single file in the library.

Responsibilities:
- Walk `ModulesContainer` to build an internal `ModuleMap`.
- Extract JSDoc from source via ts-morph.
- Extract Direct Run method signatures via ts-morph.
- Enrich `ModuleMap` → `GraphOutput` (dependency refs, cycle detection).
- Dispatch `GraphOutput` to all configured output adapters.

**Belongs here:** Graph extraction, enrichment, and cycle detection logic.

**Does not belong here:** HTTP serving, file I/O, or proxy behaviour (those are in adapters).

---

#### `lib/src/nest-graph-inspector.type.ts`

**Purpose:** Public configuration types for consumers.

Contains `NestGraphInspectorModuleOptions`, `NestGraphInspectorOutput` (the union of all output channel configs), and related option types.

**Rule:** Any new option exposed to consumers must be added here and documented with a JSDoc comment.

---

#### `lib/src/nest-graph-inspector.config.ts`

**Purpose:** Wires `ConfigurableModuleBuilder` so consumers can call `NestGraphInspectorModule.forRoot()` and `forRootAsync()`.

**Belongs here:** Only the builder setup. Do not add logic here.

---

#### `lib/src/adapters/`

**Purpose:** One file per output channel. Each adapter implements `OutputAdapter<Config>` from `ports/output.adapter.ts`.

| File | What it does |
|---|---|
| `http-serve.adapter.ts` | Standalone `node:http` server; shared by all HTTP-based adapters |
| `http-output.adapter.ts` | Registers JSON, Markdown, schema, and information routes on an HTTP server |
| `viewer-output.adapter.ts` | Delegates to `http-output`, `proxy`, and `direct-run` adapters; prints viewer URL |
| `file-output.adapter.ts` | Writes Markdown dependency graph to disk; also builds Markdown text for HTTP |
| `json-output.adapter.ts` | Writes raw `GraphOutput` JSON to disk |
| `proxy.adapter.ts` | Forwards requests to Ollama; handles CORS for the viewer origin |
| `direct-run-output.adapter.ts` | Registers provider method execution, history, and trace routes |

**What belongs here:** Implementations of `OutputAdapter<Config>`. Each adapter file must have a co-located `*.spec.ts`.

**What does NOT belong here:** Graph extraction logic (that belongs in `nest-graph-inspector.setup.ts`).

**Important dependency:** `http-serve.adapter.ts` is an internal class shared by the other adapters; it is **not** exported from `index.ts`.

---

#### `lib/src/ports/`

**Purpose:** Port interfaces — the stable contracts that adapters implement.

| File | Contract |
|---|---|
| `output.adapter.ts` | `OutputAdapter<Config>` — `execute(graphOutput, config): Promise<{ message }>` |
| `proxy.gateway.ts` | `ProxyGateway` — `serve(options): Promise<void>` and `close(): void` |

**Rule:** Interfaces here define boundaries. Change them only when a breaking change is intentional and version-coordinated.

---

#### `lib/src/types/`

**Purpose:** All type definitions that cross the library–site boundary or form the public contract.

| File | What it defines |
|---|---|
| `graph-output.type.ts` | `GraphOutput` and all its nested types (public contract) |
| `graph-output.schema.ts` | JSON Schema v3 + `GRAPH_OUTPUT_SCHEMA_VERSION` constant |
| `direct-run.type.ts` | Direct Run types and `RuntimeTrace*` types (also used by the site) |
| `module-map.type.ts` | Internal `ModuleMap` (intermediate representation, not in public API) |
| `module.type.ts` | Internal `Modules` per-module record |
| `module-provider.type.ts` | Internal `ModuleProvider` with raw string dependencies |
| `module-controller.type.ts` | Internal `ModuleController` with raw string dependencies |

**Rule:** The `module-*.type.ts` files are internal intermediates. The `graph-output.type.ts` and `direct-run.type.ts` files are public. Any new public type must be added to `graph-output.type.ts` or `direct-run.type.ts` and re-exported from `index.ts`.

**Schema versioning rule:** When the `GraphOutput` shape changes in a breaking way, increment `GRAPH_OUTPUT_SCHEMA_VERSION` in `graph-output.schema.ts` **and** update the JSON Schema object. The site's version gate in `graph-inspector.ts` must be updated in the same change.

---

#### `lib/src/runtime-trace.recorder.ts`

**Purpose:** Implements `DirectRunTraceRecorder` using `AsyncLocalStorage` to record in-process call spans during Direct Run execution.

**Belongs here:** Span recording, context propagation, trace persistence.

**Does not belong here:** HTTP concerns (those are in `direct-run-output.adapter.ts`).

---

### `demo/src/`

**Purpose:** Demo / development application. Simulates a realistic consumer of the library.

**Structure:**
```
src/
├── main.ts           — bootstrap (NestFactory, listens on port 8889)
├── app.module.ts     — root module; imports NestGraphInspectorModule.forRoot()
├── user/             — User feature (UserModule, UserService, UserController, UserRepository, UserSchedule)
├── product/          — Product feature (circular dep with MobileModule)
├── order/            — Order feature (intentional forwardRef circular dep)
└── mobile/           — Mobile feature (cross-feature dep)
```

The demo intentionally includes:
- Cross-module dependencies (UserService → MobileService → ProductService).
- A circular import between ProductModule and MobileModule.
- A `forwardRef` circular dependency between OrderService and OrderNotificationService.

This makes the demo useful for verifying cycle detection, dependency enrichment, and Direct Run metadata.

**What belongs here:**
- Realistic feature modules that exercise library capabilities.
- Modules that demonstrate specific scenarios (circular deps, forwardRef, JSDoc extraction).

**What does NOT belong here:**
- Reusable library implementation. If logic could be used by a real consumer, it belongs in `libs/`.
- Production code.

**Important:** `demo/src/app.module.ts` uses the path alias `nest-graph-inspector/nest-graph-inspector` which maps to `libs/nest-graph-inspector/src` via `tsconfig.json` paths.

**Related:** `demo/tmp/graph/` (runtime output), `demo/scripts/mock-sync.ts` (syncs output to site fixture).

---

### `demo/test/`

**Purpose:** E2E tests for the demo application.

**Contents:**
- `app.e2e-spec.ts` — Jest + Supertest test that imports `AppModule`.
- `jest-e2e.json` — Jest config for e2e; uses `testRegex: ".e2e-spec.ts$"` and maps the `nest-graph-inspector/nest-graph-inspector` alias.

**⚠️ Known issue:** `app.e2e-spec.ts` was scaffolded by the NestJS CLI and still contains a `GET /` → `"Hello World!"` assertion. No controller serving that route exists in `demo/src/`. This test fails as written. It should either be updated to reflect actual app behaviour or removed.

**What belongs here:** Integration tests that boot the full demo app via `AppModule`.

**What does NOT belong here:** Unit tests (those live co-located with source in `libs/`).

---

### `demo/scripts/`

**Purpose:** Demo development tooling. These scripts are run manually by the maintainer; they are not part of CI.

| File | What it does |
|---|---|
| `mock-sync.ts` | Copies `demo/tmp/graph/**` to `site/public/mock-graph/`; run after `pnpm dev` to refresh the "Load Example" fixture |

**Running scripts:** `mock-sync.ts` uses ts-node-style execution from `demo/`.

**What belongs here:** Scripts that touch `demo/`, `lib/`, or `site/` internals (mock-sync). Not application logic.

---

### `demo/docs/`

**Purpose:** Static HTML documentation site (appears to be a legacy or parallel docs artifact).

**Contents:** `index.html`, `diagram.html`, `logo.png`.

**Uncertain:** Whether this is actively maintained or was the predecessor to the current Nuxt docs site. The HTML files contain styled marketing content referencing the library, but the primary docs now live in `site/content/`. No script regenerates these files automatically.

---

### `lib/dist/`

**Purpose:** Build output from `pnpm build` (i.e., `nest build`).

Output structure: `dist/libs/nest-graph-inspector/src/**` (compiled `.js`, `.d.ts`, `.js.map`).

**Never edit these files.** They are regenerated on every build and included when the release workflow publishes the package.

---

### `demo/tmp/`

**Purpose:** Runtime output directory. When `pnpm dev` is run, the demo app writes the graph here.

**Contents at inspection time:** `tmp/graph/` containing `information.json`, `output.json`, `output.md`, and `direct-run/` history files.

**Never commit this directory.** It is gitignored. Use `demo/scripts/mock-sync.ts` to promote outputs to the site fixture when they need to be updated.

---

## `site/`

**Purpose:** Nuxt 4 application deployed to GitHub Pages at `https://albasyir.github.io/nest-graph-inspector/`. Serves two functions: user-facing documentation and the interactive graph viewer.

**Owner:** `frontend` agent (see `site/AGENTS.md`).

**Key config files:**
- `nuxt.config.ts` — Nuxt configuration; defines the `@library` alias, Nitro prerender rules, module registrations, analytics config.
- `content.config.ts` — `@nuxt/content` collection definitions (`landing` and `docs`).
- `package.json` — site-specific dependencies (Vue Flow, Monaco, LangChain, Pinia, Posthog, etc.).
- `tsconfig.json` — extends `.nuxt/tsconfig.json` (generated by Nuxt).
- `eslint.config.mjs` — extends auto-generated Nuxt ESLint config.
- `.editorconfig` — LF line endings, 2-space indent.
- `.env` / `.env.example` — only `NUXT_PUBLIC_SITE_URL` documented; used for OG Image generation.

**`@library` alias:** Resolves to `../library` from the site directory. Used exclusively for importing TypeScript types. Never import runtime code through this alias.

---

### `site/app/`

**Purpose:** Nuxt 4 app directory. All runtime frontend code lives here.

**What belongs here:** Vue components, pages, layouts, stores, composables, utilities, and assets.

**What does NOT belong here:** Server-side handlers (those go in `site/server/`), documentation content (that goes in `site/content/`), or static assets (those go in `site/public/`).

---

#### `site/app/assets/`

**Purpose:** Global CSS imported by Nuxt.

**Contents:** `css/main.css` — project-wide styles referenced in `nuxt.config.ts` under `css`.

**Belongs here:** Global CSS that applies across all pages.

**Does not belong here:** Component-scoped styles (those go in the component `<style>` block).

---

#### `site/app/components/`

**Purpose:** Vue SFC components auto-imported by Nuxt.

**Top-level components (viewer and layout):**

| Component | Role |
|---|---|
| `GraphViewer.vue` | Main Vue Flow graph rendering component |
| `AiChatDrawer.vue` / `AiChatPanel.vue` | AI assistant UI with Ollama integration |
| `CircularDependencyIssueCard.vue` | Card displaying a single circular dependency issue |
| `DirectRunSequenceDiagram.vue` | Mermaid sequence diagram for Direct Run traces |
| `ExecutionSequence.vue` | Full execution sequence view |
| `GraphInspectorUpdateModal.vue` | Modal shown when the graph version is unsupported |
| `JsonMonacoEditor.client.vue` | Monaco editor (client-only) for JSON viewing |
| `AppHeader.vue` / `AppFooter.vue` / `AppLogo.vue` | Layout chrome |
| `PageHeaderLinks.vue` | Links in page headers |
| `TemplateMenu.vue` | Template selection menu |
| `ProseCodeGroup.vue` | Custom prose code group for docs |

**`OgImage/` subdirectory:** OG Image templates rendered by `nuxt-og-image`.

**`content/` subdirectory:** Components used inside MDC documentation pages (auto-resolved by `@nuxt/content` via the `components/content/` convention).

| Component | Role |
|---|---|
| `PackageManagerCommand.vue` | Renders install/start commands for selected package manager |
| `RuntimeGraphPreview.vue` (and variants) | Interactive graph previews embedded in docs |
| `RuntimeAIChatPreview.vue` | AI chat preview in docs |
| `HeroBackground.vue` / `StarsBg.vue` | Visual elements for landing page |

**What belongs here:** Vue components used in pages, layouts, or docs.

**What does NOT belong here:** Business logic or data transformation (those go in `utils/` or `stores/`).

---

#### `site/app/composables/`

**Purpose:** Auto-imported Vue composables.

**Note:** The directory exists but was empty at inspection time. Any shared stateful logic that doesn't fit in a store and needs to be reactive belongs here.

---

#### `site/app/layouts/`

**Purpose:** Page layout wrappers applied via `definePageMeta({ layout: '...' })`.

| Layout | Used by |
|---|---|
| `default.vue` | Marketing / landing pages; wraps with header and CTA banner |
| `docs.vue` | Documentation pages; adds `AppHeader`, sidebar navigation, ToC |
| `viewer.vue` | Graph viewer pages (`/view/**`); adds toolbar, AI chat toggle, breadcrumbs |

**What belongs here:** Layout chrome that wraps pages. No page-specific logic.

---

#### `site/app/pages/`

**Purpose:** File-system routing. Nuxt maps file names to URL paths.

| Path | Route | Description |
|---|---|---|
| `index.vue` | `/` | Landing page; renders `landing` content collection |
| `[...slug].vue` | `/getting-started`, `/configuration`, etc. | Catch-all for docs pages; renders `docs` collection via `@nuxt/content` |
| `view/index.vue` | `/view` | Graph viewer entry; polls for a live endpoint, shows URL input |
| `view/[url]/index.vue` | `/view/:url` | Main graph view; loads `GraphOutput` for the encoded URL param |
| `view/[url]/issues.vue` | `/view/:url/issues` | Issue finder; lists circular dependency issues |
| `view/[url]/execution-sequence.vue` | `/view/:url/execution-sequence` | Execution sequence diagram for Direct Run traces |

**The `:url` parameter** is a base64url-encoded endpoint URL. It is decoded by the Pinia store.

**What belongs here:** Route entry points and page-level orchestration. Minimal logic; delegate to stores and composables.

---

#### `site/app/stores/`

**Purpose:** Pinia state stores. Global application state.

| Store | Purpose |
|---|---|
| `graph-inspector.ts` | Core store: fetches and validates `GraphOutput`; manages encoded URL, graph data, markdown, endpoint info, and UI flags |
| `package-manager.ts` | Persists the user's selected package manager (localStorage); used by `PackageManagerCommand.vue` |

**`graph-inspector.ts` key responsibilities:**
- Decodes the base64url param into an endpoint URL.
- Fetches `information.json` to validate the endpoint.
- Fetches `output.json` (`GraphOutput`) and validates schema version ≥ 3.
- Fetches `output.md` for the Markdown view.
- Detects "legacy" graph outputs and shows an upgrade modal.

**What belongs here:** Reactive state and async data-fetching logic that multiple components share.

**What does NOT belong here:** Component rendering logic or direct DOM manipulation.

---

#### `site/app/utils/`

**Purpose:** Framework-agnostic, pure TypeScript utility functions. Auto-imported by Nuxt.

| File | What it contains |
|---|---|
| `graph-viewer-analytics.ts` | PostHog event property builders; `resolveGraphViewerLoadSource` |
| `graph-viewer-load-source.test.ts` | Assert-based test for `graph-viewer-analytics.ts` (no framework) |
| `circular-dependency-issues.ts` | Derives `CircularDependencyIssue[]` from raw `GraphOutput.cycles` |
| `circular-dependency-flow.ts` | Builds Vue Flow node/edge data for circular dependency diagrams |
| `direct-run-provider.ts` | Helper types and functions for Direct Run UI (request building, result summarising, snapshot building) |
| `direct-run-provider.test.ts` | Assert-based test for `direct-run-provider.ts` (no framework) |
| `supported-runtime.ts` | Runtime and package manager constants; install command lookup table |

**Testing convention:** Tests here use `node:assert` with no framework. Run with `node <file>.ts` (requires ts-node or tsx).

**What belongs here:** Pure functions with no Vue/Nuxt dependencies. May import library types via `@library`.

**What does NOT belong here:** Vue reactivity, component logic, or direct store access.

---

### `site/content/`

**Purpose:** User-facing documentation written in MDC (Markdown with Vue components).

**Collection structure** (defined in `content.config.ts`):

| Section | Path prefix | Purpose |
|---|---|---|
| Landing page | `index.md` | Homepage content |
| Getting Started | `1.getting-started/` | What & Why, Requirements, Installation, Upgrade Guide |
| Configuration | `2.configuration/` | Overview, Outputs, Root Module |
| Guide (Internals) | `3.guide/` | How It Works |

**Numbering prefix** (`1.`, `2.`, `3.`, etc.) controls navigation order.

**`.navigation.yml`** in each section sets the section title and icon for the sidebar.

**What belongs here:** User-facing documentation about installing, configuring, and using the library. Content pages can embed components from `site/app/components/content/`.

**What does NOT belong here:** Contributor or maintainer documentation (that goes in `docs/`), or technical API references (integrate those into existing pages).

---

### `site/public/`

**Purpose:** Static files served verbatim at the site root.

| Path | What it is |
|---|---|
| `favicon.ico` | Browser favicon |
| `logo.png` | Project logo |
| `runtime-inspector-preview.png` | Screenshot used in docs |
| `mock-graph/` | Static fixture for "Load Example" |

---

#### `site/public/mock-graph/`

**Purpose:** The static graph fixture served when users click "Load Example" in the viewer.

**Contents:**

| File | Role |
|---|---|
| `information.json` | Endpoint discovery; includes `for`, `version`, `latestVersion`, `isLatestVersion`, and transport-specific `is-static` (`true` for static files; `false` for HTTP output). `latestVersion` is the npm registry's latest package version or `null` when unavailable or invalid; `isLatestVersion` exactly compares it with `version`. |
| `output.json` | Full `GraphOutput` v3 JSON from the demo app |
| `output.md` | Markdown representation of the same graph |
| `direct-run/history/index.json` | Index of mock trace history entries |
| `direct-run/history/<uuid>.json` | Individual mock runtime trace files |

**How it's generated:** Run the Nest demo app (`pnpm dev` in `demo/`), then run `demo/scripts/mock-sync.ts` to copy `demo/tmp/graph/**` here.

**Never edit these files by hand.** They must reflect actual library output. Always regenerate from the demo app.

`information.json` includes `for`, `version`, `latestVersion`, `isLatestVersion`, and transport-specific `is-static`: `true` for static files and `false` for HTTP output. `latestVersion` is the npm-registry version or `null` if the lookup is unavailable or invalid; `isLatestVersion` is an exact comparison with `version`.

---

### `site/server/`

**Purpose:** Nitro server-side code. Runs server-side during SSR/SSG and at edge runtime.

---

#### `site/server/mcp/tools/`

**Purpose:** MCP (Model Context Protocol) tool definitions exposed by the site to AI clients.

| File | Tool | What it does |
|---|---|---|
| `list-pages.ts` | `list-pages` | Returns all docs pages with title, path, and description |
| `get-page.ts` | `get-page` | Returns full content of a specific docs page |

Tools use `@nuxt/content` server utilities and `defineMcpTool` from `@nuxtjs/mcp-toolkit`.

**What belongs here:** MCP tools that expose documentation content to AI agents.

**What does NOT belong here:** Graph inspection logic or library-side MCP tools.

---

#### `site/server/routes/`

**Purpose:** Nitro API route handlers registered as file-based routes.

**Contents:** `raw/[...slug].md.get.ts` — serves raw markdown for any docs page; consumed by the `get-page` MCP tool.

**What belongs here:** Server-only API endpoints that the frontend or external tools call.

---

### `site/.claude/`

**Purpose:** Claude AI agent skill reference files.

**Contents:** `skills/integration-nuxt-4/references/` — references for Nuxt 4 integration patterns.

**Uncertain:** Whether this directory is actively maintained or populated. It was empty (beyond directory structure) at inspection time. It appears to be a workspace for AI-assisted development context.

---

## Dependency relationships between directories

```
lib/src/types/
    ↑ imported as types (via @library alias)
site/app/utils/
site/app/stores/

demo/src/ (demo app)
    ↑ generates runtime graph output
demo/tmp/graph/
    ↑ copied by
demo/scripts/mock-sync.ts
    ↑ produces
site/public/mock-graph/
    ↑ served to
site/app/stores/graph-inspector.ts  (via "Load Example" URL)

lib/src/
    ↑ compiled by nest build into
lib/dist/
    ↑ included in the package published by
.github/workflows/deploy-site.yml (on GitHub release publication)

site/content/
    ↑ queried by
site/server/mcp/tools/   (for MCP tools)
site/server/routes/raw/  (for raw markdown)
site/app/pages/[...slug].vue  (for docs rendering)
```

---

## Open questions

1. **`package-lock.json` at root** — A `package-lock.json` exists alongside `pnpm-lock.yaml`. This is atypical for a pure-pnpm workspace. Its origin (possibly from an `npm install` run accidentally) and whether it should be removed is unclear.

2. **`demo/docs/`** — The static HTML files (`index.html`, `diagram.html`) appear to predate the Nuxt docs site. It's unclear whether they are still maintained, regenerated by a script, or obsolete.

3. **Root `node_modules/`** — 1,212 packages are hoisted to the root (due to `shamefully-hoist=true`). This is expected for pnpm with hoisting, but the presence of a `package-lock.json` suggests npm may also have been run against the root at some point.

4. **`site/.claude/skills/`** — Directory structure exists but content was not found at inspection time. Its role in the development workflow is uncertain.

5. **`site/app/composables/`** — Directory exists but was empty at inspection time. Whether composables are expected to be added here or the directory is a placeholder is not documented.

6. **Dependabot scope** — The `dependabot.yml` watches `directory: "/"` with `package-ecosystem: "npm"`. Whether this covers `demo/package.json` and `site/package.json` in a pnpm workspace is not confirmed from config alone.

7. **No library CI** — Library unit tests and linting have no CI pipeline. Contributors must run `cd library && pnpm test && pnpm lint` locally before opening a PR.
