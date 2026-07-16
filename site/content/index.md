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
  :u-icon{name="i-lucide-bot" class="size-9 shrink-0 text-primary"}
  Context-Aware AI Assistant
::

#description
Ask graph and trace questions in plain language. In the real viewer, answers are grounded in your loaded runtime graph.

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
  icon: i-lucide-cpu
  ---
  #title
  Your Model, Your Environment

  #description
  Use Ollama to keep architecture analysis in your own environment.
  :::

#default
  :runtime-a-i-chat-preview
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
  :u-icon{name="i-lucide-play" class="size-9 shrink-0 text-primary"}
  Run Providers From The Graph
::

#description
Turn your runtime graph into an action surface. Select `Service` inside `Module`, choose a method, and execute the resolved provider without building a temporary endpoint.

#features
  :::u-page-feature
  ---
  icon: i-lucide-box
  ---
  #title
  Provider-First Execution

  #description
  Run the provider NestJS already resolved in its module context.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-file-json
  ---
  #title
  JSON Arguments

  #description
  Pass method inputs from the graph and inspect the result in place.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-zap
  ---
  #title
  Faster Runtime Checks

  #description
  Validate service behavior without wiring a controller, route, or one-off script.
  :::

#default
  :runtime-graph-direct-run-preview
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
