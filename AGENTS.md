# Repository instructions

Nest Graph Inspector is a pnpm workspace with three ownership areas:

- `lib/**`: the published npm package `nest-graph-inspector` — this is the product
- `demo/**`: NestJS demo and development host
- `site/**`: Nuxt 4 documentation site and graph viewer

## Before you start

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the commands, and
[`docs/maintainers-guide.md`](./docs/maintainers-guide.md) to work out which
directory a change belongs in.

Verify any change with:

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

Under any other runtime, treat these as ownership boundaries rather than
delegation targets and do the work directly.

## Contracts that span packages

Two things are shared surfaces; changing one side alone breaks the other.

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
CORS policy, and the absence of an auth guard as deliberate decisions to be
questioned rather than defaults to preserve.
