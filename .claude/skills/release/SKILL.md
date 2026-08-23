---
name: release
description: Cut, verify, or debug a nest-graph-inspector release — publishing the npm package and deploying the docs site. Use when asked to release, publish, cut a version, ship a prerelease/test build, redeploy the site, or diagnose why a release workflow failed.
---

# Releasing nest-graph-inspector

The version in `lib/package.json` on `main` is the placeholder
`0.0.1-development-only`. It is **never** bumped by hand — the published version
is derived from the git tag by CI. A PR that edits that version is wrong.

## Cutting a release

1. Confirm `main` is green: the `CI` workflow must be passing on the commit you
   intend to release.
2. Move `CHANGELOG.md` entries from `## [Unreleased]` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section, and merge that to `main`.
3. Publish a **GitHub release** with tag `vX.Y.Z` targeting that commit.
   Publishing the release is what triggers everything else — pushing a tag alone
   does nothing.

`.github/workflows/deploy-site.yml` then runs three jobs in sequence:

| Job       | What it does |
| --------- | ------------ |
| `publish` | Checks out the tag, installs, runs lint + typecheck + tests, sets the package version to the tag with the leading `v` stripped, builds `lib`, and runs `npm publish --provenance`. |
| `build`   | Builds `lib`, generates the Nuxt site with the GitHub Pages preset, uploads the Pages artifact. |
| `deploy`  | Deploys the Pages artifact. |

`build` has `needs: publish`, so a failed npm publish also blocks the site
deploy. That coupling is intentional — the docs describe the version on npm.

Requires the `NPM_TOKEN` secret, and `id-token: write` on the publish job for
provenance.

## Shipping a test build

Run the **Publish Test Package** workflow
(`.github/workflows/publish-test-package.yml`) manually with a unique prerelease
version, e.g. `0.0.1-test.4`. It publishes from `main` under the `test` dist-tag,
so it never moves `latest`. Consumers install it with
`npm install nest-graph-inspector@test`.

## Redeploying the site only

Run the **Redeploy Site from Tag or Branch** workflow
(`.github/workflows/redeploy-site-on-tag.yml`) with a tag or branch. This touches
only GitHub Pages — it does not publish to npm.

## When a release fails

- **`npm publish` says the version already exists** — a tag cannot be reused.
  Cut a new patch tag; do not force-publish.
- **Provenance fails** — check that the `publish` job still declares
  `id-token: write`.
- **Site deployed but npm did not publish** — impossible by design; `build`
  needs `publish`. If the site looks stale instead, re-run the redeploy
  workflow.
- **Lint/typecheck/test failed inside the release** — the tag was cut from a
  commit that was not green. Fix on `main`, then cut a new tag.

## What to check before saying a release is done

```bash
npm view nest-graph-inspector version        # matches the tag, without the "v"
npm view nest-graph-inspector dist-tags      # latest moved; test untouched
```

Then confirm https://albasyir.github.io/nest-graph-inspector/ loads and the
viewer at `/view/` still renders the example graph.
