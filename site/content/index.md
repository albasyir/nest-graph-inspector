---
seo:
  title: Nest Graph Inspector - Runtime Architecture Inspection for NestJS
  description: See how your NestJS app is actually wired at runtime with an interactive dependency graph.
---

::u-page-hero{class="dark:bg-gradient-to-b from-neutral-900 to-neutral-950"}
---
orientation: horizontal
---
#top
:hero-background

#title
See what your NestJS app actually wires at runtime.

#description
Nest Graph Inspector reads the live NestJS container and shows an interactive graph of modules, providers, controllers, imports, and dependencies.

#links
  :::u-button
  ---
  to: /view
  size: xl
  icon: i-lucide-network
  ---
  View Graph
  :::

  :::u-button
  ---
  to: /getting-started
  color: neutral
  variant: outline
  size: xl
  trailing-icon: i-lucide-arrow-right
  ---
  Get Started
  :::

  :::u-button
  ---
  icon: i-simple-icons-github
  color: neutral
  variant: outline
  size: xl
  to: https://github.com/albasyir/nest-graph-inspector
  target: _blank
  ---
  GitHub
  :::

#default
  :runtime-graph-preview
::

::u-page-section{class="dark:bg-neutral-950"}
#title
Why It Matters

#description
NestJS gets complex quickly. Before changing code, teams need fast answers to impact and risk questions.

#features
  :::u-page-feature
  ---
  icon: i-lucide-git-fork
  ---
  #title
  Dependency Impact

  #description
  What depends on this provider?
  :::

  :::u-page-feature
  ---
  icon: i-lucide-layers
  ---
  #title
  Module Blast Radius

  #description
  Which modules are affected by this change?
  :::

  :::u-page-feature
  ---
  icon: i-lucide-refresh-cw
  ---
  #title
  Circular Dependencies

  #description
  Is there any circular dependency?
  :::

  :::u-page-feature
  ---
  icon: i-lucide-flask-conical
  ---
  #title
  Smoke Test Scope

  #description
  What should we smoke test before merge?
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
Runtime, Not Guesswork

#description
Static graph tools show what source code suggests. Nest Graph Inspector shows what NestJS actually wires at runtime.

#features
  :::u-page-feature
  ---
  icon: i-lucide-check-check
  ---
  #title
  Runtime Container Data

  #description
  Graph is built from loaded runtime modules and resolved dependencies.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-target
  ---
  #title
  Better Blast Radius Analysis

  #description
  Know impact scope before refactor, review, or release.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-list-checks
  ---
  #title
  Smarter Regression Planning

  #description
  Prioritize smoke tests using real dependency relationships.
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
Simple Team Workflow

#description
From change request to safer merge:

#features
  :::u-page-feature
  ---
  icon: i-lucide-scan-search
  ---
  #title
  1. Generate Graph

  #description
  Generate runtime graph data from your NestJS app.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-network
  ---
  #title
  2. Inspect Nodes

  #description
  Inspect affected modules, providers, and controllers.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-target
  ---
  #title
  3. Identify Blast Radius

  #description
  See upstream and downstream dependency impact.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-shield-check
  ---
  #title
  4. Prioritize Tests

  #description
  Focus smoke and regression tests on risky areas.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-file-json
  ---
  #title
  5. Share Output

  #description
  Attach Markdown/JSON to PRs, docs, and internal tooling.
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
AI Chat in Viewer

#description
Move from graph exploration to decisions in seconds. AI Chat is grounded in the loaded runtime graph, so answers stay relevant to your architecture.

#features
  ::u-page-feature
  ---
  icon: i-lucide-bot
  title: Ask in Plain Language
  ---
  No query syntax. Ask architecture questions the way engineers naturally ask them.
  ::
  :::u-page-feature
  ---
  icon: i-lucide-gauge
  ---
  #title
  Faster Risk Checks

  #description
  Understand change impact before merge and reduce review uncertainty.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-orbit
  ---
  #title
  Coupling Visibility

  #description
  Surface highly-coupled modules and dependency hotspots quickly.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-rotate-cw
  ---
  #title
  Circular Dependency Detection

  #description
  Catch circular relationships early before they become production issues.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-shield-check
  ---
  #title
  Smarter Test Priorities

  #description
  Turn dependency context into focused smoke and regression plans.
  :::
::

::u-page-section
---
class: dark:bg-gradient-to-b from-neutral-950 to-neutral-900
ui:
  container: '!max-w-none px-4 sm:px-6 lg:px-8'
---
  :::u-page-c-t-a
  ---
  links:
    - label: View Your Graph
      to: '/view'
      icon: i-lucide-network
    - label: Get Started
      to: '/getting-started'
      trailingIcon: i-lucide-arrow-right
      variant: subtle
    - label: GitHub
      to: 'https://github.com/albasyir/nest-graph-inspector'
      target: _blank
      variant: subtle
      icon: i-simple-icons-github
  title: Inspect runtime wiring before you ship
  description: Understand dependency impact quickly and ship safer changes.
  class: dark:bg-neutral-950 w-full
  ui:
    container: '!max-w-none'
  ---

  :stars-bg
  :::
::
