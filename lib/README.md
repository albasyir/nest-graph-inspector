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

## Viewer graph endpoint

Viewer output installs its HTTP routes during Nest bootstrap but defers container
inspection until graph data is requested. This avoids a graph scan when the
viewer is never opened.

For a viewer configured with `path` (default: `/__graph-inspector`) and its
configured `origin`/`host`/`port`, clients use these existing endpoints:

- `GET {origin}{path}/output.json` generates the graph on the first request and
  returns the `GraphOutput` JSON. Later requests reuse the generated graph for
  the lifetime of the inspector.
- `GET {origin}{path}/output.md` generates the same graph if necessary and
  returns its Markdown representation.
- `GET {origin}{path}/information.json` and
  `GET {origin}{path}/output.schema.json` are available immediately and do not
  trigger graph discovery.

No viewer-specific request body, query parameter, or UI handshake is required:
requesting `output.json` is the graph-publication trigger. If discovery fails,
the endpoint returns HTTP 500; a later request can retry discovery.

## Documentation

See the [project documentation](https://albasyir.github.io/nest-graph-inspector/) for configuration options and output types.
