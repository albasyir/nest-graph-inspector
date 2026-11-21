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
pnpm run build       # build the library, and the demo as the site's browser payload
pnpm run dev         # build both, then run the demo and the site together
```

Per-package work:

```bash
pnpm --filter nest-graph-inspector run test
pnpm --filter nest-graph-inspector run test:cov
pnpm --filter nest-graph-inspector run test:e2e:cli          # the export CLI as installed, against fixture projects (part of test too)
pnpm --filter nest-graph-inspector-demo run dev
pnpm --filter nest-graph-inspector-demo run build:nodepod   # rebuild the demo the site runs in the browser, and its graph.json
pnpm --filter nest-graph-inspector-demo run build:graph     # export the demo's graph without running it (nest-graph-inspector export)
pnpm --filter nest-graph-inspector-demo run test:e2e        # demo e2e suites: security, REST, export vs. live /output.json, and the built demo run as a process
pnpm --filter nest-graph-inspector-demo run test:e2e:browser  # the viewer in Chromium against the demo run as a process (see below)
pnpm --filter nest-graph-inspector-site run test:demo-payload  # boot that payload and check it answers
pnpm --filter nest-graph-inspector-site run dev
```

The browser suite opens the viewer from the site's static build, built the
way CI builds it, so build that first — and install Chromium once:

```bash
pnpm --filter nest-graph-inspector run build
pnpm --filter nest-graph-inspector-demo run build:nodepod
NITRO_PRESET=github_pages NUXT_APP_BASE_URL=/nest-graph-inspector/ pnpm --filter nest-graph-inspector-site exec nuxt generate
pnpm --filter nest-graph-inspector-demo exec playwright install chromium
pnpm --filter nest-graph-inspector-demo run test:e2e:browser
```

Both e2e commands start the demo on its fixed ports (8889, 53371 and 53372),
and refuse to while another process listens on one — another checkout running
its demo, say. Neither runs under `verify`; CI runs both on every pull request.

The site's demo is the demo application itself, running in the visitor's
browser. It is served from `site/public/nodepod-demo/`, which is generated and
gitignored, so running the site alone in a fresh checkout leaves the demo with
nothing to load until `build:nodepod` has run — `pnpm run dev` from the root
does it for you.

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
4. CI runs lint, typecheck, tests on Node 20/22/24, the export CLI's e2e on
   Node 20/22/24, a full site build, the demo's e2e suites, and the viewer's
   browser suite.

## Releasing

Releases are cut by maintainers — see
[`docs/maintainers-guide.md`](./docs/maintainers-guide.md). The version in
`lib/package.json` is a placeholder on `main`; the real version comes from the
release tag.

## Reporting security issues

Do not open a public issue. Follow [`SECURITY.md`](./SECURITY.md).
