import { createServer } from "node:http";
import net from "node:net";
import { join } from "node:path";
import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  Type,
} from "@nestjs/common";
import { ModulesContainer, NestApplication, NestFactory } from "@nestjs/core";
import {
  DEFAULT_IGNORE_PATHS,
  NestGraphInspectorModule,
} from "../nest-graph-inspector.module";
import { AccessTokenService } from "../access-token.service";
import type { NestGraphInspectorIgnoreOptions } from "../nest-graph-inspector.type";
import type { GraphOutput } from "../types/graph-output.type";
import {
  exportGraph,
  GraphExportBoot,
  PreviewBootstrapError,
} from "./export-graph";
import { FixtureSettingsModule } from "./__fixtures__/settings.module";
import { FixtureDocumentsModule } from "./__fixtures__/documents.module";
import { FixtureAccountsModule } from "./__fixtures__/accounts.module";
import { fixtureCalls } from "./__fixtures__/fixture-calls";

/** Where `SourceMetadataService` finds the fixture's sources and tsconfig. */
const FIXTURES_DIR = join(__dirname, "__fixtures__");

const FIXTURE_IGNORE: NestGraphInspectorIgnoreOptions = {
  providers: ["FixtureMetricsService"],
  paths: [...DEFAULT_IGNORE_PATHS, "/admin"],
};

const nestCore = { NestFactory, ModulesContainer };

/** A root module importing the fixture's features and, optionally, the inspector. */
function createApplicationModule(
  ...imports: (DynamicModule | Type<unknown>)[]
): Type<unknown> {
  @Module({
    imports: [
      ...imports,
      FixtureSettingsModule,
      FixtureDocumentsModule,
      FixtureAccountsModule,
    ],
  })
  class FixtureApplicationModule {}

  return FixtureApplicationModule;
}

function inspectorOn(
  port: number,
  ignore: NestGraphInspectorIgnoreOptions = FIXTURE_IGNORE,
): DynamicModule {
  return NestGraphInspectorModule.forRoot({
    outputs: [{ type: "http", host: "127.0.0.1", port, path: "/graph" }],
    ignore,
  });
}

function exportWith(entryModule: Type<unknown>, boot: GraphExportBoot = "application") {
  return exportGraph({ nestCore, entryModule, boot, logger: false });
}

/**
 * Boots the application normally and reads the graph its inspector serves,
 * over HTTP, exactly as the viewer does.
 */
async function readServedGraph(
  entryModule: Type<unknown>,
  port: number,
): Promise<string> {
  const app = await NestFactory.create(entryModule, { logger: false });

  try {
    await app.init();
    const token = app.get(AccessTokenService, { strict: false }).current();
    const response = await fetch(`http://127.0.0.1:${port}/graph/output.json`, {
      headers: { "x-graph-inspector-token": token },
    });
    expect(response.status).toBe(200);

    return await response.text();
  } finally {
    await app.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function providerNames(graph: GraphOutput, moduleName: string): string[] {
  return graph.modules[moduleName].providers.map((provider) => provider.name);
}

function findProvider(graph: GraphOutput, moduleName: string, name: string) {
  const provider = graph.modules[moduleName].providers.find(
    (candidate) => candidate.name === name,
  );
  if (!provider) {
    throw new Error(`${moduleName} has no provider ${name}`);
  }

  return provider;
}

describe("exportGraph", () => {
  beforeEach(() => {
    jest.spyOn(process, "cwd").mockReturnValue(FIXTURES_DIR);
    fixtureCalls.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("builds the graph without constructing, calling, or listening on anything", async () => {
    const entryModule = createApplicationModule(inspectorOn(1));
    const listen = jest.spyOn(net.Server.prototype, "listen");
    const connect = jest.spyOn(net.Socket.prototype, "connect");
    const init = jest.spyOn(NestApplication.prototype, "init");
    const appListen = jest.spyOn(NestApplication.prototype, "listen");

    const { graph, optionsSource, warnings } = await exportWith(entryModule);

    // No constructor (provider, controller, module), no useFactory (the
    // "database connection"), no lifecycle hook, and no configure().
    expect(fixtureCalls).toEqual([]);
    // Neither the application nor the inspector it imports started a server
    // or opened a connection.
    expect(listen).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(appListen).not.toHaveBeenCalled();

    expect(optionsSource).toBe("application");
    expect(warnings).toEqual([]);
    expect(graph.version).toBe("3");
    expect(graph.root).toBe("FixtureApplicationModule");
    expect(Object.keys(graph.modules)).toEqual(
      expect.arrayContaining([
        "FixtureApplicationModule",
        "FixtureSettingsModule",
        "FixtureDocumentsModule",
        "FixtureAccountsModule",
        "FixtureStorageModule",
      ]),
    );
    expect(graph.modules).not.toHaveProperty("NestGraphInspectorModule");
    // The inspector's `ignore` applies: no metrics service, no /admin
    // controller. Nest's own ModuleRef and ApplicationConfig are not ignored
    // by default.
    expect(providerNames(graph, "FixtureDocumentsModule")).toEqual([
      "ModuleRef",
      "ApplicationConfig",
      "FixtureDocumentService",
      "FixtureAuditService",
    ]);
    expect(graph.modules.FixtureAccountsModule.controllers).toEqual([]);
    expect(providerNames(graph, "FixtureStorageModule")).toEqual(
      expect.arrayContaining([
        "FixtureStorageClient",
        "connectFixtureDatabase",
        "FixtureS3StorageGateway",
      ]),
    );

    const documentService = findProvider(
      graph,
      "FixtureDocumentsModule",
      "FixtureDocumentService",
    );
    expect(documentService.jsdoc).toBe(
      "Keeps documents, and tells the audit trail about every change.",
    );
    // Constructor and property injection, through a forwardRef and a global
    // module. A dependency is named as its provider is: a factory provider by
    // its factory, a value provider by its value's class — as in a running
    // inspector's graph.
    expect(documentService.dependencies).toEqual([
      {
        providedBy: { type: "module", name: "FixtureStorageModule" },
        token: "FixtureStorageClient",
      },
      {
        providedBy: { type: "module", name: "FixtureStorageModule" },
        token: "connectFixtureDatabase",
      },
      {
        providedBy: { type: "module", name: "FixtureDocumentsModule" },
        token: "FixtureAuditService",
      },
      {
        providedBy: { type: "module", name: "FixtureSettingsModule" },
        token: "Object",
      },
    ]);
    expect(documentService.directRun).toEqual({
      methods: [
        { name: "save", parameterTypes: "[name: string, content: string]" },
      ],
    });

    expect(graph.modules.FixtureDocumentsModule.controllers).toEqual([
      expect.objectContaining({
        name: "FixtureDocumentController",
        directRun: {
          methods: [
            {
              name: "create",
              parameterTypes: "[body: { name: string; content: string }]",
              http: { method: "POST", path: "/documents" },
            },
            {
              name: "find",
              parameterTypes: "[name: string]",
              http: { method: "GET", path: "/documents/:name" },
            },
          ],
        },
      }),
    ]);

    expect(graph.cycles.modules).toEqual([
      expect.objectContaining({
        from: "FixtureDocumentsModule",
        to: "FixtureAccountsModule",
        type: "direct",
      }),
    ]);
    expect(graph.cycles.providers).toEqual([
      expect.objectContaining({
        from: "FixtureDocumentsModule:FixtureDocumentService",
        to: "FixtureDocumentsModule:FixtureAuditService",
        type: "direct",
      }),
    ]);
  });

  it("exports the graph the running inspector serves at /output.json", async () => {
    const port = await freePort();
    const entryModule = createApplicationModule(inspectorOn(port));

    const served = JSON.parse(
      await readServedGraph(entryModule, port),
    ) as GraphOutput;
    // A normal boot runs the application; the export after it runs nothing.
    expect(fixtureCalls).toContain("connectFixtureDatabase");
    fixtureCalls.length = 0;
    const { graph } = await exportWith(entryModule);
    expect(fixtureCalls).toEqual([]);

    // In this application the graphs differ in one way, and for one reason:
    // a running inspector reads a provider's Direct Run methods off its
    // instance. A useFactory provider's
    // instance is whatever the factory returned, and a useExisting alias's is
    // the provider it aliases; preview mode calls no factory and resolves no
    // alias, so the export has no instance to read them from.
    const factoryProvider = findProvider(
      served,
      "FixtureStorageModule",
      "connectFixtureDatabase",
    );
    const aliasProvider = findProvider(
      served,
      "FixtureStorageModule",
      "FIXTURE_STORAGE_ALIAS",
    );
    expect(factoryProvider.directRun).toEqual({
      methods: [{ name: "query", parameterTypes: "[sql: string]" }],
    });
    expect(aliasProvider.directRun).toEqual({
      methods: [
        { name: "upload", parameterTypes: "[key: string, body: string]" },
      ],
    });
    delete factoryProvider.directRun;
    delete aliasProvider.directRun;

    expect(JSON.stringify(graph)).toBe(JSON.stringify(served));
  });

  it("names a factory provider by its factory or token, never by what it returns, in both graphs", async () => {
    @Injectable()
    class FixtureRealService {
      ping(): string {
        return "pong";
      }
    }
    @Injectable()
    class FixtureConsumer {
      constructor(
        readonly real: FixtureRealService,
        @Inject("FIXTURE_CLIENT") readonly client: unknown,
      ) {}
    }
    // As @nestjs/config's registerAs() does: a factory passed as an argument
    // has no name of its own, and its token is all that identifies it.
    const registerAs = (namespace: string, factory: () => object) => ({
      provide: `CONFIGURATION(${namespace})`,
      useFactory: factory,
    });
    const createClient = () => () => new FixtureRealService();
    const port = await freePort();
    @Module({
      imports: [inspectorOn(port)],
      providers: [
        registerAs("database", () => ({ host: "localhost" })),
        registerAs("mail", () => ({ sender: "noreply" })),
        {
          provide: "CONFIGURATION_LOADER",
          useFactory: (...configurations: object[]) => configurations,
          inject: ["CONFIGURATION(database)", "CONFIGURATION(mail)"],
        },
        // An alias registered before the provider it points at.
        { provide: "FIXTURE_ALIAS", useExisting: FixtureRealService },
        FixtureRealService,
        FixtureConsumer,
        // An anonymous factory returning an instance of an application class.
        { provide: "FIXTURE_CLIENT", useFactory: createClient() },
      ],
    })
    class FixtureFactoryNamedModule {}

    const served = await readServedGraph(FixtureFactoryNamedModule, port);
    const { graph } = await exportWith(FixtureFactoryNamedModule);

    // A running inspector used to name each anonymous factory after the
    // class of what it returned — both configurations `Object`, the loader
    // depending on one `Object` — and to let the alias, whose instance is
    // FixtureRealService's, stand in for FixtureRealService wherever it was
    // injected. Neither depends on an instance any more, so the served
    // graph is the exported one.
    expect(JSON.stringify(graph)).toBe(served);
    expect(
      graph.modules.FixtureFactoryNamedModule.providers
        .slice(2) // ModuleRef, ApplicationConfig
        .map((provider) => [
          provider.name,
          provider.dependencies.map((dependency) => dependency.token),
        ]),
    ).toEqual([
      ["CONFIGURATION(database)", []],
      ["CONFIGURATION(mail)", []],
      // Written in place, so named only by JavaScript after the useFactory
      // key, and Nest's own alias function: each goes by its token.
      ["CONFIGURATION_LOADER", ["CONFIGURATION(database)", "CONFIGURATION(mail)"]],
      ["FIXTURE_ALIAS", ["FixtureRealService"]],
      ["FixtureRealService", []],
      ["FixtureConsumer", ["FixtureRealService", "FIXTURE_CLIENT"]],
      ["FIXTURE_CLIENT", []],
    ]);
  });

  it("is byte-identical to /output.json when no provider's metadata comes from an instance", async () => {
    const port = await freePort();
    // Leaves out the factory and the alias, whose Direct Run methods a
    // running inspector reads off their instances.
    const ignore = {
      ...FIXTURE_IGNORE,
      providers: [
        "FixtureMetricsService",
        "connectFixtureDatabase",
        "FIXTURE_STORAGE_ALIAS",
      ],
    };
    const entryModule = createApplicationModule(inspectorOn(port, ignore));

    const served = await readServedGraph(entryModule, port);
    const { graph } = await exportWith(entryModule);

    expect(JSON.stringify(graph)).toBe(served);
  });

  it("builds the same graph as an application context, without an HTTP platform", async () => {
    const entryModule = createApplicationModule(inspectorOn(1));
    const { graph: asApplication } = await exportWith(entryModule);
    const { graph: asContext } = await exportWith(
      entryModule,
      "application-context",
    );

    // createApplicationContext() initialises the context; in preview mode
    // that still calls no hook outside Nest's own allowlisted module.
    expect(fixtureCalls).toEqual([]);
    expect(asContext).toEqual(asApplication);
  });

  describe("uses the options the application gave the inspector", () => {
    it("walks from the configured rootModule", async () => {
      const entryModule = createApplicationModule(
        NestGraphInspectorModule.forRoot({ rootModule: FixtureAccountsModule }),
      );

      const { graph, optionsSource } = await exportWith(entryModule);

      expect(optionsSource).toBe("application");
      expect(graph.root).toBe("FixtureAccountsModule");
    });

    it("walks from the module that imports the inspector, as a running inspector does", async () => {
      const port = await freePort();
      @Module({ imports: [inspectorOn(port), FixtureDocumentsModule] })
      class FixtureInspectorHostModule {}
      const entryModule = createApplicationModule(FixtureInspectorHostModule);

      const served = JSON.parse(
        await readServedGraph(entryModule, port),
      ) as GraphOutput;
      const { graph } = await exportWith(entryModule);

      expect(served.root).toBe("FixtureInspectorHostModule");
      expect(graph.root).toBe("FixtureInspectorHostModule");
      expect(Object.keys(graph.modules)).toEqual(Object.keys(served.modules));
    });

    it("applies the defaults of a plain NestGraphInspectorModule import", async () => {
      const entryModule = createApplicationModule(NestGraphInspectorModule);

      const { graph, optionsSource, warnings } = await exportWith(entryModule);

      expect(optionsSource).toBe("application");
      expect(warnings).toEqual([]);
      expect(graph.root).toBe("FixtureApplicationModule");
      expect(providerNames(graph, "FixtureDocumentsModule")).toContain(
        "FixtureMetricsService",
      );
    });

    it("falls back to the defaults, and says so, for forRootAsync()", async () => {
      const entryModule = createApplicationModule(
        NestGraphInspectorModule.forRootAsync({
          useFactory: () => ({ ignore: FIXTURE_IGNORE }),
        }),
      );

      const { graph, optionsSource, warnings } = await exportWith(entryModule);

      expect(optionsSource).toBe("unresolved");
      expect(warnings).toEqual([
        expect.stringContaining("forRootAsync()"),
      ]);
      expect(graph.root).toBe("FixtureApplicationModule");
      // The ignore in the factory is not applied.
      expect(providerNames(graph, "FixtureDocumentsModule")).toContain(
        "FixtureMetricsService",
      );
      expect(graph.modules.FixtureAccountsModule.controllers).toEqual([
        expect.objectContaining({ name: "FixtureAdminController" }),
      ]);
      expect(graph.modules).not.toHaveProperty("NestGraphInspectorModule");
    });

    it("walks from the entry module with the defaults when the application does not import the inspector", async () => {
      const entryModule = createApplicationModule();

      const { graph, optionsSource, warnings } = await exportWith(entryModule);

      expect(optionsSource).toBe("defaults");
      expect(warnings).toEqual([]);
      expect(graph.root).toBe("FixtureApplicationModule");
      expect(graph.modules.FixtureApplicationModule.imports).toEqual([
        "FixtureSettingsModule",
        "FixtureDocumentsModule",
        "FixtureAccountsModule",
        "InternalCoreModule",
      ]);
    });

    it("leaves out another copy's NestGraphInspectorModule, and says its options were not read", async () => {
      @Injectable()
      class OtherCopySetup {}
      const OtherCopyInspectorModule = Object.defineProperty(
        class {},
        "name",
        { value: "NestGraphInspectorModule" },
      );
      Module({ providers: [OtherCopySetup] })(OtherCopyInspectorModule);
      const entryModule = createApplicationModule(OtherCopyInspectorModule);

      const { graph, optionsSource, warnings } = await exportWith(entryModule);

      expect(optionsSource).toBe("other-copy");
      expect(warnings).toEqual([
        expect.stringContaining("different copy of nest-graph-inspector"),
      ]);
      expect(graph.root).toBe("FixtureApplicationModule");
      expect(graph.modules).not.toHaveProperty("NestGraphInspectorModule");
      expect(graph.modules.FixtureApplicationModule.imports).not.toContain(
        "NestGraphInspectorModule",
      );
    });
  });

  it("rejects, rather than exiting, when Nest cannot bootstrap the application", async () => {
    @Injectable()
    class FixtureNeedsMissingProvider {
      constructor(@Inject("FIXTURE_MISSING") readonly missing: unknown) {}
    }
    @Module({ providers: [FixtureNeedsMissingProvider] })
    class FixtureBrokenModule {}

    const failure = exportWith(FixtureBrokenModule);

    await expect(failure).rejects.toBeInstanceOf(PreviewBootstrapError);
    await expect(failure).rejects.toThrow(
      /^Nest could not bootstrap FixtureBrokenModule in preview mode: .*FIXTURE_MISSING/s,
    );
  });

  it("rejects with the inspector's own error when the graph cannot be built", async () => {
    @Module({})
    class FixtureElsewhereModule {}
    const entryModule = createApplicationModule(
      NestGraphInspectorModule.forRoot({ rootModule: FixtureElsewhereModule }),
    );

    const failure = exportWith(entryModule);

    await expect(failure).rejects.not.toBeInstanceOf(PreviewBootstrapError);
    await expect(failure).rejects.toThrow(
      "Root module not found: FixtureElsewhereModule",
    );
    expect(fixtureCalls).toEqual([]);
  });
});
