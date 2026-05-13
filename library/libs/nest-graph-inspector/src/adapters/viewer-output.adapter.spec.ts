import { Buffer } from 'node:buffer';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputAdapter } from './http-output.adapter';
import { ViewerOutputAdapter } from './viewer-output.adapter';

describe(ViewerOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: ViewerOutputAdapter;
  let httpOutputAdapter: { execute: jest.Mock; normalizePath: jest.Mock };

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
        {
          provide: HttpOutputAdapter,
          useValue: httpOutputAdapter,
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
      { type: 'http', path: '/graph' },
    );
    expect(result.message).toContain(`/view/${encodedEndpoint}`);
  });
});
