import { Buffer } from 'node:buffer';
import http from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { ProxyAdapter } from './proxy.adapter';
import { ViewerOutputAdapter } from './viewer-output.adapter';
import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';

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
    const encodedEndpoint = Buffer.from('http://localhost:8889/graph').toString(
      'base64url',
    );

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
    expect(result.message).toContain(`/view/${encodedEndpoint}`);
  });

  it('registers the default Ollama proxy on the viewer HTTP origin', async () => {
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
          origins: ['https://albasyir.github.io'],
        },
      },
      {
        httpAdapter: httpOutputConfig.httpAdapter,
        pathPrefix: '/ollama',
      },
    );
  });

  it('allows loopback frontend origins on arbitrary ports for a local viewer', async () => {
    Reflect.set(adapter, 'viewerBaseUrl', 'http://localhost:3000');

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

    expect(cors.origins[0]).toBe('http://localhost:3000');
    expect(cors.origins[1]).toBeInstanceOf(RegExp);
    expect(cors.origins[1].test('http://localhost:5173')).toBe(true);
    expect(cors.origins[1].test('https://127.0.0.1:8443')).toBe(true);
    expect(cors.origins[1].test('https://viewer.example')).toBe(false);
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
    const encodedEndpoint = Buffer.from('http://127.0.0.1:3998/graph').toString(
      'base64url',
    );

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
    expect(result.message).toContain(`/view/${encodedEndpoint}`);
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
});

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
