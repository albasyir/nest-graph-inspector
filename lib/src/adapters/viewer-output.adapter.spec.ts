import { Buffer } from 'node:buffer';
import http from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { ProxyAdapter } from './proxy.adapter';
import { ViewerOutputAdapter } from './viewer-output.adapter';
import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';
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
  let proxyAdapter: { serve: jest.Mock; close: jest.Mock };

  beforeEach(async () => {
    httpOutputAdapter = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector HTTP endpoint is installed',
      }),
      normalizePath: jest.fn((path: string) =>
        path.startsWith('/') ? path : `/${path}`,
      ),
    };
    proxyAdapter = {
      serve: jest.fn(),
      close: jest.fn(),
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
        {
          provide: ProxyAdapter,
          useValue: proxyAdapter,
        },
      ],
    }).compile();

    adapter = moduleRef.get(ViewerOutputAdapter);
    httpServeAdapter = moduleRef.get(HttpServeAdapter);
  });

  afterEach(() => moduleRef.close());

  it('normalizes the graph endpoint before installing and encoding it', async () => {
    const result = await adapter.execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:8889',
      path: 'graph',
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
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
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
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
    const quiet = await Test.createTestingModule({
      providers: [
        ViewerOutputAdapter,
        HttpServeAdapter,
        DirectRunOutputAdapter,
        RuntimeTraceRecorder,
        AccessTokenService,
        { provide: HttpOutputAdapter, useValue: httpOutputAdapter },
        { provide: ProxyAdapter, useValue: proxyAdapter },
        {
          provide: MODULE_OPTIONS_TOKEN,
          useValue: { accessToken: { logToken: false } },
        },
      ],
    }).compile();

    const result = await quiet.get(ViewerOutputAdapter).execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:8889',
      path: 'graph',
      ollama: { origin: 'http://localhost:11434', path: '/ollama' },
    });
    const endpoint = decodeViewerEndpoint(result.message);

    expect(endpoint.searchParams.get(ACCESS_TOKEN_QUERY_PARAM)).toBeNull();
    expect(result.message).not.toContain(
      quiet.get(AccessTokenService).current(),
    );
    expect(result.message).toContain('accessToken.logToken is off');

    await quiet.close();
  });

  it('registers the Ollama proxy on the viewer HTTP origin', async () => {
    await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port: 3998,
      path: 'graph',
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
    });

    const httpOutputConfig = httpOutputAdapter.execute.mock.calls[0][1];

    expect(proxyAdapter.serve).toHaveBeenCalledWith(
      {
        from: 'http://127.0.0.1:3998',
        to: 'http://localhost:11434',
        cors: {
          origins: [expect.any(RegExp)],
        },
      },
      {
        httpAdapter: httpOutputConfig.httpAdapter,
        pathPrefix: '/ollama',
        authorize: expect.any(Function),
      },
    );
  });

  it('allows every browser origin through the proxy allow-list', async () => {
    await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port: 3998,
      path: 'graph',
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
    });

    const cors = proxyAdapter.serve.mock.calls[0][0].cors;
    const [allOrigins] = cors.origins;

    expect(cors.origins).toHaveLength(1);
    expect(allOrigins).toBeInstanceOf(RegExp);
    expect((allOrigins as RegExp).test('http://localhost:5173')).toBe(true);
    expect((allOrigins as RegExp).test('https://viewer.example')).toBe(true);
    expect((allOrigins as RegExp).test('null')).toBe(true);
  });

  it('passes native HTTP host and port options to the HTTP output adapter', async () => {
    const result = await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port: 3998,
      path: 'graph',
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
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

  it('registers the configured Ollama proxy', async () => {
    await adapter.execute({} as never, {
      type: 'viewer',
      path: 'graph',
      ollama: {
        origin: 'http://localhost:11435',
        path: '/llm',
      },
    });

    expect(proxyAdapter.serve).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'http://0.0.0.0:53371',
        to: 'http://localhost:11435',
      }),
      expect.objectContaining({
        httpAdapter: httpServeAdapter,
        pathPrefix: '/llm',
      }),
    );
  });

  it('uses configured origin for the default Ollama proxy origin', async () => {
    await adapter.execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:53371',
      path: 'graph',
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
    });

    expect(proxyAdapter.serve).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'http://localhost:53371',
        to: 'http://localhost:11434',
      }),
      expect.objectContaining({
        httpAdapter: httpServeAdapter,
        pathPrefix: '/ollama',
      }),
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
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
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

  it('refuses to invoke a provider method without a valid token', async () => {
    const port = await availablePort();
    const ping = jest.fn().mockReturnValue('pong');

    await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port,
      path: 'graph',
      ollama: { origin: 'http://localhost:11434', path: '/ollama' },
      directRun: {
        path: '/direct-run',
        instanceLookup: () => ({ ping }),
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
