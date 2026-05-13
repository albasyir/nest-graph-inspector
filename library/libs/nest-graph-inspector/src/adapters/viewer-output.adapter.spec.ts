import { Buffer } from 'node:buffer';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import { ProxyAdapter } from './proxy.adapter';
import { ViewerOutputAdapter } from './viewer-output.adapter';

describe(ViewerOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: ViewerOutputAdapter;
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
  });

  afterEach(() => moduleRef.close());

  it('normalizes the graph endpoint before installing and encoding it', async () => {
    const result = await adapter.execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:8889',
      path: 'graph',
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
      },
    );
    expect(result.message).toContain(`/view/${encodedEndpoint}`);
  });

  it('starts the configured proxy for viewer output', async () => {
    const proxy = {
      from: 'localhost:4999',
      to: 'localhost:11435',
    };

    await adapter.execute({} as never, {
      type: 'viewer',
      path: 'graph',
      proxy,
    });

    expect(proxyAdapter.serve).toHaveBeenCalledWith(proxy);
  });

  it('passes native HTTP host and port options to the HTTP output adapter', async () => {
    const result = await adapter.execute({} as never, {
      type: 'viewer',
      host: '127.0.0.1',
      port: 3998,
      path: 'graph',
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
      },
    );
    expect(result.message).toContain(`/view/${encodedEndpoint}`);
  });

  it('skips the proxy when viewer proxy config is missing', async () => {
    await adapter.execute({} as never, {
      type: 'viewer',
      path: 'graph',
    });

    expect(proxyAdapter.serve).not.toHaveBeenCalled();
  });

  it('skips the proxy when viewer proxy config is disabled', async () => {
    await adapter.execute({} as never, {
      type: 'viewer',
      path: 'graph',
      proxy: false,
    });

    expect(proxyAdapter.serve).not.toHaveBeenCalled();
  });
});
