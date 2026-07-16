import http from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import type { GraphOutput } from '../types/graph-output.type';
import { FileOutputAdapter } from './file-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { createInspectorEndpointInfo } from '../inspector-endpoint-info';
import { GRAPH_OUTPUT_JSON_SCHEMA } from '../types/graph-output.schema';

const { version: packageVersion } = require('../../package.json') as {
  version: string;
};

type HttpResponse = {
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

describe(HttpOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: HttpOutputAdapter;
  const emptyCycles = () => ({
    modules: [],
    providers: [],
    controllers: [],
  });

  beforeEach(async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: packageVersion })),
    );
    moduleRef = await Test.createTestingModule({
      providers: [FileOutputAdapter, HttpServeAdapter, HttpOutputAdapter],
    }).compile();

    adapter = moduleRef.get(HttpOutputAdapter);
  });

  afterEach(() => moduleRef.close());

  it('normalizes configured paths without mutating config', async () => {
    const port = await availablePort();
    const config = {
      type: 'http' as const,
      host: '127.0.0.1',
      port,
      path: 'graph',
    };

    const result = await adapter.execute({} as never, config);

    expect(config.path).toBe('graph');
    expect(result.message).toBe(
      `Graph inspector HTTP endpoints are installed at http://127.0.0.1:${port}/graph/information.json, http://127.0.0.1:${port}/graph/output.json, and http://127.0.0.1:${port}/graph/output.md`,
    );
  });

  it('uses the default endpoint when no path is configured', () => {
    expect(adapter.normalizePath()).toBe('/__nest-graph-inspector');
  });

  it('serves endpoint metadata, raw JSON, schema, and markdown output under child paths', async () => {
    const port = await availablePort();
    const graphOutput: GraphOutput = {
      version: '2',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [],
          controllers: [],
        },
      },
      cycles: emptyCycles(),
    };

    const result = await adapter.execute(graphOutput, {
      type: 'http',
      host: '127.0.0.1',
      port,
      path: '/graph',
    });
    const informationOutputUrl = urlFromMessage(
      result.message,
      '/graph/information.json',
    );
    const jsonOutputUrl = urlFromMessage(result.message, '/graph/output.json');
    const jsonSchemaOutputUrl = new URL(
      '/graph/output.schema.json',
      jsonOutputUrl,
    ).toString();
    const markdownOutputUrl = urlFromMessage(
      result.message,
      '/graph/output.md',
    );

    const informationResponse = await get(informationOutputUrl);
    expect(informationResponse.statusCode).toBe(200);
    expect(informationResponse.headers['access-control-allow-origin']).toBe(
      '*',
    );
    expect(informationResponse.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(JSON.parse(informationResponse.body)).toEqual(
      await createInspectorEndpointInfo(false),
    );

    const jsonResponse = await get(jsonOutputUrl);
    expect(jsonResponse.statusCode).toBe(200);
    expect(jsonResponse.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(JSON.parse(jsonResponse.body)).toEqual(graphOutput);

    const jsonSchemaResponse = await get(jsonSchemaOutputUrl);
    expect(jsonSchemaResponse.statusCode).toBe(200);
    expect(jsonSchemaResponse.headers['content-type']).toBe(
      'application/schema+json; charset=utf-8',
    );
    expect(JSON.parse(jsonSchemaResponse.body)).toEqual(
      GRAPH_OUTPUT_JSON_SCHEMA,
    );
    expect(
      JSON.parse(jsonSchemaResponse.body).$defs.provider.properties.jsdoc,
    ).toEqual({
      type: 'string',
    });
    expect(
      JSON.parse(jsonSchemaResponse.body).$defs.module.properties.jsdoc,
    ).toEqual({
      type: 'string',
    });

    const markdownResponse = await get(markdownOutputUrl);
    expect(markdownResponse.statusCode).toBe(200);
    expect(markdownResponse.headers['content-type']).toBe(
      'text/markdown; charset=utf-8',
    );
    expect(markdownResponse.body).toContain('# NestJS Dependency Graph');
    expect(markdownResponse.body).toContain('```mermaid');
    expect(markdownResponse.body).not.toContain('Root Module: `AppModule`');
    expect(markdownResponse.body).not.toContain('Version: `0`');
  });

  it('lets host and port override a configured origin', async () => {
    const port = await availablePort();
    const result = await adapter.execute({} as never, {
      type: 'http',
      origin: 'http://localhost:3998',
      host: '127.0.0.1',
      port,
      path: '/graph',
    });

    expect(result.message).toContain(
      `http://127.0.0.1:${port}/graph/information.json`,
    );
  });

  it('registers multiple output routes on the injected native HTTP server', async () => {
    const port = await availablePort();
    const firstResult = await adapter.execute({} as never, {
      type: 'http',
      host: '127.0.0.1',
      port,
      path: '/graph',
    });
    const firstOutputUrl = urlFromMessage(
      firstResult.message,
      '/graph/output.json',
    );

    const secondResult = await adapter.execute({} as never, {
      type: 'http',
      host: '127.0.0.1',
      port,
      path: '/inspector',
    });
    const secondOutputUrl = urlFromMessage(
      secondResult.message,
      '/inspector/output.json',
    );

    expect(new URL(secondOutputUrl).origin).toBe(
      new URL(firstOutputUrl).origin,
    );
    await expect(get(firstOutputUrl)).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(get(secondOutputUrl)).resolves.toMatchObject({
      statusCode: 200,
    });
  });
});

function get(url: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Expected TCP address')));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function urlFromMessage(message: string, path: string): string {
  const match = message.match(
    new RegExp(`http://127\\.0\\.0\\.1:\\d+${path.replace('.', '\\.')}`),
  );

  if (!match) {
    throw new Error(`Expected message to include ${path}`);
  }

  return match[0];
}
