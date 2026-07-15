# Development Guidelines

## Where does my change belong?

Use this decision tree before opening a file:

```
Does the change affect what end-users install (the npm package)?
  YES → lib/src/**
  NO  → Does it affect the interactive viewer or documentation site?
          YES → site/**
          NO  → Is it a demo scenario for manual / exploratory testing?
                  YES → demo/src/**   (demo app only)
```

### `lib/**` — the library

Use this area when you are:
- Adding or modifying graph extraction logic.
- Implementing a new output adapter.
- Changing the `GraphOutput` type or JSON Schema.
- Modifying module configuration options (`NestGraphInspectorModuleOptions`).
- Fixing bugs in `NestGraphInspectorSetup`, an adapter, or a port.
- Adding or extending Direct Run / runtime trace behaviour.

Do **not** import frontend packages (`vue`, `nuxt`, browser globals) here.  
Do **not** use Express or Fastify; the HTTP layer uses plain `node:http`.

### `demo/src/**` — demo application

Use this area only to:
- Add, modify, or remove modules/providers that demonstrate library capabilities.
- Reproduce bugs using realistic NestJS scenarios.
- Generate updated mock graph fixtures for the site.

Changes here must **not** affect the library public API.  The demo app's
`AppModule` imports `NestGraphInspectorModule.forRoot()` as any consumer would.

### `site/**` — documentation + interactive viewer

Use this area when you are:
- Adding or updating documentation pages (`site/content/**`).
- Fixing or improving viewer UI, stores, composables, or components.
- Adjusting how the viewer reads, validates, or renders a `GraphOutput`.
- Changing the "Load Example" mock fixture (`site/public/mock-graph/`).

You may import TypeScript types from the library via the `@library` path alias,
but **never import library runtime code** (services, decorators, DI containers).

---

## Backward compatibility

### Library (public npm package)

- All exports listed in `lib/src/index.ts` are
  considered public API.  Do not remove or rename them without a major version
  bump.
- `NestGraphInspectorModuleOptions` fields must remain optional-compatible.
  Adding a required field is a breaking change.
- `GraphOutput` schema changes that drop or rename fields are breaking.
  Additive optional fields do not require a version bump, but the JSON Schema
  `const: '3'` must be updated when the shape changes meaningfully.
- Output adapters implement `OutputAdapter<Config>`; the interface signature
  must stay stable.

### Site

- The site's minimum supported graph version is pinned to
  `MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION = 3` in
  `site/app/stores/graph-inspector.ts`.  Update this constant when older
  payloads should be rejected.
- The site's compatibility check is the user-facing guard; keep it aligned with
  library releases.

---

## Public API and export rules

The library entry point is:

```
lib/src/index.ts
```

Rules:
1. Every symbol intended for consumers must be re-exported from `index.ts`.
2. Internal helpers (e.g. `HttpServeAdapter`, port implementations, internal
   type aliases) should **not** be added to `index.ts` unless explicitly needed
   by consumers.
3. The `@library` alias in the site imports types directly from source (not via
   the npm entry point); this is acceptable for types only and must not become
   a pattern for importing runtime code.

---

## Testing and validation commands

### Library unit tests

```bash
cd library
pnpm test            # runs Jest (*.spec.ts files in src/ and libs/)
pnpm test:watch      # watch mode
pnpm test:cov        # coverage report
```

Test files live alongside the source they test (`*.spec.ts` co-located in
`lib/src/adapters/` and at `lib/src/`).

### Library e2e tests

```bash
cd library
pnpm test:e2e        # Jest with test/jest-e2e.json config
```

> **Note:** `demo/test/app.e2e-spec.ts` appears to be a leftover NestJS
> scaffold (`GET /` expects `"Hello World!"`).  No controller serving that
> route exists in `demo/src`.  This test may fail without modification.

### Library linting and formatting

```bash
cd library
pnpm lint            # ESLint with auto-fix
pnpm format          # Prettier
```

### Site linting and type checking

```bash
cd site
pnpm lint            # ESLint
pnpm typecheck       # nuxt typecheck (vue-tsc)
```

### Site utility tests (assert-based, no framework)

Two plain Node.js test scripts exist in `site/app/utils/`:

```bash
node site/app/utils/direct-run-provider.test.ts
node site/app/utils/graph-viewer-load-source.test.ts
```

These use `node:assert` and print `ok` on success.  Run them directly with
ts-node or after compiling.

### Library dev server (for manual graph inspection)

```bash
cd library
pnpm dev    # starts the demo app; viewer URL is printed to console
            # sets ____DEV_VIEWER_BASE_URL=http://localhost:3000
```

### Site dev server

```bash
cd site
pnpm dev    # Nuxt dev server (connects to library dev for live graph)
```

---

## Adding a new graph capability

Follow these steps to keep implementation, demo, and frontend concerns
separated.

### 1. Define the data contract first

Add or extend types in:

```
lib/src/types/
```

Update the JSON Schema in `graph-output.schema.ts` if the `GraphOutput` shape
changes.  If the change is breaking, increment `GRAPH_OUTPUT_SCHEMA_VERSION`.

Re-export new types from `index.ts`.

### 2. Implement extraction in the library

Add or modify logic in `NestGraphInspectorSetup` (`nest-graph-inspector.setup.ts`).

Write a `*.spec.ts` unit test alongside the implementation.  Use
`@nestjs/testing` + Jest mocks to keep tests isolated.

If the capability adds a new output channel, implement `OutputAdapter<Config>`,
register it as a provider in `NestGraphInspectorModule`, and add it to the
adapter dispatch in `NestGraphInspectorSetup`.

### 3. Update the demo application

Add a representative module, provider, or scenario to `demo/src/` that
exercises the new capability.

Run `pnpm dev` in `demo/` and confirm the new data appears in
`/output.json`.

### 4. Regenerate the mock fixture (if the `GraphOutput` shape changes)

Copy the updated `output.json` from the running demo to
`site/public/mock-graph/output.json`.  Also update `output.md` if file output
is affected.

This fixture powers the "Load Example" button in the viewer.

### 5. Update the viewer (site)

If the new capability has a UI dimension:
- Import only TypeScript types (not runtime code) via `@library`.
- Add or update utility functions in `site/app/utils/`.
- Write an assert-based test (no framework) for any non-trivial logic.
- Update or add Vue components / composables in `site/app/`.

Do not fetch data from the library directly; read it from the already-loaded
`GraphOutput` in the Pinia store.

### 6. Update documentation

Add or update MDC pages in `site/content/`.  
Update `docs/graph-contract.md` if the contract changed.

---

## Open questions

- There is no monorepo-level `pnpm-workspace.yaml`; workspace membership is
  inferred by convention. Confirm whether `lib/`, `demo/`, and `site/` are
  officially in the same pnpm workspace.
- The `demo/test/app.e2e-spec.ts` e2e test appears to be a scaffold
  remnant.  It should either be updated to test the real demo app behaviour or
  removed.
- No CI pipeline runs the library unit tests automatically (`.github/workflows/`
  only contains `deploy-site.yml`).  Contributors must run `pnpm test` locally.
