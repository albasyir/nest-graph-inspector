import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';
import { FileOutputAdapter } from './adapters/file-output.adapter';
import { HttpOutputAdapter } from './adapters/http-output.adapter';
import { JsonOutputAdapter } from './adapters/json-output.adapter';
import { ViewerOutputAdapter } from './adapters/viewer-output.adapter';
import type { GraphOutput } from './types/graph-output.type';
import type { ModuleMap } from './types/module-map.type';

type SetupWithPrivateMethods = NestGraphInspectorSetup & {
  enrichModuleMap(moduleMap: ModuleMap): GraphOutput;
};

describe(NestGraphInspectorSetup.name, () => {
  class AppModule {}

  let moduleRef: TestingModule;
  let service: NestGraphInspectorSetup;
  let options: NestGraphInspectorModuleOptions & {
    rootModule: typeof AppModule;
    outputs: NonNullable<NestGraphInspectorModuleOptions['outputs']>;
  };
  let appModuleRef: {
    metatype: typeof AppModule;
    imports: Map<string, unknown>;
    exports: Map<string, unknown>;
    providers: Map<string, unknown>;
    controllers: Map<string, unknown>;
  };
  let fileOutputAdapter: { execute: jest.Mock };
  let httpOutputAdapter: { execute: jest.Mock };
  let jsonOutputAdapter: { execute: jest.Mock };
  let viewerOutputAdapter: { execute: jest.Mock };

  beforeEach(async () => {
    options = {
      rootModule: AppModule,
      outputs: [{ type: 'json', path: 'graph.json' }],
    };
    fileOutputAdapter = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector markdown output installed',
      }),
    };
    httpOutputAdapter = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector HTTP output installed',
      }),
    };
    jsonOutputAdapter = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector JSON output installed',
      }),
    };
    viewerOutputAdapter = {
      execute: jest.fn().mockResolvedValue({
        message: 'Graph inspector viewer output installed',
      }),
    };

    appModuleRef = {
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
          provide: HttpOutputAdapter,
          useValue: httpOutputAdapter,
        },
        {
          provide: FileOutputAdapter,
          useValue: fileOutputAdapter,
        },
        {
          provide: JsonOutputAdapter,
          useValue: jsonOutputAdapter,
        },
        {
          provide: ViewerOutputAdapter,
          useValue: viewerOutputAdapter,
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

    expect(jsonOutputAdapter.execute).toHaveBeenCalledWith(
      {
        version: '2',
        root: AppModule.name,
        modules: {
          [AppModule.name]: {
            imports: [],
            exports: [],
            providers: [],
            controllers: [],
          },
        },
        cycles: {
          modules: [],
          providers: [],
          controllers: [],
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
    jsonOutputAdapter.execute.mockReturnValue(jsonOutputCompleted);
    fileOutputAdapter.execute.mockReturnValue(markdownOutputCompleted);

    const onModuleInitPromise = service.onModuleInit().then(() => {
      onModuleInitCompleted = true;
    });
    await Promise.resolve();

    expect(jsonOutputAdapter.execute).toHaveBeenCalled();
    expect(fileOutputAdapter.execute).toHaveBeenCalled();
    expect(onModuleInitCompleted).toBe(false);

    resolveJsonOutput!({ message: 'JSON done' });
    await Promise.resolve();

    expect(onModuleInitCompleted).toBe(false);

    resolveMarkdownOutput!({ message: 'Markdown done' });
    await onModuleInitPromise;

    expect(onModuleInitCompleted).toBe(true);
  });

  it('should enrich graph output with module and provider cycles', () => {
    const graphOutput = (
      service as unknown as SetupWithPrivateMethods
    ).enrichModuleMap({
      version: '2',
      root: 'UserModule',
      modules: {
        UserModule: {
          imports: ['MobileModule'],
          exports: [],
          providers: [
            {
              name: 'UserService',
              dependencies: ['MobileModule:MobileService'],
            },
          ],
          controllers: [],
        },
        MobileModule: {
          imports: ['ProductModule'],
          exports: [],
          providers: [
            {
              name: 'MobileService',
              dependencies: ['ProductModule:ProductService'],
            },
          ],
          controllers: [],
        },
        ProductModule: {
          imports: ['UserModule'],
          exports: [],
          providers: [
            {
              name: 'ProductService',
              dependencies: ['UserModule:UserService'],
            },
          ],
          controllers: [],
        },
      },
    });

    expect(graphOutput.cycles.modules).toEqual([
      {
        id: 1,
        from: 'UserModule',
        to: 'MobileModule',
        type: 'indirect',
        path: ['UserModule', 'MobileModule', 'ProductModule', 'UserModule'],
      },
      {
        id: 2,
        from: 'MobileModule',
        to: 'ProductModule',
        type: 'indirect',
        path: ['MobileModule', 'ProductModule', 'UserModule', 'MobileModule'],
      },
      {
        id: 3,
        from: 'ProductModule',
        to: 'UserModule',
        type: 'indirect',
        path: ['ProductModule', 'UserModule', 'MobileModule', 'ProductModule'],
      },
    ]);
    expect(graphOutput.cycles.providers).toEqual([
      {
        id: 4,
        from: 'UserModule:UserService',
        to: 'MobileModule:MobileService',
        type: 'indirect',
        path: [
          {
            module: { name: 'UserModule' },
            provider: { name: 'UserService' },
          },
          {
            module: { name: 'MobileModule' },
            provider: { name: 'MobileService' },
          },
          {
            module: { name: 'ProductModule' },
            provider: { name: 'ProductService' },
          },
          {
            module: { name: 'UserModule' },
            provider: { name: 'UserService' },
          },
        ],
      },
      {
        id: 5,
        from: 'MobileModule:MobileService',
        to: 'ProductModule:ProductService',
        type: 'indirect',
        path: [
          {
            module: { name: 'MobileModule' },
            provider: { name: 'MobileService' },
          },
          {
            module: { name: 'ProductModule' },
            provider: { name: 'ProductService' },
          },
          {
            module: { name: 'UserModule' },
            provider: { name: 'UserService' },
          },
          {
            module: { name: 'MobileModule' },
            provider: { name: 'MobileService' },
          },
        ],
      },
      {
        id: 6,
        from: 'ProductModule:ProductService',
        to: 'UserModule:UserService',
        type: 'indirect',
        path: [
          {
            module: { name: 'ProductModule' },
            provider: { name: 'ProductService' },
          },
          {
            module: { name: 'UserModule' },
            provider: { name: 'UserService' },
          },
          {
            module: { name: 'MobileModule' },
            provider: { name: 'MobileService' },
          },
          {
            module: { name: 'ProductModule' },
            provider: { name: 'ProductService' },
          },
        ],
      },
    ]);
  });

  it('should apply default viewer Ollama proxy options', async () => {
    options.outputs = [{ type: 'viewer', host: '127.0.0.1', port: 3998 }];

    await service.onModuleInit();

    expect(viewerOutputAdapter.execute).toHaveBeenCalledWith(
      expect.any(Object),
      {
        type: 'viewer',
        host: '127.0.0.1',
        port: 3998,
        ollama: {
          origin: 'http://localhost:11434',
          path: '/ollama',
        },
      },
    );
  });

  it('should let viewer output override default Ollama proxy options', async () => {
    options.outputs = [
      {
        type: 'viewer',
        host: '127.0.0.1',
        port: 3998,
        ollama: {
          origin: 'http://localhost:11435',
          path: '/llm',
        },
      },
    ];

    await service.onModuleInit();

    expect(viewerOutputAdapter.execute).toHaveBeenCalledWith(
      expect.any(Object),
      {
        type: 'viewer',
        host: '127.0.0.1',
        port: 3998,
        ollama: {
          origin: 'http://localhost:11435',
          path: '/llm',
        },
      },
    );
  });

  it('should use the default inspector filtering options when none are configured', () => {
    class ModuleRef {}
    class ApplicationConfig {}
    class Reflector {}

    appModuleRef.providers.set(ModuleRef.name, { metatype: ModuleRef });
    appModuleRef.providers.set(ApplicationConfig.name, {
      metatype: ApplicationConfig,
    });
    appModuleRef.providers.set(Reflector.name, { metatype: Reflector });

    const moduleMap = service.buildModuleMap(AppModule);

    expect(moduleMap.modules[AppModule.name].providers).toEqual([
      {
        name: Reflector.name,
        dependencies: [],
      },
    ]);
  });

  it('should apply configured inspector filtering options', () => {
    class HiddenProvider {}
    class VisibleProvider {}
    class IgnoredModule {}
    class ConsumerProvider {}

    const ignoredModuleRef = {
      metatype: IgnoredModule,
      imports: new Map(),
      exports: new Map(),
      providers: new Map(),
      controllers: new Map(),
    };

    const customOptions: NestGraphInspectorModuleOptions = {
      rootModule: AppModule,
      outputs: [{ type: 'json', path: 'graph.json' }],
      ignoreProvider: [HiddenProvider.name],
      ignoreImport: [IgnoredModule.name],
      nestCoreModuleName: 'CustomCoreModule',
      nestCoreProviders: ['CUSTOM_CONTEXT'],
    };
    appModuleRef.imports.set(IgnoredModule.name, ignoredModuleRef);
    appModuleRef.providers.set(HiddenProvider.name, {
      metatype: HiddenProvider,
    });
    appModuleRef.providers.set(VisibleProvider.name, {
      metatype: VisibleProvider,
    });
    appModuleRef.providers.set(ConsumerProvider.name, {
      metatype: ConsumerProvider,
      inject: ['CUSTOM_CONTEXT'],
    });
    const customService = new NestGraphInspectorSetup(
      customOptions,
      new Map([[AppModule.name, appModuleRef]]) as never,
      httpOutputAdapter as never,
      fileOutputAdapter as never,
      jsonOutputAdapter as never,
      viewerOutputAdapter as never,
    );

    const moduleMap = customService.buildModuleMap(AppModule);

    expect(moduleMap.modules[AppModule.name].imports).toEqual([]);
    expect(moduleMap.modules[IgnoredModule.name]).toBeUndefined();
    expect(moduleMap.modules[AppModule.name].providers).toEqual([
      {
        name: VisibleProvider.name,
        dependencies: [],
      },
      {
        name: ConsumerProvider.name,
        dependencies: ['CustomCoreModule:CUSTOM_CONTEXT'],
      },
    ]);
    expect(moduleMap.modules.CustomCoreModule).toEqual({
      imports: [],
      exports: ['CUSTOM_CONTEXT'],
      providers: [
        {
          name: 'CUSTOM_CONTEXT',
          dependencies: [],
        },
      ],
      controllers: [],
    });
  });
});
