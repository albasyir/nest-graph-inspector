---
seo:
  title: Nest Graph Inspector - Runtime Dependency Graph for NestJS
  description: Generate runtime dependency graphs in Markdown + Mermaid or JSON format from your NestJS application container.
---

::u-page-hero{class="dark:bg-gradient-to-b from-neutral-900 to-neutral-950"}
---
orientation: horizontal
---
#top
:hero-background

#title
Visualize Your [NestJS]{.text-primary} Architecture.

#description
Generate **runtime dependency graphs** in Markdown + Mermaid or JSON format directly from the Nest application container. See modules, providers, controllers, and every dependency at a glance.

#links
  :::u-button
  ---
  to: /getting-started
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
  View on GitHub
  :::

#default
  :::prose-pre
  ---
  code: |
    import { Module } from '@nestjs/common';
    import { NestGraphInspector } from 'nest-graph-inspector';
    import { AppModule } from './app.module';

    @Module({
      imports: [
        NestGraphInspector.forRoot({
          rootModule: AppModule,
          output: { file: 'graph.md' },
        }),
      ],
    })
    export class RootModule {}
  filename: root.module.ts
  ---

  ```ts [root.module.ts]
  import { Module } from '@nestjs/common';
  import { NestGraphInspector } from 'nest-graph-inspector';
  import { AppModule } from './app.module';

  @Module({
    imports: [
      NestGraphInspector.forRoot({
        rootModule: AppModule,
        output: { file: 'graph.md' },
      }),
    ],
  })
  export class RootModule {}
  ```
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
Why Nest Graph Inspector?

#description
Understand your NestJS architecture without digging through code. The graph is generated from the **runtime Nest container**, not static source parsing.

#features
  :::u-page-feature
  ---
  icon: i-lucide-git-branch
  ---
  #title
  Module Dependency Graph

  #description
  Automatically maps import relationships between all loaded modules from your root module, giving you a clear view of your application structure.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-boxes
  ---
  #title
  Provider & Controller Mapping

  #description
  Lists every provider and controller in each module alongside their dependency chains, so you know exactly what depends on what.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-file-code
  ---
  #title
  Markdown + Mermaid Output

  #description
  Generates beautiful Mermaid diagrams embedded in Markdown files. View them directly on GitHub, VSCode, or any Mermaid-compatible viewer.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-braces
  ---
  #title
  JSON Output

  #description
  Get structured JSON output for programmatic analysis, custom tooling, or integration with your CI/CD pipeline.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-zap
  ---
  #title
  Runtime Introspection

  #description
  Built on the actual Nest runtime container — what you see is what's really running. No guesswork from static analysis.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-plug
  ---
  #title
  Drop-in Module

  #description
  Just import the module with `forRoot` or `forRootAsync` and you're done. No decorators to add, no code to change. Works with NestJS 10-11.
  :::
::

::u-page-section{class="dark:bg-neutral-950"}
#title
Use Cases

#description
Real problems this solves for your team.

#features
  :::u-page-feature
  ---
  icon: i-lucide-target
  ---
  #title
  Impact Analysis

  #description
  Narrow regression test scope to relevant modules, understand blast radius before making a change, and reduce unnecessary testing for unrelated areas.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-list-checks
  ---
  #title
  Test Prioritization

  #description
  Select critical providers for fast validation, understand dependency chains between providers/controllers, and prioritize which flows to check first.
  :::

  :::u-page-feature
  ---
  icon: i-lucide-eye
  ---
  #title
  Architecture Visibility

  #description
  Onboard engineers faster, spot highly coupled modules/providers, and make refactors safer by visualizing relationships before changes.
  :::
::

::u-page-section{class="dark:bg-gradient-to-b from-neutral-950 to-neutral-900"}
  :::u-page-c-t-a
  ---
  links:
    - label: Get Started
      to: '/getting-started'
      trailingIcon: i-lucide-arrow-right
    - label: View on GitHub
      to: 'https://github.com/albasyir/nest-graph-inspector'
      target: _blank
      variant: subtle
      icon: i-simple-icons-github
  title: Ready to see your dependency graph?
  description: Install in seconds, get a full graph of your NestJS application on the next run.
  class: dark:bg-neutral-950
  ---

  :stars-bg
  :::
::
