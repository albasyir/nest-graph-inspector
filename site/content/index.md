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
Deliver Reliable NestJS Applications

#description
Nest Graph Inspector turns your live NestJS runtime into **architecture intelligence**: visible dependencies, measurable change impact, and clear blast radius before production.

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
  :runtime-graph-complete-preview
::

::u-page-section
---
class: dark:bg-neutral-950
orientation: horizontal
reverse: true
ui:
  container: py-10 sm:py-12 lg:py-16 gap-8 sm:gap-10
---
#title
::span{class="inline-flex items-center gap-3"}
  :u-icon{name="i-lucide-route" class="size-9 shrink-0 text-primary"}
  See Impact Paths Easily
::

#description
No manual tracing. Hover a module, provider, or controller and the graph shows the impact path for you.

#features
  :::u-page-feature
  ---
  icon: i-lucide-eye
  ---
  #title
  Hover Any Node

  #description
  Start from the module, provider, or controller you plan to change.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-route
  ---
  #title
  Follow the Highlight

  #description
  Related paths stay visible while unrelated edges fade back.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-list-checks
  ---
  #title
  Decide With Context

  #description
  See affected app areas before making changes.
  :::

#default
  :runtime-graph-brigh-line-preview
::

::u-page-section
---
class: dark:bg-neutral-950
orientation: horizontal
ui:
  container: py-10 sm:py-12 lg:py-16 gap-8 sm:gap-10
---
#title
::span{class="inline-flex items-center gap-3"}
  :u-icon{name="i-lucide-recycle" class="size-9 shrink-0 text-primary"}
  Find Circular Dependencies Fast
::

#description
Warnings mark circular dependencies. Click one to see the loop.

#features
  :::u-page-feature
  ---
  icon: i-lucide-recycle
  ---
  #title
  Module Loops

  #description
  See when modules depend on each other in a circle.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-orbit
  ---
  #title
  Provider Loops

  #description
  See when providers loop inside one module.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-circle-alert
  ---
  #title
  Clear Fix Path

  #description
  Open the warning and follow the path to fix.
  :::

#default
  :runtime-graph-circular-depedencies-preview
::

::u-page-section{class="dark:bg-neutral-950"}
#title
Feature List

#description
Built for clear graphs, fast tracing, and confident runtime decisions.

#features
  :::u-page-feature
  ---
  icon: i-lucide-network
  ---
  #title
  Dependency Graph

  #description
  Visualize modules, providers, controllers, imports, and runtime dependency edges.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-refresh-cw
  ---
  #title
  Circular Detection

  #description
  Find circular relationships early and resolve risky loops before release.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-focus
  ---
  #title
  Relation Focus :badge[Coming Soon]{.ml-2}

  #description
  Coming soon: focus any provider/module pair and inspect their dependency path.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-bot
  ---
  #title
  Context-Aware AI Assistant

  #description
  Ask graph and trace questions in plain language, free in the viewer.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-git-branch-plus
  ---
  #title
  Process Sequence :badge[Coming Soon]{.ml-2}

  #description
  Coming soon: generate sequence diagrams from entry point to completion.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-play
  ---
  #title
  Direct Run :badge[Coming Soon]{.ml-2}

  #description
  Coming soon: execute runtime-resolved services directly from graph context.
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
AI Chat in Viewer

#description
Go from graph to decision faster with runtime-grounded answers.

#features
  :::u-page-feature
  ---
  icon: i-lucide-message-circle
  ---
  #title
  Ask Naturally

  #description
  Ask "trace `AuthService` dependencies" or "show `OrdersModule` to `PaymentService`" without query syntax.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-file-check-2
  ---
  #title
  Grounded, Not Generic

  #description
  Answers use loaded graph context and call out missing data.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-messages-square
  ---
  #title
  Unlimited Follow-Ups

  #description
  Keep asking until the dependency path is clear.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-route
  ---
  #title
  Trace Paths Faster

  #description
  Walk provider and module relationships during debugging, reviews, and PR checks.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-cpu
  ---
  #title
  Your Model, Your Environment

  #description
  Use Ollama to keep architecture analysis in your own environment.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-zap
  ---
  #title
  Direct Run Ready :badge[Coming Soon]{.ml-2}

  #description
  Today, trace with context-aware chat; soon, run resolved execution flows.
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
