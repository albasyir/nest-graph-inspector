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

## Export without running

`nest-graph-inspector export` writes the graph to a file without starting the
application — in CI, in a code review, or where it cannot run. It boots the
application in NestJS's [preview mode](https://docs.nestjs.com/devtools/ci-cd-integration),
which resolves every module and dependency but constructs nothing, calls no
factory or lifecycle hook, and never listens:

```bash
nest build
npx nest-graph-inspector export          # writes nest-graph.json
npx nest-graph-inspector export --out -  # or to stdout
```

The file is the `GraphOutput` a running inspector serves at `/output.json`,
built with the options the application passes to
`NestGraphInspectorModule.forRoot()`. The root module file is found from
`nest-cli.json` and the tsconfig `outDir`; `--entry`, `--module`, `--project`,
`--require` (for example `ts-node/register`, to export TypeScript sources
without building) and `--compact` are listed by
`npx nest-graph-inspector --help`. If your `main.ts` loads environment
variables before it imports `AppModule` (`import 'dotenv/config'`), pass them
with `--env-file .env` (Node.js 20.12+) or `--require dotenv/config`. Your
module files are still loaded, so code at their top level runs; see the
[documentation](https://albasyir.github.io/nest-graph-inspector/getting-started/export-graph)
for this and the other limits of preview mode.

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
