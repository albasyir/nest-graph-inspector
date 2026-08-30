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

- The documentation site's demo is now the demo application itself, running in
  your browser on the [nodepod](https://www.npmjs.com/package/@scelar/nodepod)
  runtime, rather than a graph file committed into the site. Direct Run invokes
  real provider methods, runtime traces and Direct Run history accumulate as you
  use it, and the graph — JSDoc and Direct Run parameter types included — comes
  from the application that is answering. It starts when you ask for it — a
  preview waits behind "Run the demo application", and `/view` behind "Open
  Demo" — and the viewer header names it "Demo" rather than showing an address
  that only means something inside your tab.
- `pnpm --filter nest-graph-inspector-demo run build:nodepod` packages the demo
  for that runtime, and `pnpm --filter nest-graph-inspector-site run
  test:demo-payload` boots the packaged application headless and checks that it
  answers. Both run in CI ahead of every site build.
- Repository CI: lint, typecheck, tests on Node 20/22/24, and a full site build
  now run on every pull request and push to `main`.
- `lib` is linted (ESLint + typescript-eslint) and has a `typecheck` script.
- npm provenance attestation on published releases.
- Shared `tsconfig.base.json`, root `.editorconfig`, and `.nvmrc`.
- Community health files: contributing guide, code of conduct, issue and pull
  request templates, and this changelog.

### Changed

- The demo writes its graph files to `demo/tmp/graph/` instead of into the
  site's public directory. It is otherwise an ordinary NestJS project that knows
  nothing about running in a browser: what that runtime needs differently is
  prepended by the payload build.
- `lib` and `demo` compile under TypeScript `strict`.
- Spec files are type-checked. `ts-jest` no longer runs with `diagnostics: false`,
  so type errors in tests fail the build instead of being skipped.
- Published `.d.ts` files keep their JSDoc, and declaration/source maps ship with
  the package, so editors show option documentation and stack traces resolve.
- Releases run lint, typecheck, and tests before `npm publish`.
- pnpm no longer hoists dependencies (`shamefully-hoist=false`), so a package can
  only import what it declares.

### Fixed

- The access token is built by encoding the HMAC digest buffer, rather than by
  asking `digest()` for `base64url`. A runtime that ignores that argument hands
  back raw bytes, and a token made of raw bytes does not survive the URL it
  travels in. On Node the token is unchanged.
- The npm lookup behind `latestVersion` in `information.json` is bounded to two
  seconds. It is awaited while the inspector installs its outputs — while your
  application is starting — so a network that neither answers nor refuses used
  to hold up `app.listen()` with it.
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
- The graph viewer's entry page no longer discards the graph a tab is on. Its
  endpoint poller probes without committing, so visiting `/view` — or the
  viewer's own "Try Another URL" — and going back keeps the graph and its token.
- An unusable path below a viewer page (`/view/navigator/anything`) returns to
  the viewer entry page instead of waiting on a spinner that never resolves.
- Every `/view/**` page now requires the access token for the graph it would
  show. Without one the viewer returns to `/view`, since the token is no longer
  in the URL and the link printed by your application is the only thing that
  hands one over. A graph on the site's own origin is exempt from that check —
  which is where the bundled demo runs, though it prints and presents a token of
  its own like any other application. An inspector configured with
  `accessToken.enabled: false`, or with `accessToken.logToken: false`, prints a
  link carrying no token and cannot be opened in the hosted viewer.
- The graph viewer's reload button now stays busy for the whole reload rather
  than only its middle request, and the viewer shows its loading state for the
  whole of a reload started from the header.
- Retrying a graph that has stopped answering no longer reports the last reason.
  A 401 is not remembered across attempts, so an application that went down is
  reported as unreachable rather than as needing an access token — and an
  endpoint that never answered says so, instead of "no data received".
- The proxy adapter no longer forwards the inspector's own access token to the
  origin it proxies to. A caller authenticates to the inspector, and the target
  — an Ollama server, say — has no business holding a live credential for the
  inspected application, so the `x-graph-inspector-token` header, an
  `Authorization: Bearer` header carrying an inspector token, and the
  `__inspector_token` query parameter are dropped on the way out. Anything else
  the caller sent, including an `Authorization` header for the target's own
  authentication, still goes through.
- The proxy adapter no longer forwards requests to an origin outside its
  configured target when a client sends an absolute-form request target.
- `demo`'s test script no longer exits non-zero when it finds no tests.

### Removed

- The committed graph fixture (`site/public/mock-graph/`) and
  `demo/scripts/mock-sync.ts`, which existed to keep it in step with the demo.
  The site runs the demo application instead.
