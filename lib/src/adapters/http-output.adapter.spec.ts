import http from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import type { GraphOutput } from '../types/graph-output.type';
import { FileOutputAdapter } from './file-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { createInspectorEndpointInfo } from '../inspector-endpoint-info';
import { GRAPH_OUTPUT_JSON_SCHEMA } from '../types/graph-output.schema';
import {
  ACCESS_TOKEN_HEADER,
  ACCESS_TOKEN_QUERY_PARAM,
  AccessTokenService,
} from '../access-token.service';
import { MODULE_OPTIONS_TOKEN } from '../nest-graph-inspector.config';

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
  let accessTokenService: AccessTokenService;
  /** Every inspector endpoint is token-gated, so the happy path presents one. */
  const get = (url: string) =>
    httpGet(url, {
      authorization: `Bearer ${accessTokenService.current()}`,
    });
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
      providers: [
        FileOutputAdapter,
        HttpServeAdapter,
        HttpOutputAdapter,
        AccessTokenService,
        { provide: MODULE_OPTIONS_TOKEN, useValue: {} },
      ],
    }).compile();

    adapter = moduleRef.get(HttpOutputAdapter);
    accessTokenService = moduleRef.get(AccessTokenService);
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
    expect(result.message).toContain(
      `Graph inspector HTTP endpoints are installed at http://127.0.0.1:${port}/graph/information.json, http://127.0.0.1:${port}/graph/output.json, and http://127.0.0.1:${port}/graph/output.md`,
    );
  });

  it('states the access token once so an operator can pick it up', async () => {
    const port = await availablePort();

    const result = await adapter.execute({} as never, {
      type: 'http',
      host: '127.0.0.1',
      port,
      path: 'graph',
    });
    const token = /Access token \(expires at [^)]+\): (\S+)$/.exec(
      result.message,
    )?.[1];

    expect(token).toBeTruthy();
    expect(accessTokenService.verify(token!)).toMatchObject({ ok: true });
  });

  it('uses the default endpoint when no path is configured', () => {
    expect(adapter.normalizePath()).toBe('/__nest-graph-inspector');
  });

  it('defers resolving a graph source until its output endpoint is requested', async () => {
    const port = await availablePort();
    const graphOutput: GraphOutput = {
      version: '3',
      root: 'AppModule',
      modules: {},
      cycles: emptyCycles(),
    };
    const graphSource = jest.fn().mockResolvedValue(graphOutput);

    await adapter.execute(graphSource, {
      type: 'http',
      host: '127.0.0.1',
      port,
      path: '/graph',
    });

    expect(graphSource).not.toHaveBeenCalled();

    const response = await get(`http://127.0.0.1:${port}/graph/output.json`);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(graphOutput);
    expect(graphSource).toHaveBeenCalledTimes(1);
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

  describe('access token', () => {
    let outputUrl: string;

    beforeEach(async () => {
      const port = await availablePort();
      await adapter.execute({} as never, {
        type: 'http',
        host: '127.0.0.1',
        port,
        path: '/graph',
      });
      outputUrl = `http://127.0.0.1:${port}/graph/output.json`;
    });

    it('rejects a request that carries no token', async () => {
      const response = await httpGet(outputUrl);

      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe(
        'Bearer realm="nest-graph-inspector"',
      );
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        reason: 'missing',
      });
    });

    it('rejects a token signed by another application', async () => {
      const foreignToken = new AccessTokenService({
        accessToken: { secret: 'a-different-application' },
      }).current();

      const response = await httpGet(outputUrl, {
        authorization: `Bearer ${foreignToken}`,
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({ reason: 'signature' });
    });

    it('rejects a token that has passed its expiry', async () => {
      const port = await availablePort();
      const shortLived = await Test.createTestingModule({
        providers: [
          FileOutputAdapter,
          HttpServeAdapter,
          HttpOutputAdapter,
          AccessTokenService,
          {
            // Long enough that the pre-expiry request is not a race, short
            // enough to expire inside the test.
            provide: MODULE_OPTIONS_TOKEN,
            useValue: { accessToken: { ttlMs: 400 } },
          },
        ],
      }).compile();

      await shortLived.get(HttpOutputAdapter).execute({} as never, {
        type: 'http',
        host: '127.0.0.1',
        port,
        path: '/graph',
      });

      const token = shortLived.get(AccessTokenService).current();
      const url = `http://127.0.0.1:${port}/graph/output.json`;
      const authorization = { authorization: `Bearer ${token}` };

      await expect(httpGet(url, authorization)).resolves.toMatchObject({
        statusCode: 200,
      });

      await new Promise((resolve) => setTimeout(resolve, 450));
      const response = await httpGet(url, authorization);

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({ reason: 'expired' });

      await shortLived.close();
    });

    it('accepts the token from the dedicated header', async () => {
      const response = await httpGet(outputUrl, {
        [ACCESS_TOKEN_HEADER]: accessTokenService.current(),
      });

      expect(response.statusCode).toBe(200);
    });

    it('accepts the token from the query parameter the viewer link carries', async () => {
      const url = new URL(outputUrl);
      url.searchParams.set(
        ACCESS_TOKEN_QUERY_PARAM,
        accessTokenService.current(),
      );

      const response = await httpGet(url.toString());

      expect(response.statusCode).toBe(200);
    });

    it('blocks a client that keeps guessing tokens', async () => {
      const port = await availablePort();
      const limited = await Test.createTestingModule({
        providers: [
          FileOutputAdapter,
          HttpServeAdapter,
          HttpOutputAdapter,
          AccessTokenService,
          {
            provide: MODULE_OPTIONS_TOKEN,
            useValue: {
              accessToken: {
                bruteForce: { maxFailures: 3, blockMs: 60_000 },
              },
            },
          },
        ],
      }).compile();

      await limited.get(HttpOutputAdapter).execute({} as never, {
        type: 'http',
        host: '127.0.0.1',
        port,
        path: '/graph',
      });

      const url = `http://127.0.0.1:${port}/graph/output.json`;
      const guess = (attempt: number) =>
        httpGet(url, { authorization: `Bearer ngi1.payload.guess${attempt}` });

      // Three guesses are allowed; the third is what trips the block.
      expect((await guess(1)).statusCode).toBe(401);
      expect((await guess(2)).statusCode).toBe(401);
      expect((await guess(3)).statusCode).toBe(401);

      const blocked = await guess(4);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect(JSON.parse(blocked.body)).toMatchObject({ reason: 'blocked' });

      // A valid token is refused too: the block is on the client, not the token.
      const withValidToken = await httpGet(url, {
        authorization: `Bearer ${limited.get(AccessTokenService).current()}`,
      });
      expect(withValidToken.statusCode).toBe(429);

      await limited.close();
    });

    it('does not count a request that presents no token as a guess', async () => {
      const port = await availablePort();
      const limited = await Test.createTestingModule({
        providers: [
          FileOutputAdapter,
          HttpServeAdapter,
          HttpOutputAdapter,
          AccessTokenService,
          {
            provide: MODULE_OPTIONS_TOKEN,
            useValue: { accessToken: { bruteForce: { maxFailures: 2 } } },
          },
        ],
      }).compile();

      await limited.get(HttpOutputAdapter).execute({} as never, {
        type: 'http',
        host: '127.0.0.1',
        port,
        path: '/graph',
      });
      const url = `http://127.0.0.1:${port}/graph/output.json`;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await httpGet(url)).statusCode).toBe(401);
      }

      await expect(
        httpGet(url, {
          authorization: `Bearer ${limited.get(AccessTokenService).current()}`,
        }),
      ).resolves.toMatchObject({ statusCode: 200 });

      await limited.close();
    });

    it('serves the endpoint unguarded when token protection is turned off', async () => {
      const port = await availablePort();
      const unguarded = await Test.createTestingModule({
        providers: [
          FileOutputAdapter,
          HttpServeAdapter,
          HttpOutputAdapter,
          AccessTokenService,
          {
            provide: MODULE_OPTIONS_TOKEN,
            useValue: { accessToken: { enabled: false } },
          },
        ],
      }).compile();

      await unguarded.get(HttpOutputAdapter).execute({} as never, {
        type: 'http',
        host: '127.0.0.1',
        port,
        path: '/graph',
      });

      const response = await httpGet(
        `http://127.0.0.1:${port}/graph/output.json`,
      );

      expect(response.statusCode).toBe(200);

      await unguarded.close();
    });
  });
});

function httpGet(
  url: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
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
