import { Buffer } from 'node:buffer';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { ProxyAdapter } from './proxy.adapter';
import { ViewerOutputAdapter } from './viewer-output.adapter';

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
        cors: false,
      },
      {
        httpAdapter: httpOutputConfig.httpAdapter,
        pathPrefix: '/ollama',
      },
    );
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
        from: 'http://localhost:53371',
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
});
