import http from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';

import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';
import type { DirectRunTargetType } from '../types/direct-run.type';

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

function provider<Methods extends Record<string, (...args: never[]) => unknown>>(
  methods: Methods,
) {
  class TestProvider {}

  Object.assign(TestProvider.prototype, methods);
  return new TestProvider();
}

function controller<
  Methods extends Record<string, (...args: never[]) => unknown>,
>(methods: Methods) {
  class TestController {}

  Object.assign(TestController.prototype, methods);
  return new TestController();
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
        adapter.createRoute('/direct-run', (_target, moduleName, providerName) => {
          if (moduleName === 'AppModule' && providerName === 'PingProvider') {
            return provider({
              ping: () => 'pong',
            });
          }

          return undefined;
        }, () => new Set(['ping'])),
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
    expect(payload.runtimeTrace?.spans).toHaveLength(1);
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
        adapter.createRoute('/direct-run', () => provider({
          ping: () => 'pong',
        }), () => new Set(['ping'])),
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
        adapter.createRoute('/direct-run', () => provider({
          ping: () => 'pong',
        }), () => new Set(['ping'])),
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
    expect(payload.runtimeTrace?.spans).toHaveLength(1);
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
        adapter.createRoute('/direct-run', () => provider({
          ping: (value: { message: string }) => `pong:${value.message}`,
        }), () => new Set(['ping'])),
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
        adapter.createRoute('/direct-run', () => provider({
          add: (left: number, right: number) => left + right,
        }), () => new Set(['add'])),
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
        adapter.createRoute('/direct-run', () => provider({
          fail: () => {
            throw new Error('boom');
          },
        }), () => new Set(['fail'])),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'FailProvider',
      method: 'fail',
    });

    expect(response.statusCode).toBe(200);
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
            result: {
              name: 'Error',
              message: 'boom',
            },
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
        adapter.createRoute('/direct-run', () => provider({
          ping: async () => {
            await Promise.resolve();
            return { ok: true };
          },
        }), () => new Set(['ping'])),
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
        spans: Array<{
          args?: unknown;
          result?: unknown;
          metadata?: Record<string, unknown>;
        }>;
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
    expect(payload.runtimeTrace.spans[0]).toMatchObject({
      args: [],
      result: { ok: true },
    });
    expect(payload.runtimeTrace.spans[0]?.metadata).toBeUndefined();
  });

  it('rejects non-allowlisted and instance-shadowed methods', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);
    const instance = provider({ ping: () => 'pong' }) as unknown as {
      ping: () => string;
    };
    instance.ping = () => 'secret';

    httpServeAdapter.register(
      { host: '127.0.0.1', port },
      [
        adapter.createRoute(
          '/direct-run',
          () => instance,
          () => new Set(['ping']),
          { allowUnsafeMethods: false },
        ),
      ],
    );
    await httpServeAdapter.serve();

    for (const method of ['toString', 'ping']) {
      const response = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        provider: 'PingProvider',
        method,
      });

      expect(response.statusCode).toBe(400);
      expect(parseJson(response.body)).toMatchObject({ ok: false });
      expect(response.body).not.toContain('secret');
    }
  });

  it('invokes methods not advertised by allowedMethodsLookup by default (permissive mode)', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      { host: '127.0.0.1', port },
      [
        adapter.createRoute(
          '/direct-run',
          () => provider({ secretMethod: () => 'internal' }),
          () => new Set(['ping']),
        ),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'PingProvider',
      method: 'secretMethod',
    });

    expect(response.statusCode).toBe(200);
    expect(parseJson(response.body)).toMatchObject({
      ok: true,
      method: 'secretMethod',
      result: 'internal',
    });
  });

  it('limits JSON bodies by encoded bytes and decodes split UTF-8 safely', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      { host: '127.0.0.1', port },
      [
        adapter.createRoute(
          '/direct-run',
          () => provider({ ping: (value: string) => value }),
          () => new Set(['ping']),
          { maxBodySizeBytes: 1024 * 1024 },
        ),
      ],
    );
    await httpServeAdapter.serve();

    const splitResponse = await requestChunks(
      `http://127.0.0.1:${port}/direct-run`,
      [
        Buffer.from('{"module":"AppModule","provider":"PingProvider","method":"ping","args":"caf'),
        Buffer.from([0xc3]),
        Buffer.from([0xa9]),
        Buffer.from('"}'),
      ],
    );
    expect(splitResponse.statusCode).toBe(200);
    expect(parseJson(splitResponse.body)).toMatchObject({ result: 'café' });

    const oversizedResponse = await requestChunks(
      `http://127.0.0.1:${port}/direct-run`,
      [Buffer.alloc(1024 * 1024 + 1, 0x61)],
    );
    expect(oversizedResponse.statusCode).toBe(413);
    expect(parseJson(oversizedResponse.body)).toEqual({
      ok: false,
      error: 'Request body is too large.',
    });
  });

  describe('controller targets', () => {
    it('executes a controller method when the request declares target: controller', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            (target, moduleName, name) => {
              if (
                target === 'controller' &&
                moduleName === 'AppModule' &&
                name === 'PingController'
              ) {
                return controller({ ping: () => 'pong' });
              }

              return undefined;
            },
            () => new Set(['ping']),
          ),
        ],
      );
      await httpServeAdapter.serve();

      const response = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        target: 'controller',
        controller: 'PingController',
        method: 'ping',
      });

      expect(response.statusCode).toBe(200);
      expect(parseJson(response.body)).toMatchObject({
        ok: true,
        method: 'ping',
        result: 'pong',
      });
    });

    it('never resolves a controller-targeted request against the provider instance map', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            (target, moduleName, name) => {
              if (target === 'provider' && name === 'SharedName') {
                return provider({ ping: () => 'from-provider' });
              }
              // No controller named "SharedName" is ever registered.
              return undefined;
            },
            () => new Set(['ping']),
          ),
        ],
      );
      await httpServeAdapter.serve();

      const asController = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        target: 'controller',
        controller: 'SharedName',
        method: 'ping',
      });

      expect(asController.statusCode).toBe(404);
      expect(parseJson(asController.body)).toMatchObject({
        ok: false,
        error: 'Controller AppModule:SharedName is unavailable.',
      });

      const asProvider = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        target: 'provider',
        provider: 'SharedName',
        method: 'ping',
      });

      expect(asProvider.statusCode).toBe(200);
      expect(parseJson(asProvider.body)).toMatchObject({
        ok: true,
        result: 'from-provider',
      });
    });

    it('never resolves a provider-targeted request, explicit or defaulted, against the controller instance map', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);
      const ping = jest.fn(() => 'from-controller');
      const instanceLookup = jest.fn(
        (target: DirectRunTargetType, moduleName: string, name: string) =>
          target === 'controller' &&
          moduleName === 'AppModule' &&
          name === 'PingController'
            ? controller({ ping: () => ping() })
            : undefined,
      );

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            instanceLookup,
            () => new Set(['ping']),
          ),
        ],
      );
      await httpServeAdapter.serve();

      // A controller by this name exists, but a request that says provider —
      // or says nothing, and so defaults to provider — never reaches it.
      for (const body of [
        {
          module: 'AppModule',
          target: 'provider',
          provider: 'PingController',
          method: 'ping',
        },
        { module: 'AppModule', provider: 'PingController', method: 'ping' },
      ]) {
        const response = await post(`http://127.0.0.1:${port}/direct-run`, body);

        expect(response.statusCode).toBe(404);
        expect(parseJson(response.body)).toEqual({
          ok: false,
          error: 'Provider AppModule:PingController is unavailable.',
        });
      }

      expect(instanceLookup.mock.calls).toEqual([
        ['provider', 'AppModule', 'PingController'],
        ['provider', 'AppModule', 'PingController'],
      ]);
      expect(ping).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised target value without looking anything up', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);
      const instanceLookup = jest.fn(() => provider({ ping: () => 'pong' }));

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            instanceLookup,
            () => new Set(['ping']),
          ),
        ],
      );
      await httpServeAdapter.serve();

      // Neither a near miss nor a non-string value is read as either target.
      for (const target of ['repository', 'Controller', null, 1]) {
        const response = await post(`http://127.0.0.1:${port}/direct-run`, {
          module: 'AppModule',
          target,
          provider: 'AnyName',
          controller: 'AnyName',
          method: 'ping',
        });

        expect(response.statusCode).toBe(400);
        expect(parseJson(response.body)).toEqual({
          ok: false,
          error: `Unknown direct run target ${JSON.stringify(target)}.`,
        });
      }

      expect(instanceLookup).not.toHaveBeenCalled();
    });

    it('rejects the constructor, a lifecycle hook the controller really declares, and inherited methods, even in the default permissive mode', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);
      const onModuleInit = jest.fn();
      const inherited = jest.fn(() => 'from-base-class');

      class BaseController {
        inherited(): string {
          return inherited();
        }
      }

      class PingController extends BaseController {
        ping(): string {
          return 'pong';
        }

        onModuleInit(): void {
          onModuleInit();
        }
      }

      const instance = new PingController();
      // Every name below is a real callable on the instance, so each
      // rejection is Direct Run refusing it, not failing to find it.
      expect(typeof instance.onModuleInit).toBe('function');
      expect(typeof instance.inherited).toBe('function');
      expect(typeof instance.toString).toBe('function');

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            () => instance,
            () => new Set(['ping']),
          ),
        ],
      );
      await httpServeAdapter.serve();

      for (const method of [
        'constructor',
        'onModuleInit',
        'inherited',
        'toString',
      ]) {
        const response = await post(`http://127.0.0.1:${port}/direct-run`, {
          module: 'AppModule',
          target: 'controller',
          controller: 'PingController',
          method,
        });

        expect(response.statusCode).toBe(400);
        expect(parseJson(response.body)).toEqual({
          ok: false,
          error: `Method ${method} is unavailable for direct run.`,
        });
      }

      expect(onModuleInit).not.toHaveBeenCalled();
      expect(inherited).not.toHaveBeenCalled();

      // The one real, eligible method is untouched by the rejections above.
      const okResponse = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        target: 'controller',
        controller: 'PingController',
        method: 'ping',
      });
      expect(okResponse.statusCode).toBe(200);
      expect(parseJson(okResponse.body)).toMatchObject({
        ok: true,
        result: 'pong',
      });
    });

    it('rejects a getter without running it, on the controller class or the instance, even in the default permissive mode', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);
      const getterRuns = jest.fn();
      const shadowed = jest.fn(() => 'shadowed-prototype-method');

      class PingController {
        // Returns a callable, so a lookup that read the property would get
        // something it could invoke — and would have run the getter to get it.
        get status(): () => string {
          getterRuns('prototype');
          return () => 'from-prototype-getter';
        }

        ping(): string {
          return 'pong';
        }

        shadowed(): string {
          return shadowed();
        }
      }

      const instance = new PingController();
      Object.defineProperty(instance, 'ownStatus', {
        get: () => {
          getterRuns('instance');
          return () => 'from-instance-getter';
        },
      });
      // An own property decides alone, callable or not: the prototype method
      // it shadows is not what a call on this instance would reach.
      Object.defineProperty(instance, 'shadowed', { value: 'not callable' });

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            () => instance,
            () => new Set(['ping']),
          ),
        ],
      );
      await httpServeAdapter.serve();

      for (const method of ['status', 'ownStatus', 'shadowed']) {
        const response = await post(`http://127.0.0.1:${port}/direct-run`, {
          module: 'AppModule',
          target: 'controller',
          controller: 'PingController',
          method,
        });

        expect(response.statusCode).toBe(400);
        expect(parseJson(response.body)).toEqual({
          ok: false,
          error: `Method ${method} is unavailable for direct run.`,
        });
      }

      expect(getterRuns).not.toHaveBeenCalled();
      expect(shadowed).not.toHaveBeenCalled();
    });

    it('consults only the controller allowlist in strict mode, and rejects a method it does not list', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);
      const isPingController = (
        target: DirectRunTargetType,
        moduleName: string,
        name: string,
      ) =>
        target === 'controller' &&
        moduleName === 'AppModule' &&
        name === 'PingController';
      const instanceLookup = jest.fn(
        (target: DirectRunTargetType, moduleName: string, name: string) =>
          isPingController(target, moduleName, name)
            ? controller({ ping: () => 'pong', secret: () => 'nope' })
            : undefined,
      );
      // Answers only for the controller: asked under any other target, it
      // would list nothing and `ping` would be refused too.
      const allowedMethodsLookup = jest.fn(
        (target: DirectRunTargetType, moduleName: string, name: string) =>
          isPingController(target, moduleName, name)
            ? new Set(['ping'])
            : undefined,
      );

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            instanceLookup,
            allowedMethodsLookup,
            { allowUnsafeMethods: false },
          ),
        ],
      );
      await httpServeAdapter.serve();

      const allowed = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        target: 'controller',
        controller: 'PingController',
        method: 'ping',
      });
      expect(allowed.statusCode).toBe(200);
      expect(parseJson(allowed.body)).toMatchObject({
        ok: true,
        result: 'pong',
      });

      const notAllowed = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        target: 'controller',
        controller: 'PingController',
        method: 'secret',
      });
      expect(notAllowed.statusCode).toBe(400);
      expect(notAllowed.body).not.toContain('nope');

      const controllerLookups = [
        ['controller', 'AppModule', 'PingController'],
        ['controller', 'AppModule', 'PingController'],
      ];
      expect(instanceLookup.mock.calls).toEqual(controllerLookups);
      expect(allowedMethodsLookup.mock.calls).toEqual(controllerLookups);
    });

    it('requires the controller field when target is controller, and does not fall back to provider', async () => {
      const port = await availablePort();
      const httpServeAdapter = moduleRef.get(HttpServeAdapter);
      const instanceLookup = jest.fn(() =>
        provider({ ping: () => 'from-provider' }),
      );

      httpServeAdapter.register(
        { host: '127.0.0.1', port },
        [
          adapter.createRoute(
            '/direct-run',
            instanceLookup,
            () => new Set(['ping']),
          ),
        ],
      );
      await httpServeAdapter.serve();

      const response = await post(`http://127.0.0.1:${port}/direct-run`, {
        module: 'AppModule',
        target: 'controller',
        provider: 'PingProvider',
        method: 'ping',
      });

      expect(response.statusCode).toBe(400);
      expect(parseJson(response.body)).toEqual({
        ok: false,
        error: 'module, controller, and method are required.',
      });
      expect(instanceLookup).not.toHaveBeenCalled();
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

function requestChunks(url: string, chunks: Buffer[]): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      target,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: responseBody,
          }),
        );
      },
    );

    req.on('error', reject);
    for (const chunk of chunks) {
      req.write(chunk);
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
