import http from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';

import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';

type DirectRunResponseBody = {
  ok: boolean;
  method?: string;
  result?: unknown;
  error?: string;
  runId?: string;
  traceId?: string;
  runtimeTrace?: {
    traceId?: string;
    runId?: string;
    status: string;
    totalSpans: number;
    failedSpanId?: string;
    spans: unknown[];
  };
};

function parseJson(body: string): DirectRunResponseBody {
  return JSON.parse(body) as DirectRunResponseBody;
}

describe(DirectRunOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: DirectRunOutputAdapter;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        HttpServeAdapter,
        RuntimeTraceRecorder,
        DirectRunOutputAdapter,
      ],
    }).compile();

    adapter = moduleRef.get(DirectRunOutputAdapter);
  });

  afterEach(() => moduleRef.close());

  it('executes zero-argument provider methods over HTTP', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', (moduleName, providerName) => {
          if (moduleName === 'AppModule' && providerName === 'PingProvider') {
            return {
              ping: () => 'pong',
            };
          }

          return undefined;
        }),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'PingProvider',
      method: 'ping',
    });
    const payload = parseJson(response.body);

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      method: 'ping',
      result: 'pong',
      runId: expect.any(String),
      traceId: expect.any(String),
      runtimeTrace: {
        status: 'success',
        totalSpans: 1,
      },
    });
    expect(payload.runtimeTrace.spans).toHaveLength(1);
  });

  it('responds to browser preflight requests for direct run', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', () => ({
          ping: () => 'pong',
        })),
      ],
    );
    await httpServeAdapter.serve();

    const response = await request(`http://127.0.0.1:${port}/direct-run`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://viewer.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toBe('*');
  });

  it('accepts JSON content types with charset parameters', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', () => ({
          ping: () => 'pong',
        })),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(
      `http://127.0.0.1:${port}/direct-run`,
      {
        module: 'AppModule',
        provider: 'PingProvider',
        method: 'ping',
      },
      {
        'content-type': 'application/json; charset=utf-8',
      },
    );
    const payload = parseJson(response.body);

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      method: 'ping',
      result: 'pong',
      runId: expect.any(String),
      traceId: expect.any(String),
      runtimeTrace: {
        status: 'success',
        totalSpans: 1,
      },
    });
    expect(payload.runtimeTrace.spans).toHaveLength(1);
  });

  it('passes JSON args to provider methods', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', () => ({
          ping: (value: { message: string }) => `pong:${value.message}`,
        })),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'PingProvider',
      method: 'ping',
      args: {
        message: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      method: 'ping',
      result: 'pong:hello',
      runId: expect.any(String),
      traceId: expect.any(String),
    });
  });

  it('passes JSON arrays to multi-argument provider methods', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', () => ({
          add: (left: number, right: number) => left + right,
        })),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'MathProvider',
      method: 'add',
      args: [2, 3],
    });

    expect(response.statusCode).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      method: 'add',
      result: 5,
      runId: expect.any(String),
      traceId: expect.any(String),
    });
  });

  it('returns runtime trace metadata for provider errors', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', () => ({
          fail: () => {
            throw new Error('boom');
          },
        })),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'FailProvider',
      method: 'fail',
    });

    expect(response.statusCode).toBe(500);
    expect(parseJson(response.body)).toMatchObject({
      ok: false,
      method: 'fail',
      error: 'boom',
      runId: expect.any(String),
      traceId: expect.any(String),
      runtimeTrace: {
        status: 'error',
        totalSpans: 1,
        failedSpanId: expect.any(String),
        spans: [
          expect.objectContaining({
            name: 'FailProvider.fail',
            status: 'error',
            errorMessage: 'boom',
          }),
        ],
      },
    });
  });

  it('keeps completed traces available in recorder storage after direct run finishes', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);
    const runtimeTraceRecorder = moduleRef.get(RuntimeTraceRecorder);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', () => ({
          ping: async () => {
            await Promise.resolve();
            return { ok: true };
          },
        })),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'PingProvider',
      method: 'ping',
    });
    const payload = parseJson(response.body) as DirectRunResponseBody & {
      traceId: string;
      runtimeTrace: {
        traceId: string;
        runId: string;
        totalSpans: number;
        spans: unknown[];
        status: string;
      };
    };

    expect(response.statusCode).toBe(200);
    expect(payload.runtimeTrace.traceId).toBe(payload.traceId);
    expect(
      runtimeTraceRecorder.getCompletedTrace(payload.traceId),
    ).toMatchObject({
      traceId: payload.traceId,
      runId: payload.runtimeTrace.runId,
      totalSpans: 1,
    });
  });
});

type HttpResponse = {
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function post(
  url: string,
  payload: unknown,
  headers: http.OutgoingHttpHeaders = {},
): Promise<HttpResponse> {
  const body = JSON.stringify(payload);

  return request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...headers,
    },
    body,
  });
}

function request(
  url: string,
  options: http.RequestOptions & { body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(target, options, (res) => {
      let responseBody = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody,
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
