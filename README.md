# Nest Graph Inspector

Nest Graph Inspector is a NestJS module to generate a **runtime dependency graph** in **Markdown + Mermaid** or **JSON** format from the Nest application container.

The generated graph shows:

- loaded modules from the root module
- import relationships between modules
- providers and controllers in each module
- dependencies between providers/controllers
- internal dependencies, external module dependencies, and selected NestJS core dependencies

> [!NOTE]
> Result of markdown can be seen on https://github.com/albasyir/nest-graph-inspector/tree/main/src/graph-output.md

## Use Cases

important to see what's actual problem that can be solved with this, we think you have them too!

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

## Version Supports

Official support: NestJS 10-11.

> [!NOTE]
> Earlier versions may still work, but are not officially supported. 
> If you still want to install it with an unsupported NestJS version, you can force install it with:
>
> ```bash
> npm install nest-graph-inspector --force
> ```
>
> When you test it and work prefectly, raise on issue so i will update support coverage too

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

when markdown file as output, it will show depedencies graph

> markdown use mermaid, open markdown in place that support mermaid, 
> in VSC you can install plugin

## Flow

1. start from the configured root module  
2. inspect the Nest runtime container  
3. collect module and provider metadata  
4. resolve dependencies  
5. generate output

## Notes

- the graph is generated from the **runtime Nest container**, not from static source parsing
- selected NestJS core dependencies can be grouped under **NestJS Core** Module as Global Module