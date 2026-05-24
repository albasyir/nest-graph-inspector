<p align="center">
  <a href="https://albasyir.github.io/nest-graph-inspector/" target="_blank"><img src="https://albasyir.github.io/nest-graph-inspector/logo.png" width="120" alt="Nest Graph Inspector Logo" /></a>
</p>

<h1 align="center">Nest Graph Inspector</h1>

<p align="center">
<a href="https://www.npmjs.com/package/nest-graph-inspector" target="_blank"><img src="https://img.shields.io/npm/v/nest-graph-inspector.svg" alt="NPM Version" /></a>
<a href="https://github.com/albasyir/nest-graph-inspector/blob/main/LICENSE" target="_blank"><img src="https://img.shields.io/npm/l/nest-graph-inspector.svg" alt="Package License" /></a>
<a href="https://github.com/albasyir/nest-graph-inspector" target="_blank"><img src="https://img.shields.io/github/stars/albasyir/nest-graph-inspector?style=social" alt="Github Stars" /></a>
</p>

Nest Graph Inspector reads your NestJS runtime container and generates a dependency graph of modules, providers, controllers, and their relationships.

### Preview

This is a static preview. [**Try the interactive viewer with AI Chat →**](https://albasyir.github.io/nest-graph-inspector/view/) 

> "Load Example" to see result without installing it

## Why It Matters

Shipping speed depends on confidence. Teams need runtime visibility to trace impact, find architecture issues early, and ship safer changes.

- **Ship Changes Faster** — trace impact in minutes, not meetings, before touching critical providers or modules
- **Cut Regression Risk** — catch circular and high-coupling patterns before they become release blockers
- **Make PR Reviews Concrete** — replace assumptions with runtime-backed module and provider-level evidence
- **Onboard With Real Context** — give new engineers a live map of how the system actually connects and behaves
- **Find Architecture Issues Early** — use Issue Finder to surface structural problems before they grow into production incidents

## Feature List

- **Dependency Graph** — visualize modules, providers, controllers, imports, and dependency edges from the running app
- **Circular Detection** — surface circular relationships early so teams can resolve risky loops before release
- **Relation Focus** — coming soon: focus provider/module pairs to see how they relate and where dependencies connect
- **Context-Aware AI Assistant** — ask graph and trace questions in plain language with context-aware answers, always free in the viewer
- **Process Sequence** — coming soon: generate sequence diagrams from an entry point to completion flow
- **Direct Run** — coming soon: execute runtime-resolved services and functions directly from graph context

## Quick Start

```bash
npm install nest-graph-inspector 
```

> it's not only NPM, see [installation](https://albasyir.github.io/nest-graph-inspector/getting-started) for other package manager

```ts
import { Module } from '@nestjs/common';
import { NestGraphInspectorModule } from 'nest-graph-inspector';

@Module({
  imports: [NestGraphInspectorModule],
})
export class RootModule {}
```

Start your app — the viewer URL will be printed in your console.

> For full configuration options and output types, see the **[documentation →](https://albasyir.github.io/nest-graph-inspector/getting-started)**

## Documentation

Full setup guide, configuration options, and use cases are available on the documentation site.

<p align="center">
  <a href="https://albasyir.github.io/nest-graph-inspector/"><strong>📖 View Documentation →</strong></a>
</p>

## Stay in touch

- [Documentation](https://albasyir.github.io/nest-graph-inspector/)
- [NPM Package](https://www.npmjs.com/package/nest-graph-inspector)
- [GitHub Repository](https://github.com/albasyir/nest-graph-inspector)
- [Maintainer, Abdul Aziz Al Basyir](https://github.com/albasyir)
