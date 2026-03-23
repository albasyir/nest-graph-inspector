# Nest Graph Inspector

Nest Graph Inspector is a NestJS module to generate a **runtime dependency graph** in **Markdown + Mermaid** format from the Nest application container.

It helps you inspect:

- loaded modules from the root module
- import relationships between modules
- providers and controllers in each module
- dependencies between providers/controllers
- internal dependencies, external module dependencies, and selected NestJS core dependencies

## Installation

```bash
npm install nest-graph-inspector
```

## Usage

### `forRoot`

Use `forRoot` when the config is static.

```ts
import { Module } from '@nestjs/common';
import { AppModule } from './app.module';
import { NestjsDevtoolModule } from 'nest-graph-inspector';

@Module({
  imports: [
    NestjsDevtoolModule.forRoot({
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

Use `forRootAsync` when the config should be created from a factory.

```ts
NestjsDevtoolModule.forRootAsync({
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

Root module used as the graph entry point.

```ts
rootModule: AppModule
```

### `output.file`

Markdown output file name.

```ts
output: {
  file: 'test.md'
}
```

## Output

The module generates a markdown file that contains:

- Mermaid dependency graph
- module list
- imports
- exports
- providers
- controllers
- provider/controller dependencies

## Example

### Basic

```ts
NestjsDevtoolModule.forRoot({
  rootModule: AppModule,
  output: {
    file: 'nestjs-dependency-graph.md',
  },
});
```

### Async

```ts
NestjsDevtoolModule.forRootAsync({
  useFactory() {
    return {
      rootModule: AppModule,
      output: {
        file: 'test.md',
      },
    };
  },
});
```

## How it works

Nest Graph Inspector will:

1. start from the configured root module
2. inspect the Nest runtime container
3. collect modules, imports, exports, providers, and controllers
4. resolve provider/controller dependencies
5. generate markdown and Mermaid graph output

## Notes

- the graph is generated from the **runtime Nest container**, not from static source parsing
- selected NestJS core dependencies can be grouped under **NestJS Core**
- if duplicate class names exist across multiple modules, dependency resolution should follow module/token ownership instead of only class name matching