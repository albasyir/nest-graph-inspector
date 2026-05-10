import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';

import { HttpOutputDriver } from './http-output.driver';
import type { GraphOutput } from '../types/graph-output.type';
import { FileOutputDriver } from './file-output.driver';

describe(HttpOutputDriver.name, () => {
  let moduleRef: TestingModule;
  let driver: HttpOutputDriver;
  let httpAdapter: { get: jest.Mock; reply: jest.Mock };
  let fileOutputDriver: { buildMarkdownText: jest.Mock };

  beforeEach(async () => {
    httpAdapter = {
      get: jest.fn(),
      reply: jest.fn(),
    };
    fileOutputDriver = {
      buildMarkdownText: jest.fn().mockReturnValue('# NestJS Dependency Graph'),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        HttpOutputDriver,
        {
          provide: HttpAdapterHost,
          useValue: { httpAdapter },
        },
        {
          provide: FileOutputDriver,
          useValue: fileOutputDriver,
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
    expect(httpAdapter.get).toHaveBeenCalledWith(
      '/graph/output.json',
      expect.any(Function),
    );
    expect(httpAdapter.get).toHaveBeenCalledWith(
      '/graph/output.md',
      expect.any(Function),
    );
    expect(config.path).toBe('graph');
    expect(result).toEqual({
      message:
        'Graph inspector HTTP endpoints are installed at /graph, /graph/output.json, and /graph/output.md',
    });
  });

  it('uses the default endpoint when no path is configured', () => {
    expect(driver.normalizePath()).toBe('/__nest-graph-inspector');
  });

  it('serves raw JSON and markdown output under the configured path', async () => {
    const graphOutput: GraphOutput = {
      version: '1',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [],
          controllers: [],
        },
      },
    };
    const res = {
      setHeader: jest.fn(),
    };

    await driver.execute(graphOutput, { type: 'http', path: '/graph' });

    const jsonHandler = httpAdapter.get.mock.calls.find(
      ([route]) => route === '/graph/output.json',
    )?.[1] as ((req: unknown, res: typeof res) => void) | undefined;
    const markdownHandler = httpAdapter.get.mock.calls.find(
      ([route]) => route === '/graph/output.md',
    )?.[1] as ((req: unknown, res: typeof res) => void) | undefined;

    if (!jsonHandler) {
      throw new Error('Expected /graph/output.json handler to be registered');
    }
    jsonHandler(undefined, res);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      '*',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/json; charset=utf-8',
    );
    expect(httpAdapter.reply).toHaveBeenCalledWith(res, graphOutput, 200);

    if (!markdownHandler) {
      throw new Error('Expected /graph/output.md handler to be registered');
    }
    markdownHandler(undefined, res);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/markdown; charset=utf-8',
    );
    expect(fileOutputDriver.buildMarkdownText).toHaveBeenCalledWith(
      graphOutput,
    );
    expect(httpAdapter.reply).toHaveBeenCalledWith(
      res,
      '# NestJS Dependency Graph',
      200,
    );
  });
});
