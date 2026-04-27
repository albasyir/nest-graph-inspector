import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';

import { HttpOutputDriver } from './http-output.driver';

describe(HttpOutputDriver.name, () => {
  let moduleRef: TestingModule;
  let driver: HttpOutputDriver;
  let httpAdapter: { get: jest.Mock; reply: jest.Mock };

  beforeEach(async () => {
    httpAdapter = {
      get: jest.fn(),
      reply: jest.fn(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        HttpOutputDriver,
        {
          provide: HttpAdapterHost,
          useValue: { httpAdapter },
        },
      ],
    }).compile();

    driver = moduleRef.get(HttpOutputDriver);
  });

  afterEach(() => moduleRef.close());

  it('normalizes configured paths without mutating config', async () => {
    const config = { type: 'http' as const, path: 'graph' };

    const result = await driver.execute({} as never, config);

    expect(httpAdapter.get).toHaveBeenCalledWith(
      '/graph',
      expect.any(Function),
    );
    expect(config.path).toBe('graph');
    expect(result).toEqual({
      message: 'Graph inspector HTTP endpoint is installed at /graph',
    });
  });

  it('uses the default endpoint when no path is configured', () => {
    expect(driver.normalizePath()).toBe('/__nest-graph-inspector');
  });
});
