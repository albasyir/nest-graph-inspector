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
import { RuntimeTraceRecorder } from './runtime-trace.recorder';
import type { GraphOutput } from './types/graph-output.type';
import type { ModuleMap } from './types/module-map.type';

type SetupWithPrivateMethods = NestGraphInspectorSetup & {
  enrichModuleMap(moduleMap: ModuleMap): GraphOutput;
};

/**
 * Provides documented app behavior.
 */
class DocumentedProvider {}

/**
 * Wires documented app dependencies.
 */
class DocumentedAppModule {}

describe(NestGraphInspectorSetup.name, () => {
  class TestRootModule {}

  let moduleRef: TestingModule;
  let service: NestGraphInspectorSetup;
  let options: NestGraphInspectorModuleOptions & {
    rootModule: typeof TestRootModule;
    outputs: NonNullable<NestGraphInspectorModuleOptions['outputs']>;
  };
  let appModuleRef: {
    metatype: typeof TestRootModule;
    imports: Map<string, unknown>;
    exports: Map<string, unknown>;
    providers: Map<string, unknown>;
    controllers: Map<string, unknown>;
  };
  let fileOutputAdapter: { execute: jest.Mock };
  let httpOutputAdapter: { execute: jest.Mock };
  let jsonOutputAdapter: { execute: jest.Mock };
  let viewerOutputAdapter: { execute: jest.Mock };
  let runtimeTraceRecorder: RuntimeTraceRecorder;

  beforeEach(async () => {
    options = {
      rootModule: TestRootModule,
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
    runtimeTraceRecorder = new RuntimeTraceRecorder();

    appModuleRef = {
      metatype: TestRootModule,
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
          useValue: new Map([[TestRootModule.name, appModuleRef]]),
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
        {
          provide: RuntimeTraceRecorder,
          useValue: runtimeTraceRecorder,
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
        version: '3',
        root: TestRootModule.name,
        modules: {
          [TestRootModule.name]: {
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
    ]);
    expect(graphOutput.cycles.providers).toEqual([
      {
        id: 2,
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
    ]);
  });

  it('should apply default viewer Ollama proxy options', async () => {
    options.outputs = [{ type: 'viewer', host: '127.0.0.1', port: 3998 }];

    await service.onModuleInit();

    expect(viewerOutputAdapter.execute).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: 'viewer',
        host: '127.0.0.1',
        port: 3998,
        ollama: {
          origin: 'http://localhost:11434',
          path: '/ollama',
        },
        directRun: expect.objectContaining({
          path: '/direct-run',
          instanceLookup: expect.any(Function),
        }),
      }),
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
      expect.objectContaining({
        type: 'viewer',
        host: '127.0.0.1',
        port: 3998,
        ollama: {
          origin: 'http://localhost:11435',
          path: '/llm',
        },
        directRun: expect.objectContaining({
          path: '/direct-run',
          instanceLookup: expect.any(Function),
        }),
      }),
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

    const moduleMap = service.buildModuleMap(TestRootModule);

    expect(moduleMap.modules[TestRootModule.name].providers).toEqual([
      {
        name: Reflector.name,
        dependencies: [],
      },
    ]);
  });

  it('should include class JSDoc on documented providers', () => {
    appModuleRef.providers.set(DocumentedProvider.name, {
      metatype: DocumentedProvider,
    });

    const moduleMap = service.buildModuleMap(TestRootModule);

    expect(moduleMap.modules[TestRootModule.name].providers).toEqual([
      {
        name: DocumentedProvider.name,
        jsdoc: 'Provides documented app behavior.',
        dependencies: [],
      },
    ]);
  });

  it('should include direct-run metadata for provider methods', () => {
    class RunnableProvider {
      ping() {
        return 'pong';
      }

      withArgs(value: string) {
        return value;
      }
    }

    appModuleRef.providers.set(RunnableProvider.name, {
      metatype: RunnableProvider,
      instance: new RunnableProvider(),
      token: RunnableProvider,
    });

    const graphOutput = (
      service as unknown as SetupWithPrivateMethods
    ).enrichModuleMap(service.buildModuleMap(TestRootModule));

    expect(graphOutput.modules[TestRootModule.name].providers).toEqual([
      {
        name: RunnableProvider.name,
        dependencies: [],
        directRun: {
          methods: [
            { name: 'ping', parameterTypes: '[]' },
            {
              name: 'withArgs',
              parameterTypes: '[value: string]',
            },
          ],
        },
      },
    ]);
  });

  it('should instrument nested provider calls for runtime traces from setup', async () => {
    class ProductService {
      getAllProducts() {
        return [];
      }
    }

    class OrderService {
      constructor(private readonly productService: ProductService) {}

      getAllOrders() {
        this.productService.getAllProducts();
        return [];
      }
    }

    const productService = new ProductService();
    const orderService = new OrderService(productService);
    appModuleRef.providers.set(ProductService.name, {
      metatype: ProductService,
      instance: productService,
      token: ProductService,
    });
    appModuleRef.providers.set(OrderService.name, {
      metatype: OrderService,
      instance: orderService,
      token: OrderService,
    });

    service.buildModuleMap(TestRootModule);

    const handle = runtimeTraceRecorder.start({
      moduleName: TestRootModule.name,
      providerName: OrderService.name,
      methodName: 'getAllOrders',
      args: [],
    });
    const result = await runtimeTraceRecorder.runWithContext(handle, async () =>
      orderService.getAllOrders(),
    );
    const trace = await runtimeTraceRecorder.finishSuccess(handle, result);

    expect(trace).toMatchObject({
      status: 'success',
      totalSpans: 2,
      spans: [
        expect.objectContaining({
          name: 'OrderService.getAllOrders',
          methodName: 'getAllOrders',
        }),
        expect.objectContaining({
          name: 'ProductService.getAllProducts',
          methodName: 'getAllProducts',
          parentSpanId: expect.any(String),
        }),
      ],
    });
  });

  it('should mark not-awaited promise spans with measured duration', async () => {
    class ProductService {
      async getAllProducts() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [];
      }
    }

    class OrderRepository {
      updateStatus() {
        return { id: 1 };
      }
    }

    class OrderService {
      constructor(
        private readonly productService: ProductService,
        private readonly orderRepository: OrderRepository,
      ) {}

      async confirmOrder() {
        this.productService.getAllProducts();
        return this.orderRepository.updateStatus();
      }
    }

    const productService = new ProductService();
    const orderRepository = new OrderRepository();
    const orderService = new OrderService(productService, orderRepository);
    appModuleRef.providers.set(ProductService.name, {
      metatype: ProductService,
      instance: productService,
      token: ProductService,
    });
    appModuleRef.providers.set(OrderService.name, {
      metatype: OrderService,
      instance: orderService,
      token: OrderService,
    });
    appModuleRef.providers.set(OrderRepository.name, {
      metatype: OrderRepository,
      instance: orderRepository,
      token: OrderRepository,
    });

    service.buildModuleMap(TestRootModule);

    const handle = runtimeTraceRecorder.start({
      moduleName: TestRootModule.name,
      providerName: OrderService.name,
      methodName: 'confirmOrder',
      args: [],
    });
    const result = await runtimeTraceRecorder.runWithContext(handle, async () =>
      orderService.confirmOrder(),
    );
    const trace = await runtimeTraceRecorder.finishSuccess(handle, result);

    const productSpan = trace.spans.find(
      (span) => span.name === 'ProductService.getAllProducts',
    );
    const updateSpan = trace.spans.find(
      (span) => span.name === 'OrderRepository.updateStatus',
    );

    expect(productSpan).toMatchObject({
      status: 'success',
      metadata: expect.objectContaining({ awaited: false }),
    });
    expect(productSpan?.durationMs).toBeGreaterThanOrEqual(5);
    expect(updateSpan?.parentSpanId).toBe(trace.spans[0]?.spanId);
  });

  it('should include class JSDoc on documented modules', () => {
    const documentedModuleRef = {
      metatype: DocumentedAppModule,
      imports: new Map(),
      exports: new Map(),
      providers: new Map(),
      controllers: new Map(),
    };
    const customService = new NestGraphInspectorSetup(
      {
        ...options,
        rootModule: DocumentedAppModule,
      },
      new Map([[DocumentedAppModule.name, documentedModuleRef]]) as never,
      httpOutputAdapter as never,
      fileOutputAdapter as never,
      jsonOutputAdapter as never,
      viewerOutputAdapter as never,
      runtimeTraceRecorder,
    );

    const moduleMap = customService.buildModuleMap(DocumentedAppModule);

    expect(moduleMap.modules[DocumentedAppModule.name]).toMatchObject({
      jsdoc: 'Wires documented app dependencies.',
      imports: [],
      exports: [],
      providers: [],
      controllers: [],
    });
  });

  it('should keep building the module map when the consumer tsconfig is missing', () => {
    jest
      .spyOn(process, 'cwd')
      .mockReturnValue('/tmp/nest-graph-inspector-missing-tsconfig');
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const customService = new NestGraphInspectorSetup(
      options,
      new Map([[TestRootModule.name, appModuleRef]]) as never,
      httpOutputAdapter as never,
      fileOutputAdapter as never,
      jsonOutputAdapter as never,
      viewerOutputAdapter as never,
      runtimeTraceRecorder,
    );

    const moduleMap = customService.buildModuleMap(TestRootModule);

    expect(moduleMap.modules[TestRootModule.name].providers).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'Could not find tsconfig.json at /tmp/nest-graph-inspector-missing-tsconfig/tsconfig.json; JSDoc metadata will be skipped.',
    );
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
      rootModule: TestRootModule,
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
      new Map([[TestRootModule.name, appModuleRef]]) as never,
      httpOutputAdapter as never,
      fileOutputAdapter as never,
      jsonOutputAdapter as never,
      viewerOutputAdapter as never,
      runtimeTraceRecorder,
    );

    const moduleMap = customService.buildModuleMap(TestRootModule);

    expect(moduleMap.modules[TestRootModule.name].imports).toEqual([]);
    expect(moduleMap.modules[IgnoredModule.name]).toBeUndefined();
    expect(moduleMap.modules[TestRootModule.name].providers).toEqual([
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
