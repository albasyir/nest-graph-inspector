<p align="center">
  <a href="https://albasyir.github.io/nest-graph-inspector/" target="_blank"><img src="https://albasyir.github.io/nest-graph-inspector/logo.png" width="120" alt="Nest Graph Inspector Logo" /></a>
</p>

  <p align="center">A <a href="https://nestjs.com" target="_blank">NestJS</a> module to generate a <strong>runtime dependency graph</strong> from the Nest application container.</p>
    <p align="center">
<a href="https://www.npmjs.com/package/nest-graph-inspector" target="_blank"><img src="https://img.shields.io/npm/v/nest-graph-inspector.svg" alt="NPM Version" /></a>
<a href="https://github.com/albasyir/nest-graph-inspector/blob/main/LICENSE" target="_blank"><img src="https://img.shields.io/npm/l/nest-graph-inspector.svg" alt="Package License" /></a>
<a href="https://github.com/albasyir/nest-graph-inspector" target="_blank"><img src="https://img.shields.io/github/stars/albasyir/nest-graph-inspector?style=social" alt="Github Stars" /></a>
</p>

## Description

**Nest Graph Inspector** is a NestJS module that generates a **runtime dependency graph** directly from the Nest application container. Explore them dynamically in our **Interactive Web Viewer** or export to **JSON** format. See modules, providers, controllers, and every dependency at a glance.

The generated graph shows:
- Loaded modules from the root module
- Import relationships between modules
- Providers and controllers in each module
- Dependencies between providers/controllers
- Internal dependencies, external module dependencies, and selected NestJS core dependencies

> **Note:** The graph is generated from the **runtime Nest container**, not from static source parsing. What you see is what's actually running! You can try the interactive viewer directly at our [Example Preview](https://albasyir.github.io/nest-graph-inspector/view/aHR0cHM6Ly9hbGJhc3lpci5naXRodWIuaW8vbmVzdC1ncmFwaC1pbnNwZWN0b3IvZ3JhcGgtb3V0cHV0Lmpzb24=).

## Why Nest Graph Inspector?

Understand your NestJS architecture without digging through code. 

- **Module Dependency Graph**: Automatically maps import relationships between all loaded modules from your root module.
- **Provider & Controller Mapping**: Lists every provider and controller in each module alongside their dependency chains.
- **Interactive Web Viewer**: Explore your dependency graph dynamically in the browser. Zoom, pan, and inspect nodes.
- **JSON Output**: Get structured JSON output for programmatic analysis or integration tightly with tooling.
- **Runtime Introspection**: Built on the actual Nest runtime container — what you see is what's really running.
- **Drop-in Module**: Just import the module with `forRoot` or `forRootAsync` and you're done. No decorators to add, no code to change.

## Use Cases

Important to see what's actual problem that can be solved with this, we think you have them too!

- **Impact Analysis**: Narrow regression test scope to relevant modules, understand blast radius before making a change, and reduce unnecessary testing for unrelated areas.
- **Test Prioritization**: Select critical providers for fast validation, understand dependency chains between providers/controllers, and prioritize which flows to check first.
- **Architecture Visibility**: Onboard engineers faster, spot highly coupled modules/providers, and make refactors safer by visualizing relationships before changes.

## Installation

Choose the command for your runtime and package manager.

| Runtime | Package manager | Command |
| ------- | --------------- | ------- |
| Node.js >= 18 | npm | `npm install nest-graph-inspector` |
| Node.js >= 18 | yarn | `yarn add nest-graph-inspector` |
| Node.js >= 18 | pnpm | `pnpm add nest-graph-inspector` |
| Bun >= 1.1 | bun | `bun add nest-graph-inspector` |

> **Version Support:** Official support for **Node.js >= 18**, **Bun >= 1.1**, and **NestJS 10-11**.
> 
> Earlier NestJS versions may still work but are not officially supported. You can force install with `npm install nest-graph-inspector --force`, `yarn add nest-graph-inspector --ignore-engines`, or `pnpm add nest-graph-inspector --force`.

## Getting started

Enable the inspector in your main `AppModule`. We recommend the `viewer` output so you can interactively explore your graph directly from your browser.

```ts
import { Module } from '@nestjs/common';
import { NestGraphInspector } from 'nest-graph-inspector';

@Module({
  imports: [
    NestGraphInspector
  ],
})
export class RootModule {}
```

If your configuration depends on external services or variables, you can use `forRootAsync` instead.

```ts
NestGraphInspector.forRootAsync({
  useFactory() {
    return {
      outputs: [
        { type: 'viewer' }
      ]
    };
  },
})
```

Once configured, simply start your NestJS application as usual (`npm run start`, `yarn start`, `pnpm start`, or `bun run start`). **The inspector will automatically print the Viewer URL and graph endpoint path in your application's console.** Open the [Viewer](https://albasyir.github.io/nest-graph-inspector/view) page, then enter your NestJS application's origin URL to see your graph. If you configure `origin`, the inspector prints a direct Viewer link instead.

## Stay in touch

- Abdul Aziz Al Basyir - [https://github.com/albasyir](https://github.com/albasyir)
- Library Homepage - [https://albasyir.github.io/nest-graph-inspector/](https://albasyir.github.io/nest-graph-inspector/)
- GitHub - [nest-graph-inspector](https://github.com/albasyir/nest-graph-inspector)
