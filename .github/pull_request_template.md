<!--
Thanks for the contribution. Keep this short — the diff is the detail.
Contributing guide: ../CONTRIBUTING.md
-->

## What does this change?

<!-- One or two sentences. Link the issue it closes, if any. -->

## Why?

<!-- The problem this solves. -->

## Area

- [ ] `lib/` — the published npm package
- [ ] `demo/` — NestJS demo / development host
- [ ] `site/` — documentation site and viewer
- [ ] Repository tooling, CI, or docs

## Checklist

- [ ] `pnpm run verify` passes locally (lint, typecheck, test, build)
- [ ] Behavior changes in `lib/` are covered by a spec
- [ ] If `lib/src/index.ts` exports changed, `docs/public-api.md` is updated
- [ ] If the graph JSON output changed, `docs/graph-contract.md` and the viewer
      are updated together
- [ ] `CHANGELOG.md` has an entry under `Unreleased` for user-visible changes

## Breaking change?

<!-- If yes, describe what consumers have to do to upgrade. If no, delete this section. -->
