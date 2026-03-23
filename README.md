# Nest Graph Inspector

Nest Graph Inspector is a NestJS module to generate a **runtime dependency graph** in **Markdown + Mermaid** format from the Nest application container.

The generated graph shows:

- loaded modules from the root module
- import relationships between modules
- providers and controllers in each module
- dependencies between providers/controllers
- internal dependencies, external module dependencies, and selected NestJS core dependencies

> [!WARNING]
> This package is still in v0, so some API changes may be breaking between releases while the package is being stabilized. Current features are expected to stay, but their API or configuration may still change.

## Use Cases

### Impact Analysis

- narrowing regression test scope to the most relevant modules/providers
- reducing unnecessary testing for unrelated areas
- understanding the likely blast radius before making a change

### Test Prioritization

- selecting critical providers/use cases for fast validation
- understanding dependency chains between providers/controllers
- prioritizing which flows should be checked first after a change

### Architecture Visibility

- onboarding engineers faster
- spotting highly coupled modules/providers
- making refactors safer by visualizing relationships before changes

## Installation

```bash
npm install nest-graph-inspector
```

## Usage

### `forRoot`

Static config.

```ts
import { Module } from '@nestjs/common';
import { AppModule } from './app.module';
import { NestGraphInspector } from 'nest-graph-inspector';

@Module({
  imports: [
    NestGraphInspector.forRoot({
      rootModule: AppModule,
      output: {
        file: 'test.md',
      },
    }),
  ],
})
export class RootModule {}
```

### `forRootAsync`

Factory-based config.

```ts
NestGraphInspector.forRootAsync({
  useFactory() {
    return {
      rootModule: AppModule,
      output: {
        file: 'test.md',
      },
    };
  },
}),
```

## Config

### `rootModule`

Graph entry point.

```ts
rootModule: AppModule
```

### `output.file`

Output markdown file name.

```ts
output: {
  file: 'test.md'
}
```

## Output

all output will contains

- module list
- imports module
- exports provider
- providers with dependencies
- controllers with dependencies

when markdown file as output, it will show depedencies graph as

> this using mermaid, plugin on text editor might needed

## Flow

1. start from the configured root module  
2. inspect the Nest runtime container  
3. collect module and provider metadata  
4. resolve dependencies  
5. generate output

## Notes

- the graph is generated from the **runtime Nest container**, not from static source parsing
- selected NestJS core dependencies can be grouped under **NestJS Core**
- the graph helps with impact analysis and test planning, but it does not guarantee the full real-world impact of a change because some effects may come from databases, events, config, external services, or other side effects outside the runtime dependency graph