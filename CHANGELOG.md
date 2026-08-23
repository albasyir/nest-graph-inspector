# Changelog

All notable changes to the `nest-graph-inspector` package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Released versions are published from GitHub releases; the version in
`lib/package.json` on `main` is a placeholder and is not a released version.
See the [releases page](https://github.com/albasyir/nest-graph-inspector/releases)
for the published history.

## [Unreleased]

### Added

- Repository CI: lint, typecheck, tests on Node 20/22/24, and a full site build
  now run on every pull request and push to `main`.
- `lib` is linted (ESLint + typescript-eslint) and has a `typecheck` script.
- npm provenance attestation on published releases.
- Shared `tsconfig.base.json`, root `.editorconfig`, and `.nvmrc`.
- Community health files: contributing guide, code of conduct, issue and pull
  request templates, and this changelog.

### Changed

- `lib` and `demo` compile under TypeScript `strict`.
- Spec files are type-checked. `ts-jest` no longer runs with `diagnostics: false`,
  so type errors in tests fail the build instead of being skipped.
- Published `.d.ts` files keep their JSDoc, and declaration/source maps ship with
  the package, so editors show option documentation and stack traces resolve.
- Releases run lint, typecheck, and tests before `npm publish`.
- pnpm no longer hoists dependencies (`shamefully-hoist=false`), so a package can
  only import what it declares.

### Fixed

- The hosted graph viewer no longer keeps the inspector access token — or the
  graph endpoint — in its URL. The link printed by your application is spent on
  arrival, and the viewer settles on a plain `/view/navigator`, `/view/issues`,
  or `/view/execution-sequence`. The endpoint and token move into the tab's
  session, and every request authenticates with the `x-graph-inspector-token`
  header instead. This also repairs AI chat and Direct Run history in the viewer,
  whose URLs were built by appending a path onto a token-bearing query string.

  A viewer URL is therefore no longer shareable or bookmarkable: it names a view,
  not a graph. Reopening the printed link is how you get back to a graph, and a
  reload keeps working within the same tab. Links carrying the old
  `/view/<encoded>/issues` shape still land on the view they named.
- The proxy adapter no longer forwards requests to an origin outside its
  configured target when a client sends an absolute-form request target.
- `demo`'s test script no longer exits non-zero when it finds no tests.
