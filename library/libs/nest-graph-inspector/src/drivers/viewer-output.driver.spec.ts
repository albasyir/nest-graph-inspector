import { Buffer } from 'node:buffer';
import { Test, TestingModule } from '@nestjs/testing';

import { HttpOutputDriver } from './http-output.driver';
import { ViewerOutputDriver } from './viewer-output.driver';

describe(ViewerOutputDriver.name, () => {
  let moduleRef: TestingModule;
  let driver: ViewerOutputDriver;
  let httpOutputDriver: { execute: jest.Mock; normalizePath: jest.Mock };

  beforeEach(async () => {
    httpOutputDriver = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector HTTP endpoint is installed',
      }),
      normalizePath: jest.fn((path: string) =>
        path.startsWith('/') ? path : `/${path}`,
      ),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        ViewerOutputDriver,
        {
          provide: HttpOutputDriver,
          useValue: httpOutputDriver,
        },
      ],
    }).compile();

    driver = moduleRef.get(ViewerOutputDriver);
  });

  afterEach(() => moduleRef.close());

  it('normalizes the graph endpoint before installing and encoding it', async () => {
    const result = await driver.execute({} as never, {
      type: 'viewer',
      origin: 'http://localhost:8889',
      path: 'graph',
    });
    const encodedEndpoint = Buffer.from('http://localhost:8889/graph').toString(
      'base64url',
    );

    expect(httpOutputDriver.execute).toHaveBeenCalledWith(
      {},
      { type: 'http', path: '/graph' },
    );
    expect(result.message).toContain(`/view/${encodedEndpoint}`);
  });
});
