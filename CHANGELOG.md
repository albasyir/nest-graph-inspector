# Changelog

All notable changes to the `nest-graph-inspector` package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Released versions are published from GitHub releases; the version in
`lib/package.json` on `main` is a placeholder and is not a released version.
See the [releases page](https://github.com/albasyir/nest-graph-inspector/releases)
for the published history.

## [Unreleased]

## [0.9.0] - 2026-09-06

### Added

- The graph viewer's AI chat now runs the model inside your browser. Pick a
  model, wait once for its weights to download into the browser cache, and every
  answer after that is generated on your own GPU through WebGPU — no daemon, no
  API key, nothing to install, and neither your graph nor your questions leave
  the machine. The chat needs a WebGPU-capable browser and says so up front
  instead of failing when you ask something; the rest of the viewer works
  everywhere it did before.
- The AI chat now answers on any graph the viewer can show, the in-browser demo
  and a graph read from disk included, so "Open Demo" is enough to try it
  without pointing the viewer at an application of your own. Answering used to
  mean reaching a proxy the inspected application served — which a demo running
  inside your tab has no way to reach, and a directory of static files does not
  serve at all. Now that the model runs in the browser, the graph's Markdown is
  all the chat needs. A graph emitted by a pre-v3 library is still the one case
  the chat stays off for.
- The viewer's AI chat can now answer by **looking things up in the graph**
  instead of reading an excerpt of it. In agent mode the model is given six
  read-only tools — list the modules, describe one, find a provider, trace a
  dependency chain, list the cycles, search the graph — and it calls them until
  it can answer. Every tool call and its result is shown in the transcript, so a
  slow answer is legible rather than a silence. The chat picks the mode that
  suits the graph on screen (looking things up wins once the graph stops fitting
  the 4096-token window; a single streamed answer is quicker on a small one) and
  a button in the prompt footer switches it either way.
- **Agent mode runs on every model in the list, including the recommended Qwen3
  1.7B at about 2 GB of VRAM.** It is not restricted to the tool-tuned Hermes
  builds. web-llm's own function-calling path does refuse anything outside a
  five-model allowlist, so the chat does not use it: it writes the tool schemas
  into the system prompt itself and constrains the decode with a grammar, and
  neither of those is looked up against a model list. What the Hermes builds
  (around 4 GB of VRAM, roughly twice the recommendation) actually buy is
  judgement — they pick the right tool more often and give up less — so they are
  offered as an optional upgrade and the panel says as much when a general model
  is selected. Nothing is disabled on that basis.
- The chat now fits the graph into the model's context window rather than
  sending all of it. The Mermaid diagram is dropped, whole module sections are
  kept until the budget runs out, and the model is told how many modules were
  left out, so a large graph produces an answer that admits what it could not
  see instead of one quietly built from a truncated prompt.
- The viewer shows the JSDoc a class was written with. Rest the pointer on a
  module title, a provider, or a controller and the comment above it appears
  beside the node; a node with nothing documented shows nothing, and the ones
  that do carry a dotted underline so you can tell them apart before hovering.
  The card can be read and scrolled without the pointer leaving it, and "Show
  JSDoc on hover" in the graph settings panel turns the whole thing off. The
  graph already carried these comments — this is the first surface that renders
  them, so no change to the library or the graph JSON was needed.
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

- The chat now talks to a LangChain chat model rather than to `@mlc-ai/web-llm`
  directly. This is an internal boundary with one purpose: which model answers is
  now a constructor argument, so putting a hosted provider behind the same panel
  later is a swap of one object instead of a rewrite. Nothing about running the
  model in your own browser changes — that is still the default and still the
  only provider on offer.
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

### Removed

- **Breaking.** The Ollama proxy is gone. The `viewer` output no longer accepts
  an `ollama` option, `NestGraphInspectorOllamaProxyOptions` is no longer
  exported, and the library no longer opens a proxy or forwards a request
  anywhere. Delete the `ollama` key from your viewer output — passing it is now
  a type error — and stop running Ollama for the chat, which runs in the browser
  instead. Nothing else about the viewer output changes: the graph endpoint, the
  access token, and Direct Run are untouched.

  The feature never needed a server component, and the one it had was a relay:
  an endpoint installed in your application whose job was to take a
  caller-supplied body and send it to another origin. Removing it is the point,
  not a side effect.
- The committed graph fixture (`site/public/mock-graph/`) and
  `demo/scripts/mock-sync.ts`, which existed to keep it in step with the demo.
  The site runs the demo application instead.

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
- `demo`'s test script no longer exits non-zero when it finds no tests.

