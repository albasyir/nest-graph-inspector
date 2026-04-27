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
  let options: {
    rootModule: typeof AppModule;
    outputs: Array<
      | { type: 'json'; path: string }
      | { type: 'markdown'; path: string }
      | { type: 'http'; path: string }
      | { type: 'viewer'; path: string }
    >;
  };
  let fileOutputDriver: { execute: jest.Mock };
  let httpOutputDriver: { execute: jest.Mock };
  let jsonOutputDriver: { execute: jest.Mock };
  let viewerOutputDriver: { execute: jest.Mock };

  beforeEach(async () => {
    options = {
      rootModule: AppModule,
      outputs: [{ type: 'json', path: 'graph.json' }],
    };
    fileOutputDriver = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector markdown output installed',
      }),
    };
    httpOutputDriver = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector HTTP output installed',
      }),
    };
    jsonOutputDriver = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector JSON output installed',
      }),
    };
    viewerOutputDriver = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector viewer output installed',
      }),
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
          useValue: options,
        },
        {
          provide: ModulesContainer,
          useValue: new Map([[AppModule.name, appModuleRef]]),
        },
        {
          provide: HttpOutputDriver,
          useValue: httpOutputDriver,
        },
        {
          provide: FileOutputDriver,
          useValue: fileOutputDriver,
        },
        {
          provide: JsonOutputDriver,
          useValue: jsonOutputDriver,
        },
        {
          provide: ViewerOutputDriver,
          useValue: viewerOutputDriver,
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

    await service.onModuleInit();

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

  it('should wait until every configured output adapter has completed', async () => {
    let resolveJsonOutput: (value: { message: string }) => void;
    let resolveMarkdownOutput: (value: { message: string }) => void;
    const jsonOutputCompleted = new Promise<{ message: string }>((resolve) => {
      resolveJsonOutput = resolve;
    });
    const markdownOutputCompleted = new Promise<{ message: string }>(
      (resolve) => {
        resolveMarkdownOutput = resolve;
      },
    );
    let onModuleInitCompleted = false;

    options.outputs = [
      { type: 'json', path: 'graph.json' },
      { type: 'markdown', path: 'graph.md' },
    ];
    jsonOutputDriver.execute.mockReturnValue(jsonOutputCompleted);
    fileOutputDriver.execute.mockReturnValue(markdownOutputCompleted);

    const onModuleInitPromise = service.onModuleInit().then(() => {
      onModuleInitCompleted = true;
    });
    await Promise.resolve();

    expect(jsonOutputDriver.execute).toHaveBeenCalled();
    expect(fileOutputDriver.execute).toHaveBeenCalled();
    expect(onModuleInitCompleted).toBe(false);

    resolveJsonOutput!({ message: 'JSON done' });
    await Promise.resolve();

    expect(onModuleInitCompleted).toBe(false);

    resolveMarkdownOutput!({ message: 'Markdown done' });
    await onModuleInitPromise;

    expect(onModuleInitCompleted).toBe(true);
  });
});
