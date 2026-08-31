# Technical Debt Report

**Scope:** `lib/**` (the published npm package). `demo/**` and `site/**` were not
audited in this pass except where a `lib/` contract reaches them. Three inherited
documentation findings that live outside `lib/` — TD-11, TD-12, TD-14 — were
re-checked for accuracy and are retained below, but their surfaces were not
audited afresh.
**Last revalidated:** 2026-08-31.
**Method:** Every finding below was read at the cited file and line. Findings
inherited from the previous edition of this report were re-checked against
current code rather than carried forward. Findings measured against the ECC
coding standards were additionally put through an adversarial refutation pass;
40% of the candidates (25 of 62) did not survive it and are not listed here.

> **How to read this document.** A finding's presence means the deviation was
> confirmed in code. It does not mean the deviation is wrong: `docs/architecture.md`
> is normative, and where it documents a decision deliberately, this report says
> so instead of demanding a change.

---

## What changed since the previous edition

The previous edition described a codebase without access control, without CI,
and with a site that reached into library internals. None of that is true now.
Four of its thirteen findings are fully resolved and its one Critical is
obsolete.

| ID | Previous claim | Status | Evidence |
|---|---|---|---|
| TD-01 | Default viewer exposes **unauthenticated** Direct Run | **Obsolete** | `AccessTokenService.createHttpGuard()` is attached at `viewer-output.adapter.ts:60` and `http-output.adapter.ts:70`; `http-serve.adapter.ts:75-76` propagates it to any route lacking one; `enabled` defaults to `true`. An anonymous `POST /direct-run` returns 401 — asserted in `demo/test/graph-inspector-security.e2e-spec.ts:154`. |
| TD-02 | `NestGraphInspectorSetup` is 1,619 lines | **Revised** → TD-02 below | Now 1,166 lines. The size claim shrank; the cohesion claim survived and is now evidenced. |
| TD-03 | Site imports library types from internal source paths | **Resolved** | No `nest-graph-inspector/src` import remains anywhere in `site/`; all imports go through the package entry point. |
| TD-04 | The only e2e test is a stale Nest scaffold | **Resolved** | `demo/test/` holds `app.e2e-spec.ts` and `graph-inspector-security.e2e-spec.ts`; no scaffold remains. |
| TD-05 | No CI runs library tests, lint, typecheck, or build | **Resolved** | `.github/workflows/ci.yml` runs a `verify` job, a `library-matrix` job on Node 20/22/24, and a full site build including the payload boot check. |
| TD-06 | Adding an output type requires four coordinated edits | **Unchanged** | Still four files. Documented as an extension-point cost in `architecture.md`. |
| TD-07 | Direct Run crosses the config boundary via casts | **Narrowed** → TD-07 below | The body-parsing casts improved; one intersection cast remains. |
| TD-08 | Schema version duplicated as literal and constant | **Relocated and worse** → TD-08 below | The duplication the report named is fixed; a more dangerous one replaced it. |
| TD-09 | CORS and path normalization duplicated across adapters | **Partly resolved** → TD-09 below | The CORS half is resolved — the second implementation went with the deleted proxy adapter. The `normalizePath` triplication was refuted as duplication, but a two-adapter coupling remains. |
| TD-10 | Provider and module cycles use incompatible path shapes | **Unchanged** | Still asymmetric; acknowledged in `architecture.md`. |
| TD-11 | User-facing documentation is stale | **Partly resolved** → TD-11 below | The README no longer calls Direct Run "coming soon"; `site/content/2.configuration/4.access-token.md` now exists. Two claims in `outputs.md` remain wrong. |
| TD-12 | Documentation ownership overlaps three directories | **Weakened** | `demo/docs/` is now three files (`index.html`, `diagram.html`, `logo.png`) and no longer a competing Markdown surface. Downgraded to Low. |
| TD-14 | `site/README.md` is the Nuxt template README | **Unchanged** | Still opens "# Nuxt Docs Template". |

There is no TD-13; the previous edition skipped the number.

---

## Priority summary

| Priority | ID | Finding |
|---|---|---|
| Critical | TD-15 | Any unauthenticated client can terminate the host process with one malformed request line |
| Critical | TD-16 | A discovery failure crashes the host application whenever a non-viewer output is configured |
| High | TD-17 | A history-write failure reports a successful Direct Run invocation as a 500 |
| High | TD-18 | Trace history, request bodies, and stored arguments are all unbounded |
| High | TD-19 | An unsettled promise in a traced call hangs the request forever |
| High | TD-20 | `defaultOptions` is a mutable singleton wired straight into DI and exported publicly |
| Medium | TD-08 | A schema-version bump silently does not reach the emitted graph, and no test fails |
| Medium | TD-21 | Direct Run reaches `constructor`, inherited methods, and getters it never advertises |
| Medium | TD-22 | Discovery silently drops dependencies and providers it cannot name |
| Medium | TD-23 | The Markdown output ignores the configured `nestCoreModuleName` |
| Medium | TD-24 | The router returns raw internal error messages and logs nothing |
| Medium | TD-25 | ts-morph parsing blocks the host's event loop inside a request handler |
| Medium | TD-02 | ~63% of `NestGraphInspectorSetup` is framework-free logic trapped in a DI class |
| Medium | TD-06 | Adding an output type requires four coordinated edits |
| Medium | TD-07 | An intersection cast smuggles internal config through a public options type |
| Medium | TD-10 | Provider and module cycles use incompatible path representations |
| Low | TD-09 | Path normalization is split across two adapters that must agree |
| Low | TD-11 | Two claims on the outputs documentation page contradict the code |
| Low | TD-12 | `demo/docs/` and `site/content/` still overlap as documentation surfaces |
| Low | TD-14 | `site/README.md` is still the Nuxt Docs Template README |
| Low | TD-26 | Four methods in `lib/src` are dead code |
| Low | TD-27 | The package has no formatter, and formatting has diverged |

---

## Critical

### TD-15 — One malformed request line terminates the host process, with no token

**Evidence.** Three properties combine, all in `lib/src/adapters/http-serve.adapter.ts`:

- `:156` — the server handler is invoked as `void this.handleRequest(...)`, with no `.catch()`.
- `:190` — `this.route(originUrl, routes, req)` runs **before** the authorization check at `:206` and **outside** the `try` that opens at `:216`.
- `:244` — `route()` builds the path with `new URL(req.url ?? '/', originUrl)` over the raw, unvalidated request target.

**Reproduced.** A standalone replica of this exact path, driven over a TCP
socket with the request line `GET http://[invalid HTTP/1.1` and **no
credentials**, produced `UNHANDLED_REJECTION: ERR_INVALID_URL` and exited
non-zero on Node v24.19.0. Node's parser accepts the absolute-form target
verbatim, `new URL` rejects the unterminated IPv6 literal, and the rejection has
no handler.

**Impact.** The whole host NestJS application dies, not just the inspector.
Because the throw precedes `route.authorize?.(req)`, the access token — the
control that `architecture.md` names as what makes the wide-open bind and CORS
policy safe — never runs. With the default bind of `0.0.0.0`, this is reachable
from the local network.

**Why this is debt.** `architecture.md`'s "Known deliberate risks" table accepts
network reachability *on the basis that the token protects it*. An
unauthenticated crash is outside that bargain and is not listed anywhere.

**Fix direction.** Wrap `handleRequest` so nothing escapes it — either a
top-level `try/catch` answering 400, or a `.catch()` on the `void` call — and
guard the `new URL` construction in `route()`. Per invariant 7, add a case to
`demo/test/graph-inspector-security.e2e-spec.ts` and run
`pnpm --filter nest-graph-inspector-demo run test:e2e` yourself; CI does not.

---

### TD-16 — A discovery failure crashes the host whenever a non-viewer output is configured

**Evidence.** `lib/src/nest-graph-inspector.setup.ts:119-124`:

```ts
if (eagerOutputs.length) {
  await this.publishOutputs({
    graphOutput: this.getGraphOutput(),   // evaluated here, outside any try/catch
    outputs: eagerOutputs,
  });
}
```

`getGraphOutput()` is an argument, so it is evaluated before `publishOutputs`
runs. The `try/catch` that `architecture.md` promises ("A failing output never
fails the application") lives one level deeper, in `publishSingleOutput`
(`:174-190`), and never covers discovery. `discovery.scan()` can throw — "Root
module not found", or a `SourceMetadataService` failure on a malformed
`tsconfig.json` — and the rejection leaves `onModuleInit`, which Nest treats as
a fatal bootstrap error.

**Impact.** The asymmetry is the dangerous part. A viewer-only configuration is
safe, because discovery is deferred into a route resolver that runs inside the
router's `try/catch` and degrades to a 500. Add one `json`, `markdown`, or
`http` output and the identical failure becomes a boot crash. Nothing documents
this difference.

**Fix direction.** Bring the first `getGraphOutput()` evaluation under the same
catch discipline as `publishSingleOutput`, so `onModuleInit` resolves with a
logged error whichever output type is configured.

---

## High

### TD-17 — A history-write failure turns a successful invocation into a 500

**Evidence.** `lib/src/adapters/direct-run-output.adapter.ts:68-114` computes the
real `DirectRunResult` first, then calls `onComplete(payload.runtimeTrace)`
unguarded before returning. `onComplete` is `writeHistoryFiles`
(`viewer-output.adapter.ts:139-162`), which does a `mkdir` and two `writeFile`s.
A rejection there propagates into the router's catch and answers 500.

**Impact.** The provider method already ran and may already have mutated state.
The caller is told it failed. For a tool whose purpose is invoking real service
methods, an operator seeing that 500 may retry a side effect that already
applied. This does not hide a failure — it manufactures one on top of a success.

**Fix direction.** Catch `onComplete` separately, keep the computed payload, and
signal persistence failure as a separate field rather than by changing `ok`.

### TD-18 — Trace history, request bodies, and stored arguments are all unbounded

**Evidence.** Three independent missing bounds:

- `runtime-trace.recorder.ts:31` — `completedTraces` is a `Map` that is never evicted.
- `direct-run-output.adapter.ts:170-188` — `readJsonBody` accumulates the entire request body into one string with no size cap and no `content-length` check.
- `runtime-trace.recorder.ts:422-433` — `previewValue` checks serializability but does not truncate, so arguments and return values are stored verbatim.

**Impact.** An authenticated caller can exhaust host memory, and `GET
/direct-run/histories` returns the whole collection in one response with no
pagination. When a `json` output is configured the same unbounded values are
also written to disk.

**Why this is debt rather than an accepted risk.** The repository already
solved this exact problem one file away: `access-attempt-limiter.ts` caps
`maxTrackedClients` at 1,000 explicitly "so the tracker cannot itself be grown
without limit". The pattern exists and was not applied here.

### TD-19 — An unsettled promise in a traced call hangs the request forever

**Evidence.** `runtime-trace.recorder.ts:172-241` — `finishTrace` calls
`markPendingSpansNotAwaited` and then `await this.waitForPendingSpans(traceId)`,
a `Promise.all` with no timeout and no race.
`direct-run-output.adapter.ts:76-79` awaits that before responding.

**Impact.** A fire-and-forget call inside a traced method that never settles —
a write to an unreachable service, say — leaves `POST /direct-run` with no
response and no log line. The `partial` status exists precisely to handle
un-awaited promises, but it only covers promises that eventually settle.

**Fix direction.** Bound `waitForPendingSpans`, reusing the timeout pattern
already established by `LATEST_VERSION_TIMEOUT_MS`, so the trace still completes
and reports `partial`.

### TD-20 — `defaultOptions` is a mutable singleton wired into DI and exported publicly

**Evidence.** `nest-graph-inspector.module.ts:19-39` declares `defaultOptions`
as a plain object — no `as const`, no `Object.freeze`, no `Readonly<>`. The same
object instance is the literal `useValue` for `MODULE_OPTIONS_TOKEN` (`:45`)
and is re-exported from `lib/src/index.ts`.

**Impact.** Any consumer or test that imports it and mutates a nested field —
`defaultOptions.outputs[0].port = 9999`, `defaultOptions.ignoreProvider.push(...)` —
changes the running configuration for every other inspector instance in the
process. Multiple modules booted in one Jest worker is the ordinary way to hit
this.

---

## Medium

### TD-08 — A schema-version bump silently does not reach the emitted graph

**This finding replaces the previous TD-08, which is fixed.** The literal-versus-constant
duplication it described is gone: `graph-output.schema.ts:12` now reads
`const: GRAPH_OUTPUT_SCHEMA_VERSION`. The duplication moved somewhere worse.

**Evidence.** The version exists in five places, three of them hardcoded:

| Location | Form | Derived from the constant? |
|---|---|---|
| `types/graph-output.schema.ts:1` | `GRAPH_OUTPUT_SCHEMA_VERSION = '3'` | source of truth |
| `types/graph-output.schema.ts:12` | `const: GRAPH_OUTPUT_SCHEMA_VERSION` | yes |
| `types/graph-output.schema.ts:5` | `$id: '…/graph-output-v3.schema.json'` | **no** |
| `nest-graph-inspector.setup.ts:275` | `version: "3"` | **no** — and the file never imports the constant |
| `nest-graph-inspector.setup.spec.ts:161,242` | asserts `version: "3"` | **no** |

`types/graph-output.type.ts:58` types the field as the wide primitive `string`,
so the compiler cannot relate the two either.

**Impact.** Following the bump procedure that `architecture.md` documents —
raise `GRAPH_OUTPUT_SCHEMA_VERSION` — changes the JSON Schema but leaves the
emitted graph announcing `"3"` and `$id` pointing at `v3`. **The library's own Jest
specs still pass**, because they assert the same literal the emitter still
produces — and nothing else gates it either: the demo's e2e suites do not assert
the schema version, and CI does not run them.
The viewer receives a v4 graph claiming to be v3 and renders it. The documented
upgrade path silently does not work, and the version gate that exists to make a
half-done bump visible is what fails first.

**Fix direction.** Import the constant in `setup.ts`, derive `$id` from it, and
narrow the contract type to `version: typeof GRAPH_OUTPUT_SCHEMA_VERSION` so the
compiler catches the next drift instead of a reviewer.

**Note on standards coverage.** The ECC conformance pass raised this and its own
adversarial verifier **correctly refuted it** — ECC's "HIGH — Type Safety" block
has exactly four bullets and none of them requires a literal type for a contract
field. The verifier's own words: it "would be a genuine improvement — but it is
a design suggestion, not an instance of any ECC rule." The finding is kept here
on its own evidence. See [`development-guidelines.md`](./development-guidelines.md#where-ecc-does-not-reach)
for what this implies about relying on ECC alone.

### TD-21 — Direct Run reaches methods it never advertises

**Evidence.** The advertised list is built in `nest-graph-inspector.setup.ts:393-436`,
which walks one prototype level, excludes `constructor`, and reads
`descriptor.value`. The invocation path,
`direct-run-output.adapter.ts:37-52`, does a plain `instance[methodName]` with
no allowlist.

Two consequences, both requiring a valid token:

- `"method": "constructor"` re-runs the constructor body against the live singleton with attacker-supplied arguments, corrupting shared state for every other consumer in the process. Inherited base-class methods and `Object.prototype` builtins are reachable the same way.
- Reading `instance[methodName]` **invokes a getter** before the `typeof method !== 'function'` check rejects it, so a getter's side effect runs even on a request that ends in 400. The metadata builder deliberately avoids this by reading `descriptor.value`; the invoker does not.

Neither is covered by `demo/test/graph-inspector-security.e2e-spec.ts`.

### TD-22 — Discovery silently drops dependencies and providers it cannot name

**Evidence.** In `lib/src/adapters/discovery.ts`, three paths drop data with no
signal: `extractDependencies` (`:510-559`) filters any resolved name equal to
`"Object"`; `resolveDependencyName`/`tokenName` (`:571-608`, `:729-735`) return
`null` for tokens that are not a non-empty string, symbol, or function; and
`extractModuleMember` (`:454-474`) returns `null` — removing the whole provider
or controller — when neither a class name nor a token name is available.

**Impact.** This is the failure mode with the worst blast radius for this
product specifically: the graph is not empty or broken, it is *plausible and
wrong*. A dropped dependency vanishes from `dependencies`, from cycle detection,
and from the Markdown report at once, and a reader has no reason to suspect it.
Nothing logs, and nothing marks the emitted `GraphOutput`.

**Fix direction.** Attach an `unresolved` marker to the emitted graph, or at
minimum warn naming the module and class. Silence is the defect here, not the
tolerance — the library should keep going, but not quietly.

### TD-23 — The Markdown output ignores the configured `nestCoreModuleName`

**Evidence.** `nestCoreModuleName` is a public option
(`nest-graph-inspector.type.ts:173`). `DiscoveryAdapter` resolves it properly
(`discovery.ts:55-57`) and uses it to name the virtual module (`:295`) and
prefix tokens (`:357`, `:581`, `:706`). `FileOutputAdapter` declares its own
hardcoded copy instead — `file-output.adapter.ts:26`,
`private readonly nestCoreModuleName = 'NestJSCoreModule';` — and compares
against it at `:132` and `:310`.

**Impact.** A host configuring `nestCoreModuleName: 'FrameworkCore'` gets a
graph whose virtual module carries that name and a Markdown report whose two
guards never match: import arrows are drawn into the core module, and every
real module's core-provider import is reported as an unused-import warning.

### TD-24 — The router returns raw internal error messages and logs nothing

**Evidence.** `http-serve.adapter.ts:230` answers
`this.sendText(res, 500, err instanceof Error ? err.message : 'Error')`.
A grep for `Logger` across that file returns nothing: the 508-line router that
owns every 404 and 500 in the library has no logging at all.

**Impact.** Both halves are inverted — the internal detail goes to the caller
and nothing goes to the operator. The 500 answers `text/plain`, as does the 404 at
`http-serve.adapter.ts:198`, while every response dispatched through
`sendResult` — including the token guard's 401 and the limiter's 429 — answers
the JSON `{ ok: false, error }` envelope. No client can parse inspector errors
generically.

### TD-25 — ts-morph parsing blocks the host's event loop inside a request handler

**Evidence.** `source-metadata.service.ts:120-127` constructs
`new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false })` — CPU-bound
TypeScript parsing of the host's whole source set — on the `GET /output.json`
path under the default viewer configuration.

**Nuance.** `architecture.md`'s deliberate-risk table documents the *deferral*
("real startup cost … deferred to the first request"). It does not say the
deferred work runs synchronously on the host's shared event loop. The deferral
is right and stays; the synchronicity is an undocumented consequence of it, and
the library charges it to a host whose users never opened the viewer.

**Fix direction.** Move the scan off the request path — a `node:worker_threads`
adapter behind the existing service (a Node builtin, so the single-runtime-dependency
rule holds), or, as a smaller step, an opt-in warm-up that runs it on
`setImmediate` after `onModuleInit` resolves. Either way, amend the
deliberate-risk row to state that the deferred scan blocks the loop today.

### TD-02 — Most of `NestGraphInspectorSetup` is framework-free logic trapped in a DI class

**Evidence.** 1,166 lines, of which roughly 740 (~63%) have no structural need
for the nine injected NestJS dependencies:

| Block | Lines | Depends on injected services? |
|---|---|---|
| Output orchestration | ~97-244 | yes — this is the real use case |
| Direct Run parameter extraction | ~397-541 | yes, via `sourceMetadata` |
| TypeScript type-to-source renderer | ~543-850 (~300) | **no** — pure, recursive, argument-driven |
| Graph cycle detection | ~852-1143 (~290) | **no** — operates on a `Map<string, Set<string>>` |

**Measured cost, not a style opinion.** To unit-test the pure type renderer,
`nest-graph-inspector.setup.spec.ts` must build a full `Test.createTestingModule`
wiring five collaborators (`:105-120`) and define a `SetupWithPrivateMethods`
cast (`:18-36`) to reach private methods. A function taking a ts-morph `Type` and
returning a string should not need a mocked Nest container.

**Fix direction.** Keep `@Injectable()` and `OnModuleInit` — the container is
this library's subject matter and the lifecycle hook is the correct inbound
adapter. Move the cycle detector and the type renderer into framework-free
modules importing only `lib/src/types/**`, leaving the orchestrator around
400-450 lines.

### TD-07 — An intersection cast smuggles internal config through a public options type

**Evidence.** `viewer-output.adapter.ts:14-19` declares
`ViewerOutputInternalConfig = ViewerOutputConfig & { directRun?: { …; instanceLookup: … } }`
and `:40` casts the incoming public config to it unchecked. The public
`NestGraphInspectorViewerDirectRunOptions` declares only `{ path?: string }`.

**Impact.** No live bug — the only caller populates it correctly. But nothing in
the type system would catch a refactor that sets `directRun.path` and forgets
`instanceLookup`; the failure would appear at request time as
`instanceLookup is not a function`.

### TD-06 — Adding an output type requires four coordinated edits

Unchanged from the previous edition, and documented as an extension-point cost
in `architecture.md`. Implement `OutputAdapter<Config>`, add the union variant,
register the provider, and add it to the `outputAdapters` record.

### TD-10 — Provider and module cycles use incompatible path representations

Unchanged. Provider cycles carry `{ module, provider }` items; module and
controller cycles carry plain name strings. Acknowledged in `architecture.md`.

---

## Low

### TD-09 — Path normalization is split across two adapters that must agree

**Revised by the WebLLM change (`86c8e36`).** The previous edition of this
finding also covered duplicated CORS preflight detection. That half is resolved:
the request-forwarding adapter that carried the second implementation was
deleted along with the Ollama proxy, so `HttpServeAdapter` is now the only
component that sets CORS headers or answers a preflight.

**Evidence.** Two `normalizePath` implementations remain, with different
policies: `http-output.adapter.ts:55` leaves a trailing slash, while
`http-serve.adapter.ts:501` normalizes only a leading slash (except `'*'`).

**Impact.** These are not interchangeable copies — which is why the "three
duplicated implementations" framing was refuted — but they are coupled:
`HttpOutputAdapter` computes the path a route is *advertised* under and
`HttpServeAdapter` computes the key that path is *matched* by. If the two
policies drift, a route is registered under one spelling and advertised under
another, and the viewer receives a link it cannot reach.

**Fix direction.** One shared definition of what a normalized inspector path is,
used by both, rather than two private methods that happen to agree today.

---

### TD-11 — Two claims on the outputs page contradict the code

`site/content/2.configuration/2.outputs.md:73` calls the JSON output "the raw
module map"; `JsonOutputAdapter` serializes the enriched `GraphOutput`. Line 79
calls it "a stable data artifact" while the same page warns that format-level
breaking changes may land between releases. Direct Run still has no dedicated
documentation page.

### TD-12 — `demo/docs/` and `site/content/` still overlap

Downgraded from Medium: `demo/docs/` now holds three files, none of them
Markdown, so the surfaces no longer compete for the same content.

### TD-14 — `site/README.md` is still the Nuxt Docs Template README

Unchanged. It opens "# Nuxt Docs Template" and instructs the reader to scaffold
a new project.

### TD-26 — Four methods in `lib/src` are dead

No call site exists in `lib/`, `demo/`, `site/`, or any spec for
`RuntimeTraceRecorder.classifyProviderType` (`:378`),
`RuntimeTraceRecorder.summarizeValue` (`:405`, superseded by `previewValue`),
`DiscoveryAdapter.extractImports` (`discovery.ts:375`), or
`NestGraphInspectorSetup.buildModuleMapFromAutoDetect` (`setup.ts:242`).
`tsconfig.base.json` sets `strict` but not `noUnusedLocals`, which is what would
flag an unread private method.

### TD-27 — No formatter, and formatting has diverged

Six files use double-quoted strings against thirty-four using single quotes, and
`recordSpan`'s try/catch body at `runtime-trace.recorder.ts:98` is un-indented.
The package runs a linter but no formatter.

---

## Not classified as debt

Inspected and deliberately excluded. The first four are unchanged from the
previous edition; the rest were added by this pass.

- `demo/src/` intentionally contains circular-dependency examples; a graph tool needs something worth graphing.
- `demo/tmp/graph/` is gitignored runtime output that nothing downstream reads.
- `site/public/nodepod-demo/` is build output. Bundling it from the `nest build` output rather than `demo/src/**` is required, not an oversight — Nest resolves constructor dependencies from decorator metadata, which only `tsc` emits.
- `site/app/utils/nodepod-demo-endpoint.ts` addressing virtual servers under an unserved route segment is forced by the service-worker scope rule, not chosen.
- **Wildcard CORS and the `0.0.0.0` bind.** Both still true, both documented deliberate: a viewer hosted on a fixed origin cannot be same-origin with an arbitrary developer machine. The token, not the origin check, is the control. (TD-15 is filed separately precisely because it bypasses that control.)
- **Direct Run returning the raw provider return value.** The endpoint exists to return whatever the invoked method returned; a response DTO would delete the feature rather than shape it. The `DirectRunResult` envelope is the stable part.
- **Output failures logged rather than thrown.** An inspector that cannot bind its port must not stop a host application from starting.
- **The `/direct-run/histories` versus `/direct-run/history/...` split.** A genuine naming wart, but these paths are a parsed cross-package contract asserted literally in `site/app/utils/inspector-endpoint-url.test.ts`; renaming breaks the viewer for a cosmetic gain.
- **No `/v1` URL segment.** The API is versioned in the payload, against the viewer's `MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION`, which is the stronger mechanism for a client talking to an independently-versioned developer machine.
- **The rate limiter keying on socket address.** An attacker with many source addresses evades it, but the real boundary is a 256-bit HMAC signature that is not brute-forceable; the limiter bounds noise, as its own doc comment says.
