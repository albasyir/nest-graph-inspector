# Nest Graph Inspector

Nest Graph Inspector reads a NestJS runtime container and generates a dependency graph of modules, providers, controllers, and their relationships.

## Install

```bash
npm install nest-graph-inspector
```

## Usage

```ts
import { Module } from '@nestjs/common';
import { NestGraphInspectorModule } from 'nest-graph-inspector';

@Module({
  imports: [NestGraphInspectorModule],
})
export class AppModule {}
```

Start the Nest application to print the viewer URL.

## Documentation

See the [project documentation](https://albasyir.github.io/nest-graph-inspector/) for configuration options and output types.
