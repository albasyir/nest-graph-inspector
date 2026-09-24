import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { ViewerOutputAdapter } from './viewer-output.adapter';
import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';
import type { RuntimeTrace } from '../types/direct-run.type';
import type { GraphOutput } from '../types/graph-output.type';
import {
  ACCESS_TOKEN_QUERY_PARAM,
  AccessTokenService,
} from '../access-token.service';
import { MODULE_OPTIONS_TOKEN } from '../nest-graph-inspector.config';

/** Reads back the graph endpoint the viewer link points at. */
function decodeViewerEndpoint(message: string): URL {
  const encoded = /\/view\/([A-Za-z0-9_-]+)/.exec(message)?.[1];
  if (!encoded) {
    throw new Error(`No viewer link found in message: ${message}`);
  }

  return new URL(Buffer.from(encoded, 'base64url').toString('utf8'));
}

describe(ViewerOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: ViewerOutputAdapter;
  let httpServeAdapter: HttpServeAdapter;
  let httpOutputAdapter: { execute: jest.Mock; normalizePath: jest.Mock };
  const nestedModules: TestingModule[] = [];

  /** Nested modules serve HTTP, so cleanup runs from a hook, not inline. */
  const createNestedModule = async (
    options: Record<string, unknown>,
  ): Promise<TestingModule> => {
    const nested = await Test.createTestingModule({
      providers: [
        ViewerOutputAdapter,
        HttpServeAdapter,
        DirectRunOutputAdapter,
        RuntimeTraceRecorder,
        AccessTokenService,
        { provide: HttpOutputAdapter, useValue: httpOutputAdapter },
        { provide: MODULE_OPTIONS_TOKEN, useValue: options },
      ],
    }).compile();

    nestedModules.push(nested);

    return nested;
  };

  beforeEach(async () => {
    httpOutputAdapter = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector HTTP endpoint is installed',
      }),
      normalizePath: jest.fn((path: string) =>
        path.startsWith('/') ? path : `/${path}`,
      ),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        ViewerOutputAdapter,
        HttpServeAdapter,
        DirectRunOutputAdapter,
        RuntimeTraceRecorder,
        AccessTokenService,
        {
          provide: HttpOutputAdapter,
          useValue: httpOutputAdapter,
        },
      ],
    }).compile();

    adapter = moduleRef.get(ViewerOutputAdapter);
    httpServeAdapter = moduleRef.get(HttpServeAdapter);
  });

  afterEach(async () => {
    await Promise.all(nestedModules.splice(0).map((nested) => nested.close()));
    await moduleRef.close();
  });

  it('normalizes the graph endpoint before installing and encoding it', async () => {
    const result = await adapter.execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:8889',
      path: 'graph',
    });
    const endpoint = decodeViewerEndpoint(result.message);

    expect(httpOutputAdapter.execute).toHaveBeenCalledWith(
      {},
      {
        type: 'http',
        origin: 'http://localhost:8889',
        host: undefined,
        port: undefined,
        path: '/graph',
        httpAdapter: httpServeAdapter,
      },
    );
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe(
      'http://localhost:8889/graph',
    );
  });

  it('carries an access token in the viewer link', async () => {
    const result = await adapter.execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:8889',
      path: 'graph',
    });

    const endpoint = decodeViewerEndpoint(result.message);
    const token = endpoint.searchParams.get(ACCESS_TOKEN_QUERY_PARAM);

    expect(token).toBeTruthy();
    expect(moduleRef.get(AccessTokenService).verify(token!)).toMatchObject({
      ok: true,
    });
    expect(result.message).toContain('access token expires at');
  });

  it('leaves the token out of the viewer link when logToken is off', async () => {
    // Tracked so cleanup survives a failed assertion; this module serves HTTP.
    const quiet = await createNestedModule({
      accessToken: { logToken: false },
    });

    const result = await quiet.get(ViewerOutputAdapter).execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:8889',
      path: 'graph',
    });
    const endpoint = decodeViewerEndpoint(result.message);

    expect(endpoint.searchParams.get(ACCESS_TOKEN_QUERY_PARAM)).toBeNull();
    expect(result.message).not.toContain(
      quiet.get(AccessTokenService).current(),
    );
    expect(result.message).toContain('accessToken.logToken is off');
  });

  it('passes native HTTP host and port options to the HTTP output adapter', async () => {
    const result = await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port: 3998,
      path: 'graph',
    });
    const endpoint = decodeViewerEndpoint(result.message);

    expect(httpOutputAdapter.execute).toHaveBeenCalledWith(
      {},
      {
        type: 'http',
        origin: undefined,
        host: '127.0.0.1',
        port: 3998,
        path: '/graph',
        httpAdapter: httpServeAdapter,
      },
    );
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe(
      'http://127.0.0.1:3998/graph',
    );
  });

  it('registers the direct-run route when configured', async () => {
    const port = await availablePort();
    const registerSpy = jest.spyOn(httpServeAdapter, 'register');

    await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port,
      path: 'graph',
      directRun: {
        path: '/direct-run',
        instanceLookup: () => ({ ping: () => 'pong' }),
      },
    } as never);

    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        port,
      }),
      [
        expect.objectContaining({
          path: '/direct-run',
          type: 'POST',
        }),
        expect.objectContaining({
          path: '/direct-run/histories',
          type: 'GET',
        }),
        expect.objectContaining({
          path: '/direct-run/history/index.json',
          type: 'GET',
        }),
        expect.objectContaining({
          path: '/direct-run/history/*',
          type: 'GET',
        }),
      ],
    );
  });

  it('does not register direct-run routes when disabled', async () => {
    const port = await availablePort();
    const registerSpy = jest.spyOn(httpServeAdapter, 'register');
    const graphOutput: GraphOutput = {
      version: '3',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [],
          controllers: [],
        },
      },
      cycles: { modules: [], providers: [], controllers: [] },
    };

    await adapter.execute(graphOutput, {
      type: 'viewer',
      host: '127.0.0.1',
      port,
      path: 'graph',
      directRun: {
        enabled: false,
        path: '/direct-run',
        instanceLookup: () => ({ ping: () => 'pong' }),
      },
    } as never);

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('hides direct-run metadata from a disabled viewer without resolving or mutating its graph source', async () => {
    const graphOutput: GraphOutput = {
      version: '3',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [
            {
              name: 'AppService',
              dependencies: [],
              directRun: {
                methods: [{ name: 'ping', parameterTypes: '()' }],
              },
            },
          ],
          controllers: [],
        },
      },
      cycles: { modules: [], providers: [], controllers: [] },
    };
    const graphSource = jest.fn(async () => graphOutput);

    await adapter.execute(graphSource, {
      type: 'viewer',
      path: 'graph',
      directRun: { enabled: false },
    });

    const projectedSource = httpOutputAdapter.execute.mock.calls[0]?.[0] as
      | (() => Promise<GraphOutput>)
      | undefined;

    expect(typeof projectedSource).toBe('function');
    expect(graphSource).not.toHaveBeenCalled();

    const projectedGraph = await projectedSource?.();

    expect(projectedGraph?.modules.AppModule?.providers).toEqual([
      { name: 'AppService', dependencies: [] },
    ]);
    expect(graphOutput.modules.AppModule?.providers[0]?.directRun).toEqual({
      methods: [{ name: 'ping', parameterTypes: '()' }],
    });
    expect(graphSource).toHaveBeenCalledTimes(1);
  });

  it('keeps direct-run metadata in an enabled viewer graph', async () => {
    const graphOutput: GraphOutput = {
      version: '3',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [
            {
              name: 'AppService',
              dependencies: [],
              directRun: {
                methods: [{ name: 'ping', parameterTypes: '()' }],
              },
            },
          ],
          controllers: [],
        },
      },
      cycles: { modules: [], providers: [], controllers: [] },
    };

    await adapter.execute(graphOutput, {
      type: 'viewer',
      path: 'graph',
      directRun: { enabled: true },
    });

    expect(httpOutputAdapter.execute).toHaveBeenCalledWith(
      graphOutput,
      expect.any(Object),
    );
  });

  it('writes a disk history index from the retained trace set', async () => {
    const recorder = moduleRef.get(RuntimeTraceRecorder);
    const traces: RuntimeTrace[] = [];
    for (let index = 0; index < 101; index += 1) {
      const handle = recorder.start({
        moduleName: 'AppModule',
        providerName: 'PingProvider',
        methodName: `ping${index}`,
        args: [],
      });
      traces.push(await recorder.finishSuccess(handle, index));
    }

    const historyDir = await mkdtemp(join(tmpdir(), 'ngi-history-'));
    try {
      await (
        adapter as unknown as {
          writeHistoryFiles: (dirPath: string, trace: (typeof traces)[number]) => Promise<void>;
        }
      ).writeHistoryFiles(historyDir, traces.at(-1)!);
      const index = JSON.parse(
        await readFile(join(historyDir, 'index.json'), 'utf8'),
      ) as Array<{ traceId: string }>;

      expect(index).toHaveLength(100);
      expect(index.map((item) => item.traceId)).not.toContain(traces[0]!.traceId);
      expect(index.at(-1)?.traceId).toBe(traces.at(-1)?.traceId);
    } finally {
      await rm(historyDir, { recursive: true, force: true });
    }
  });

  it('registers only the graph and direct-run routes on the viewer origin', async () => {
    const port = await availablePort();
    const registerSpy = jest.spyOn(httpServeAdapter, 'register');

    // The viewer output used to relay browser requests to a local LLM daemon
    // through an extra registration on this same origin. Inference now runs in
    // the browser, so the adapter needs no relay collaborator at all and the
    // origin carries only the graph endpoint and direct run. The graph
    // endpoint itself is installed through the stubbed HttpOutputAdapter, so
    // the one registration seen here is direct run's.
    await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port,
      path: 'graph',
      directRun: {
        path: '/direct-run',
        instanceLookup: () => ({ ping: () => 'pong' }),
      },
    } as never);

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(
      registerSpy.mock.calls.flatMap(([, routes]) =>
        routes.map((route) => route.path),
      ),
    ).toEqual([
      '/direct-run',
      '/direct-run/histories',
      '/direct-run/history/index.json',
      '/direct-run/history/*',
    ]);
    expect(httpOutputAdapter.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses to invoke a provider method without a valid token', async () => {
    const port = await availablePort();
    const ping = jest.fn().mockReturnValue('pong');

    class PingProvider {
      public ping(): string {
        return ping();
      }
    }

    await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port,
      path: 'graph',
      directRun: {
        path: '/direct-run',
        instanceLookup: () => new PingProvider(),
        allowedMethodsLookup: () => new Set(['ping']),
      },
    } as never);

    const body = JSON.stringify({
      module: 'AppModule',
      provider: 'AppService',
      method: 'ping',
    });
    const url = `http://127.0.0.1:${port}/direct-run`;

    const rejected = await post(url, body);
    expect(rejected.statusCode).toBe(401);
    expect(JSON.parse(rejected.body)).toMatchObject({ reason: 'missing' });
    expect(ping).not.toHaveBeenCalled();

    const accepted = await post(url, body, {
      authorization: `Bearer ${moduleRef.get(AccessTokenService).current()}`,
    });
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({
      ok: true,
      result: 'pong',
    });
    expect(ping).toHaveBeenCalledTimes(1);
  });
});

function post(
  url: string,
  body: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let responseBody = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () =>
          resolve({ statusCode: res.statusCode, body: responseBody }),
        );
      },
    );

    req.on('error', reject);
    req.end(body);
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
