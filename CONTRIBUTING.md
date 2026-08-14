# Contributing to Nest Graph Inspector

Thanks for taking the time to contribute.

## Repository layout

This is a pnpm workspace with three packages:

| Path    | Package                        | What it is                                      |
| ------- | ------------------------------ | ----------------------------------------------- |
| `lib/`  | `nest-graph-inspector`         | The published npm package. This is the product. |
| `demo/` | `nest-graph-inspector-demo`    | Private NestJS app used as a development host.   |
| `site/` | `nest-graph-inspector-site`    | Nuxt documentation site on GitHub Pages.        |

Repository-level design docs live in [`docs/`](./docs).

## Prerequisites

- Node.js — the version in [`.nvmrc`](./.nvmrc) (Node 20, 22 and 24 are tested in CI)
- pnpm — the version pinned by `packageManager` in the root `package.json`

```bash
corepack enable
pnpm install
```

## Everyday commands

Run these from the repository root; they fan out across the workspace.

```bash
pnpm run verify      # lint + typecheck + test + build — run this before opening a PR
pnpm run test        # tests in every package that defines them
pnpm run lint        # lint every package
pnpm run typecheck   # typecheck every package
pnpm run build       # build the library and the demo
pnpm run dev         # build the library, then run the demo and the site together
```

Per-package work:

```bash
pnpm --filter nest-graph-inspector run test
pnpm --filter nest-graph-inspector run test:cov
pnpm --filter nest-graph-inspector-demo run dev
pnpm --filter nest-graph-inspector-site run dev
```

## Expectations for a change

- **Tests.** `lib/` is covered by Jest specs next to the code they test
  (`*.spec.ts`). Any behavior change to the library needs a spec.
- **Types.** `lib/` and `demo/` compile under `strict`. Spec files are
  type-checked too — `pnpm run typecheck` is not optional.
- **Lint.** `pnpm run lint` must be clean. Warnings are tolerated where the
  library reflects over untyped Nest internals; errors are not.
- **Public API.** Anything exported from `lib/src/index.ts` is public. Adding to
  it is a feature; changing or removing from it is a breaking change. Update
  [`docs/public-api.md`](./docs/public-api.md) in the same PR.
- **Graph output shape.** The JSON the library emits is consumed by the viewer
  in `site/`. If you change it, update
  [`docs/graph-contract.md`](./docs/graph-contract.md) and the viewer together.

## Commit messages

The history follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(lib): add cycle detection for request-scoped providers
fix(site): keep viewer zoom stable on graph reload
docs: document the direct-run endpoint
chore(deps): bump ts-morph to 28.1
```

Scopes in use: `lib`, `demo`, `site`, `deps`, or omit it for repo-wide changes.

## Pull requests

1. Branch from `main`.
2. Run `pnpm run verify`.
3. Open the PR and fill in the template.
4. CI runs lint, typecheck, tests on Node 20/22/24, and a full site build.

## Releasing

Releases are cut by maintainers — see
[`docs/maintainers-guide.md`](./docs/maintainers-guide.md). The version in
`lib/package.json` is a placeholder on `main`; the real version comes from the
release tag.

## Reporting security issues

Do not open a public issue. Follow [`SECURITY.md`](./SECURITY.md).
