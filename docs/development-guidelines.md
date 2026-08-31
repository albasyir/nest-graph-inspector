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
- Change what the documentation site demonstrates — the site runs this
  application in the visitor's browser.
- Change how the demo is packaged for the site
  (`demo/scripts/build-nodepod-payload.ts`). The application itself stays an
  ordinary NestJS project: anything the browser runtime needs differently
  belongs in that build, not in `demo/src`.

Changes here must **not** affect the library public API.  The demo app's
`AppModule` imports `NestGraphInspectorModule.forRoot()` as any consumer would.

### `site/**` — documentation + interactive viewer

Use this area when you are:
- Adding or updating documentation pages (`site/content/**`).
- Fixing or improving viewer UI, stores, composables, or components.
- Adjusting how the viewer reads, validates, or renders a `GraphOutput`.
- Changing how the site boots the in-browser demo or talks to it
  (`site/app/stores/nodepod-demo.ts`,
  `site/app/composables/use-nodepod-demo-graph.ts`,
  `site/app/utils/nodepod-demo-endpoint.ts`).

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

Plain Node.js test scripts exist in `site/app/utils/`:

```bash
pnpm --filter nest-graph-inspector-site run test
```

They are TypeScript, so they run through Node's type stripping — which is what
the `test` script passes. Running one file on its own needs the same flag:

```bash
cd site
node --experimental-strip-types --test app/utils/nodepod-demo-endpoint.test.ts
```

These use `node:assert` and print `ok` on success, and fail the run by throwing.

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

### Running the demo inside the site

The site's own demo is the demo application running in the browser, so it has to
be packaged before the site can serve it:

```bash
pnpm run dev    # from the root: builds the library, then the demo payload,
                # then runs the demo app and the site together

pnpm --filter nest-graph-inspector-demo run build:nodepod
                # refreshes the payload on its own after a demo change
```

`build:nodepod` runs `nest build` before
`demo/scripts/build-nodepod-payload.ts`, because the bundle has to be made from
the TypeScript output — that is what carries the decorator metadata Nest
resolves constructor dependencies from.  The payload is written to
`site/public/nodepod-demo/` and is gitignored, so it must be built before
`nuxt generate` in any fresh checkout; the CI and deploy workflows have a
dedicated step for it.

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

### 4. Refresh the demo payload the site runs

```bash
pnpm --filter nest-graph-inspector-demo run build:nodepod
```

The site boots this payload in the visitor's browser, so a demo change is not
visible on the site until the payload is rebuilt.  Nothing needs to be copied
into `site/public/` by hand — the script writes there, and the directory is
gitignored.

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

## Coding standards

This project adopts the **ECC coding standards** as its baseline. They are not
a project-specific invention and nothing here should be read as one: the source
of truth is the ECC plugin as installed, principally

- `skills/coding-standards/SKILL.md` — naming, immutability, KISS/DRY/YAGNI, error handling
- `agents/typescript-reviewer.md` — the CRITICAL/HIGH/MEDIUM rubric for TypeScript
- `skills/nestjs-patterns/SKILL.md` — NestJS structure and conventions
- `skills/hexagonal-architecture/SKILL.md` — ports and adapters
- `skills/api-design/SKILL.md` and `skills/error-handling/SKILL.md` — the HTTP surface

Where an ECC rule and [`architecture.md`](./architecture.md) disagree,
`architecture.md` wins — it is normative for this repository — and the
disagreement belongs in the carve-out list below rather than being resolved
silently in either direction.

A conformance pass over `lib/**` in August 2026 measured the package against
those documents: **51 ECC rules were confirmed satisfied**, and the deviations
that survived adversarial verification are filed in
[`technical-debt-report.md`](./technical-debt-report.md).

### Carve-outs — ECC rules that do not apply to `lib/**`

`lib/` is a library imported into someone else's NestJS application. Several
ECC rules assume a standalone application that owns its own `main.ts`. These
four are formally not applicable **to `lib/**` only** — `demo/src/**` is a real
application and follows the ECC rules as written.

**Project structure.** ECC's NestJS project-structure template (`src/main.ts`,
`src/app.module.ts`, `src/common/{filters,guards,interceptors,pipes}`,
`src/config/`, `src/modules/<feature>/{dto,entities}`) does not apply to
`lib/**`: it describes an application that owns its process and its Nest request
pipeline, whereas `nest-graph-inspector` is a single-entry-module published
library laid out as ports and adapters. The template's transferable intents —
domain code inside the module, types beside the code that owns them, one
auditable composition root — remain binding and are already satisfied by that
layout.

**Global bootstrap registrations.** ECC's "bootstrap with a single global
`ValidationPipe`, `ClassSerializerInterceptor`, and `useGlobalFilters(...)`"
cannot be adopted: this package has no bootstrap and must not acquire one.
Registering a global pipe or filter from a library would change how the *host's
own controllers* behave, which a diagnostic tool has no right to do.

**Response DTOs for Direct Run.** ECC's "use dedicated response DTOs or
serializers instead of returning ORM entities directly" does not apply to the
return value of `POST /direct-run` or the `/direct-run/history*` routes: the
endpoint exists to return whatever the invoked host provider method returned, so
the open `result` field is the feature rather than a leak, and the rule's
stable-contract obligation is discharged by the `DirectRunResult` envelope that
wraps it. The adjacent obligation to avoid leaking internal fields is **not**
carved out and continues to bind wherever the library retains that value,
re-serves it to a later caller, or writes it to disk.

**Resource naming and URL versioning.** ECC's plural-collection-noun and
`/api/v1/` rules do not apply to the inspector route table: those paths are a
versioned cross-package contract between `lib/` and the viewer in `site/`,
parsed out of the printed startup line under invariant 9 and asserted literally
in `site/app/utils/inspector-endpoint-url.test.ts`, and the API is already
versioned by `GRAPH_OUTPUT_SCHEMA_VERSION` against the viewer's
`MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION`. What still binds: a **new** inspector
route must match the conventions of the existing table rather than inventing a
third style.

### Mechanism substitutions — ECC's intent binds, its mechanism does not

These are not exemptions. The rule's obligation applies in full; only the
framework mechanism it prescribes is unavailable, and this is what replaces it.

| ECC rule | Why the mechanism fails here | What discharges it instead |
|---|---|---|
| `@Catch()` exception filter registered with `useGlobalFilters` | Needs an Express `Response` via `ArgumentsHost`; invariant 6 keeps the inspector on plain `node:http` | The single catch in `HttpServeAdapter.handleRequest` **is** this library's exception filter. It must answer the same JSON `{ ok: false, error }` envelope as every other route, return a generic message, and log the real error. Today it does none of these — see TD-24. |
| `@UseGuards(...)` / `CanActivate` / `@Roles` | Same — no Nest request pipeline | A `HttpServeAuthorize` function registered through `register({ authorize: accessTokenService.createHttpGuard() }, …)`. The rule's request-context half still binds: that function must return the verified `AccessTokenPayload` and the router must expose it to route callbacks, so a Direct Run audit line can attribute an invocation. |
| Validate every request DTO with `class-validator`; enable `whitelist` / `forbidNonWhitelisted` | No `ValidationPipe` ever runs, and `class-validator` is not a dependency of `lib/` | Hand-written validation in the adapter, with the same two guarantees: reject any key outside `['module','provider','method','args']` with a 400, and validate `args` against the `parameterTypes` the library already computes. Do not add a DTO class. |
| Terminate on invalid env/config instead of booting partially | A library must never abort a host's boot because port 53371 was taken | Terminate the affected **capability**, not the process. Output-adapter failures stay logged and swallowed. Security-relevant misconfiguration does not: a secret shorter than the documented 32-character minimum must stop being used, not merely warn. |
| Use-case code must not import framework types | The NestJS container is this library's subject matter and its lifecycle is the inbound adapter's trigger | `@Injectable()` and `OnModuleInit` on `NestGraphInspectorSetup` are exempt. The rule still binds to the graph-building logic inside it — cycle detection and type rendering import only `lib/src/types/**`. See TD-02. |
| Fail fast and loudly | An output failure reaching the host would abort its boot | The failure must still reach *someone who can act*, and for a library that is the importing application. Today the only channel is a log line, which `architecture.md` itself calls "easy to miss" — so this obligation is **not** currently discharged. An optional `onOutputError` hook would give a host the means to escalate; because it must default to a no-op to preserve the invariant, ECC's requirement is met only for hosts that opt in, and that residue is deliberate. |

### Where ECC does not reach

Adopting a ready-made standard buys consistency, not coverage. The August 2026
pass produced one clear example, and it is worth knowing before treating ECC
conformance as sufficient.

The most dangerous latent defect found in `lib/**` — TD-08, where bumping
`GRAPH_OUTPUT_SCHEMA_VERSION` silently fails to change the emitted graph while
every test still passes — was raised by the conformance pass and then
**correctly refuted** as an ECC finding. ECC's "HIGH — Type Safety" block
contains exactly four bullets (`any`, non-null assertions, unsafe `as` casts,
relaxed compiler settings) and none of them requires a contract field with one
known value to be typed as a literal. The verifier's conclusion was that the fix
"would be a genuine improvement — but it is a design suggestion, not an instance
of any ECC rule."

That is the correct call about ECC and the wrong outcome for this repository.
Two practical consequences:

1. **A clean ECC pass is a floor, not a verdict.** Contract-integrity questions —
   can the type system catch a version drift, can a test detect one — sit
   outside the rubric and need their own review.
2. **When a refuted finding is still real, file it on its own evidence** rather
   than dropping it because no rule covers it. TD-08 is filed that way, and
   this section is why.

If a rule this project needs turns out to be missing from ECC repeatedly, the
answer is a short project-specific supplement here — not a fork of ECC, and not
silence.

### Running a review

```bash
pnpm run verify   # build library → lint → typecheck → test → build workspace
```

`verify` does **not** run the demo's e2e suites. Any change to the access token,
the CORS policy, the bind interface, or the Direct Run surface additionally
requires a case in `demo/test/graph-inspector-security.e2e-spec.ts` and:

```bash
pnpm --filter nest-graph-inspector-demo run test:e2e
```
