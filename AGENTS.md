# Repository instructions

> **Read [`docs/architecture.md`](./docs/architecture.md) before you change
> anything in this repository. Every task starts there — no exceptions.**

Nest Graph Inspector is a pnpm workspace with three ownership areas:

- `lib/**`: the published npm package `nest-graph-inspector` — this is the product
- `demo/**`: NestJS demo and development host
- `site/**`: Nuxt 4 documentation site and graph viewer

## Before you start

**Required reading, in this order:**

1. [`docs/architecture.md`](./docs/architecture.md) — **mandatory, always.**
   How the three packages fit together, which surfaces are contracts, which
   defaults are deliberate, and the invariants a change must preserve. Read it
   in full before your first edit of a session, even for a change that looks
   like a one-liner. Most mistakes in this repository are made by someone who
   changed one side of a contract described in that file.
2. [`CONTRIBUTING.md`](./CONTRIBUTING.md) — the commands.
3. [`docs/maintainers-guide.md`](./docs/maintainers-guide.md) — which directory
   a change belongs in.

Then, for whatever the change touches:

| If you are changing… | Also read |
|---|---|
| anything exported from `lib/src/index.ts` | [`docs/public-api.md`](./docs/public-api.md) |
| the graph JSON, or the viewer that reads it | [`docs/graph-contract.md`](./docs/graph-contract.md) |
| `http-serve`, `proxy`, `direct-run`, or the access token | the Security architecture section of [`docs/architecture.md`](./docs/architecture.md) |

### Keeping the architecture document true

`docs/architecture.md` is normative, not decorative. If your change makes any
statement in it wrong — a default, a route, a version constant, a boundary, a
sequence — update the document in the **same** pull request. Its final section,
"Where this document may drift", lists the facts most likely to go stale and the
file each one lives in; check that list before you open a PR.

If you find the document already disagreeing with the code, the code is right
and the document is a bug. Fix it, or say so explicitly in your summary.

## Verifying a change

```bash
pnpm run verify   # lint + typecheck + test + build, across the workspace
```

`lib/` and `demo/` compile under TypeScript `strict`, and spec files are
type-checked — do not weaken `tsconfig.base.json` to make a change compile.

## Delegation

`.codex/agents/` defines two Codex subagents, `frontend` and `library`. When
running under an agent runtime that supports them:

- Delegate frontend UI, UX, visualization, browser behavior, and files under
  `site/**` to the `frontend` agent.
- Delegate reusable library code, NestJS integration, public API, types, tests,
  documentation, and files under `lib/**` or `demo/**` to the `library` agent.
- For work touching both `site/**` and `lib/**`, use both agents.
- For cross-area work, define or verify the library API/data contract first,
  then integrate it in the frontend.
- The parent agent coordinates final integration and resolves contract mismatch.

Every delegated agent is bound by the same rule as the parent: read
`docs/architecture.md` before editing.

Under any other runtime, treat these as ownership boundaries rather than
delegation targets and do the work directly.

## Contracts that span packages

Two things are shared surfaces; changing one side alone breaks the other.
[`docs/architecture.md`](./docs/architecture.md) explains both in full.

- **Public API** — everything exported from `lib/src/index.ts`. Adding is a
  feature; changing or removing is breaking. Keep
  [`docs/public-api.md`](./docs/public-api.md) in step.
- **Graph output JSON** — produced by `lib/`, consumed by the viewer in `site/`.
  Keep [`docs/graph-contract.md`](./docs/graph-contract.md) and the viewer in
  step with the emitting code.

## Library structure

- `lib/src/**`: reusable implementation
  - `lib/src/adapters/**`: output channel implementations
  - `lib/src/ports/**`: port interfaces the adapters implement
  - `lib/src/types/**`: public TypeScript types and the JSON Schema
- `demo/src/**`: demo/showcase and development application
- `demo/test/**`: demo integration tests
- `demo/docs/**`: legacy demo documentation
- `demo/scripts/**`: demo development tooling

## Security-sensitive defaults

The inspector serves an HTTP endpoint inside the host application, and the
Direct Run feature invokes provider methods on request. When changing anything
under `lib/src/adapters/http-serve.adapter.ts`,
`lib/src/adapters/proxy.adapter.ts`, or
`lib/src/adapters/direct-run-output.adapter.ts`, treat the bind interface, the
CORS policy, and the access token guard as deliberate decisions to be
questioned rather than defaults to preserve — the Security architecture section
of [`docs/architecture.md`](./docs/architecture.md) states what each one buys
and what it costs. A change to any of them needs a matching case in
`demo/test/graph-inspector-security.e2e-spec.ts` — and you have to run it
yourself, because `pnpm run verify` does not:

```bash
pnpm --filter nest-graph-inspector-demo run test:e2e
```
