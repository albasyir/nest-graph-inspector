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
Deliver Reliable NestJS Application

#description
Nest Graph Inspector turns your live NestJS runtime into **transparent architecture intelligence**, so every change is **easier to measure**, every dependency is **visible**, and every **blast effect is clear** before it reaches production.

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
Shipping speed depends on confidence. Teams need runtime visibility to trace impact, find architecture issues early, and ship safer changes.

#features
  :::u-page-feature
  ---
  icon: i-lucide-git-fork
  ---
  #title
  Ship Changes Faster

  #description
  Trace impact in minutes, not meetings, before touching critical providers or modules.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-layers
  ---
  #title
  Cut Regression Risk

  #description
  Catch circular and high-coupling patterns before they become release blockers.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-refresh-cw
  ---
  #title
  Make PR Reviews Concrete

  #description
  Replace assumptions with runtime-backed module and provider-level evidence.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-flask-conical
  ---
  #title
  Onboard With Real Context

  #description
  Give new engineers a live map of how the system actually connects and behaves.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-search-check
  ---
  #title
  Find Architecture Issues Early

  #description
  Use Issue Finder to surface structural problems before they grow into production incidents.
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
Feature List

#description
Everything is built for graph clarity, fast tracing, and confident runtime decisions.

#features
  :::u-page-feature
  ---
  icon: i-lucide-network
  ---
  #title
  Dependency Graph

  #description
  Visualize modules, providers, controllers, imports, and dependency edges from the running app.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-refresh-cw
  ---
  #title
  Circular Detection

  #description
  Surface circular relationships early so teams can resolve risky loops before release.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-focus
  ---
  #title
  Relation Focus :badge[Coming Soon]{.ml-2}

  #description
  Coming soon: focus any provider/module pair to see how they relate and where dependencies connect.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-bot
  ---
  #title
  Context-Aware AI Assistant

  #description
  Ask graph and trace questions in plain language with context-aware answers, always free in the viewer.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-git-branch-plus
  ---
  #title
  Process Sequence :badge[Coming Soon]{.ml-2}

  #description
  Coming soon: generate sequence diagrams from an entry point to completion flow to document how a process really runs.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-play
  ---
  #title
  Direct Run :badge[Coming Soon]{.ml-2}

  #description
  Coming soon: execute runtime-resolved services and functions directly from the graph context to validate behavior faster.
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
AI Chat in Viewer

#description
From graph to decision in seconds. Ask trace questions in plain language and get answers grounded in your current runtime context.

#features
  :::u-page-feature
  ---
  icon: i-lucide-message-circle
  ---
  #title
  Ask Naturally

  #description
  Ask things like "trace `AuthService` dependencies" or "show the path from `OrdersModule` to `PaymentService`" with zero query syntax.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-file-check-2
  ---
  #title
  Grounded, Not Generic

  #description
  Every answer is grounded in loaded runtime graph context, and missing data is called out clearly.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-messages-square
  ---
  #title
  Unlimited Follow-Ups

  #description
  Keep the conversation going until the dependency path is clear and decisions are ready.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-route
  ---
  #title
  Trace Paths Faster

  #description
  Walk provider and module relationships quickly during debugging, architecture reviews, and PR checks.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-cpu
  ---
  #title
  Your Model, Your Environment

  #description
  Connect a local model through Ollama and keep architecture analysis in your own environment.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-zap
  ---
  #title
  Direct Run Ready :badge[Coming Soon]{.ml-2}

  #description
  Today: trace and reason with context-aware chat. Coming soon: trigger runtime-resolved execution flows from the same workspace.
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
