import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';
import { FileOutputDriver } from './drivers/file-output.driver';
import { HttpOutputDriver } from './drivers/http-output.driver';
import { JsonOutputDriver } from './drivers/json-output.driver';
import { ViewerOutputDriver } from './drivers/viewer-output.driver';

describe(NestGraphInspectorSetup.name, () => {
  class AppModule {}

  let moduleRef: TestingModule;
  let service: NestGraphInspectorSetup;
  let jsonOutputDriver: { execute: jest.Mock };

  beforeEach(async () => {
    jsonOutputDriver = {
      execute: jest
        .fn()
        .mockResolvedValue({ message: 'Graph inspector JSON output installed' }),
    };

    const appModuleRef = {
      metatype: AppModule,
      imports: new Map(),
      exports: new Map(),
      providers: new Map(),
      controllers: new Map(),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        NestGraphInspectorSetup,
        {
          provide: MODULE_OPTIONS_TOKEN,
          useValue: {
            rootModule: AppModule,
            outputs: [{ type: 'json', path: 'graph.json' }],
          },
        },
        {
          provide: ModulesContainer,
          useValue: new Map([[AppModule.name, appModuleRef]]),
        },
        {
          provide: HttpOutputDriver,
          useValue: { execute: jest.fn() },
        },
        {
          provide: FileOutputDriver,
          useValue: { execute: jest.fn() },
        },
        {
          provide: JsonOutputDriver,
          useValue: jsonOutputDriver,
        },
        {
          provide: ViewerOutputDriver,
          useValue: { execute: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get<NestGraphInspectorSetup>(NestGraphInspectorSetup);
  });

  afterEach(() => moduleRef.close());

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should log the message returned by the output adapter', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    service.onModuleInit();
    await Promise.resolve();

    expect(jsonOutputDriver.execute).toHaveBeenCalledWith(
      {
        version: '1',
        root: AppModule.name,
        modules: {
          [AppModule.name]: {
            imports: [],
            exports: [],
            providers: [],
            controllers: [],
          },
        },
      },
      { type: 'json', path: 'graph.json' },
    );
    expect(debugSpy).toHaveBeenCalledWith(
      'Graph inspector JSON output installed',
    );
  });
});
