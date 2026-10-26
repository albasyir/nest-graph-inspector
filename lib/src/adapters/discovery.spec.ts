import { Controller, type Type } from "@nestjs/common";
import { MODULE_PATH } from "@nestjs/common/constants";
import { Project } from "ts-morph";
import type { NestGraphInspectorIgnoreOptions } from "../nest-graph-inspector.type";
import { RuntimeTraceRecorder } from "../runtime-trace.recorder";
import { SourceMetadataService } from "../source-metadata.service";
import type { RuntimeTraceSpanType } from "../types/direct-run.type";
import {
  DiscoveryAdapter,
  getOriginalTracedMethod,
  type AnyFunction,
  type ModuleTree,
} from "./discovery";

const ownMethod = (target: object, methodName: string): AnyFunction => {
  const value = Object.getOwnPropertyDescriptor(target, methodName)?.value;
  if (typeof value !== "function") {
    throw new Error(`${methodName} is not an own method of the target.`);
  }

  return value as AnyFunction;
};

type DiscoveryAdapterInternals = {
  instrumentRuntimeTraceInstance(param: {
    instance: object;
    moduleName: string;
    className: string;
    type: RuntimeTraceSpanType;
  }): void;
};

describe(DiscoveryAdapter.name, () => {
  class TestRootModule {}

  const createAdapter = () =>
    new DiscoveryAdapter(
      {
        rootModule: TestRootModule,
        outputs: [],
      },
      new Map([
        [
          TestRootModule.name,
          {
            metatype: TestRootModule,
            imports: new Map(),
            exports: new Map(),
            providers: new Map(),
            controllers: new Map(),
          },
        ],
      ]) as never,
      new RuntimeTraceRecorder(),
      new SourceMetadataService(),
    );

  it("throws when tree is read before scanning", () => {
    const discovery = createAdapter();

    expect(() => discovery.tree).toThrow(
      "Discovery tree is unavailable before scan() is called.",
    );
  });

  it("returns and reuses the scanned tree", () => {
    const discovery = createAdapter();

    const firstTree = discovery.scan();
    const secondTree = discovery.scan();

    expect(secondTree).toBe(firstTree);
    expect(discovery.tree).toBe(firstTree);
  });

  it("captures controller instances alongside provider instances", () => {
    class TestController {}
    const controllerInstance = new TestController();

    const discovery = new DiscoveryAdapter(
      { rootModule: TestRootModule, outputs: [] },
      new Map([
        [
          TestRootModule.name,
          {
            metatype: TestRootModule,
            imports: new Map(),
            exports: new Map(),
            providers: new Map(),
            controllers: new Map([
              [
                TestController.name,
                { metatype: TestController, instance: controllerInstance },
              ],
            ]),
          },
        ],
      ]) as never,
      new RuntimeTraceRecorder(),
      new SourceMetadataService(),
    );

    const tree = discovery.scan();

    expect(tree.controllers.map((controller) => controller.name)).toContain(
      TestController.name,
    );
    expect(tree.controllerInstances.get(TestController.name)).toBe(
      controllerInstance,
    );
  });

  it("preserves instrumented method arity without instance shadowing", () => {
    class ArityProvider {
      join(first: string, second: string): string {
        return `${first}:${second}`;
      }
    }
    const instance = new ArityProvider();
    const discovery = new DiscoveryAdapter(
      { rootModule: TestRootModule, outputs: [] },
      new Map([
        [
          TestRootModule.name,
          {
            metatype: TestRootModule,
            imports: new Map(),
            exports: new Map(),
            providers: new Map([
              [
                ArityProvider.name,
                { metatype: ArityProvider, instance },
              ],
            ]),
            controllers: new Map(),
          },
        ],
      ]) as never,
      new RuntimeTraceRecorder(),
      new SourceMetadataService(),
    );

    discovery.scan();

    const tracedJoin = ownMethod(ArityProvider.prototype, "join");

    expect(tracedJoin.length).toBe(2);
    expect(Object.hasOwn(instance, "join")).toBe(false);
    expect(tracedJoin.call(instance, "left", "right")).toBe("left:right");
  });

  it("uses each shared-prototype instance's module trace metadata", async () => {
    class FirstModule {}
    class SecondModule {}
    class SharedProvider {
      ping(): string {
        return "pong";
      }
    }

    const firstInstance = new SharedProvider();
    const secondInstance = new SharedProvider();
    const firstModule = {
      metatype: FirstModule,
      imports: new Map(),
      exports: new Map(),
      providers: new Map([
        [
          SharedProvider.name,
          { metatype: SharedProvider, instance: firstInstance },
        ],
      ]),
      controllers: new Map(),
    };
    const secondModule = {
      metatype: SecondModule,
      imports: new Map(),
      exports: new Map(),
      providers: new Map([
        [
          SharedProvider.name,
          { metatype: SharedProvider, instance: secondInstance },
        ],
      ]),
      controllers: new Map(),
    };
    const runtimeTraceRecorder = new RuntimeTraceRecorder();
    const discovery = new DiscoveryAdapter(
      { rootModule: TestRootModule, outputs: [] },
      new Map([
        [
          TestRootModule.name,
          {
            metatype: TestRootModule,
            imports: new Map([
              [FirstModule.name, firstModule],
              [SecondModule.name, secondModule],
            ]),
            exports: new Map(),
            providers: new Map(),
            controllers: new Map(),
          },
        ],
        [FirstModule.name, firstModule],
        [SecondModule.name, secondModule],
      ]) as never,
      runtimeTraceRecorder,
      new SourceMetadataService(),
    );

    discovery.scan();

    const handle = runtimeTraceRecorder.start({
      moduleName: TestRootModule.name,
      providerName: "TraceEntrypoint",
      methodName: "run",
      args: [],
    });
    const result = await runtimeTraceRecorder.runWithContext(handle, async () =>
      [firstInstance.ping(), secondInstance.ping()],
    );
    const trace = await runtimeTraceRecorder.finishSuccess(handle, result);

    expect(
      trace.spans
        .filter((span) => span.name === `${SharedProvider.name}.ping`)
        .map((span) => span.moduleName),
    ).toEqual([FirstModule.name, SecondModule.name]);
  });

  it("deduplicates shared-prototype instrumentation across adapters", async () => {
    class FirstModule {}
    class SecondModule {}
    class SharedProvider {
      ping(): string {
        return "pong";
      }
    }

    const firstInstance = new SharedProvider();
    const secondInstance = new SharedProvider();
    const runtimeTraceRecorder = new RuntimeTraceRecorder();
    const createDiscovery = (
      module: typeof FirstModule,
      instance: SharedProvider,
    ) =>
      new DiscoveryAdapter(
        { rootModule: module, outputs: [] },
        new Map([
          [
            module.name,
            {
              metatype: module,
              imports: new Map(),
              exports: new Map(),
              providers: new Map([
                [
                  SharedProvider.name,
                  { metatype: SharedProvider, instance },
                ],
              ]),
              controllers: new Map(),
            },
          ],
        ]) as never,
        runtimeTraceRecorder,
        new SourceMetadataService(),
      );

    createDiscovery(FirstModule, firstInstance).scan();
    createDiscovery(SecondModule, secondInstance).scan();

    const handle = runtimeTraceRecorder.start({
      moduleName: TestRootModule.name,
      providerName: "TraceEntrypoint",
      methodName: "run",
      args: [],
    });
    const result = await runtimeTraceRecorder.runWithContext(handle, async () =>
      secondInstance.ping(),
    );
    const trace = await runtimeTraceRecorder.finishSuccess(handle, result);

    expect(trace.spans).toHaveLength(2);
    expect(trace.spans[1]).toMatchObject({
      name: `${SharedProvider.name}.ping`,
      moduleName: SecondModule.name,
    });
  });

  it("skips built-in prototypes when instrumenting an instance, without throwing or instrumenting them", () => {
    const discovery = createAdapter();
    const internals = discovery as unknown as DiscoveryAdapterInternals;
    const originalObjectToString = ownMethod(Object.prototype, "toString");
    const originalArrayPush = ownMethod(Array.prototype, "push");
    const originalFunctionCall = ownMethod(Function.prototype, "call");

    expect(() =>
      internals.instrumentRuntimeTraceInstance({
        instance: {},
        moduleName: TestRootModule.name,
        className: "PlainObjectProvider",
        type: "provider",
      }),
    ).not.toThrow();
    expect(() =>
      internals.instrumentRuntimeTraceInstance({
        instance: [],
        moduleName: TestRootModule.name,
        className: "ArrayProvider",
        type: "provider",
      }),
    ).not.toThrow();
    expect(() =>
      internals.instrumentRuntimeTraceInstance({
        instance: () => undefined,
        moduleName: TestRootModule.name,
        className: "FunctionProvider",
        type: "provider",
      }),
    ).not.toThrow();

    expect(ownMethod(Object.prototype, "toString")).toBe(
      originalObjectToString,
    );
    expect(ownMethod(Array.prototype, "push")).toBe(originalArrayPush);
    expect(ownMethod(Function.prototype, "call")).toBe(originalFunctionCall);
    expect(
      getOriginalTracedMethod(originalObjectToString),
    ).toBeUndefined();
  });

  it("preserves the original method so getOriginalTracedMethod can recover it after instrumentation", () => {
    class OriginalMethodProvider {
      join(first: string, second: string): string {
        return `${first}:${second}`;
      }
    }
    const originalJoin = ownMethod(OriginalMethodProvider.prototype, "join");
    const instance = new OriginalMethodProvider();
    const discovery = new DiscoveryAdapter(
      { rootModule: TestRootModule, outputs: [] },
      new Map([
        [
          TestRootModule.name,
          {
            metatype: TestRootModule,
            imports: new Map(),
            exports: new Map(),
            providers: new Map([
              [
                OriginalMethodProvider.name,
                { metatype: OriginalMethodProvider, instance },
              ],
            ]),
            controllers: new Map(),
          },
        ],
      ]) as never,
      new RuntimeTraceRecorder(),
      new SourceMetadataService(),
    );

    discovery.scan();

    const wrappedJoin = ownMethod(OriginalMethodProvider.prototype, "join");

    expect(wrappedJoin).not.toBe(originalJoin);
    expect(getOriginalTracedMethod(wrappedJoin)).toBe(originalJoin);
    expect(
      getOriginalTracedMethod(wrappedJoin)?.call(instance, "left", "right"),
    ).toBe("left:right");
  });
});

type WrapperFixture = {
  token: unknown;
  metatype?: unknown;
  instance?: unknown;
};

type ModuleFixture = {
  metatype: Type<unknown>;
  imports: Map<string, ModuleFixture>;
  exports: Set<unknown>;
  providers: Map<unknown, WrapperFixture>;
  controllers: Map<unknown, WrapperFixture>;
};

const classWrapper = (
  metatype: Type<unknown>,
  instance?: object,
): WrapperFixture => ({ token: metatype, metatype, instance });

const moduleFixture = (
  metatype: Type<unknown>,
  members: {
    imports?: ModuleFixture[];
    exports?: unknown[];
    providers?: WrapperFixture[];
    controllers?: WrapperFixture[];
  } = {},
): ModuleFixture => ({
  metatype,
  imports: new Map(
    (members.imports ?? []).map((imported) => [imported.metatype.name, imported]),
  ),
  exports: new Set(members.exports ?? []),
  providers: new Map(
    (members.providers ?? []).map((wrapper) => [wrapper.token, wrapper]),
  ),
  controllers: new Map(
    (members.controllers ?? []).map((wrapper) => [wrapper.token, wrapper]),
  ),
});

/** Source metadata over an in-memory project, so no test reads the disk. */
const sourceMetadataFor = (
  files: Record<string, string> = {},
): SourceMetadataService => {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, source] of Object.entries(files)) {
    project.createSourceFile(path, source);
  }

  const sourceMetadata = new SourceMetadataService();
  jest
    .spyOn(
      sourceMetadata as unknown as { createProject(): Project },
      "createProject",
    )
    .mockReturnValue(project);

  return sourceMetadata;
};

const scanIgnoring = (
  ignore: NestGraphInspectorIgnoreOptions | undefined,
  root: ModuleFixture,
  sourceMetadata: SourceMetadataService = sourceMetadataFor(),
): ModuleTree => {
  const modules = new Map<string, ModuleFixture>();
  const collect = (moduleRef: ModuleFixture): void => {
    if (modules.has(moduleRef.metatype.name)) {
      return;
    }

    modules.set(moduleRef.metatype.name, moduleRef);
    moduleRef.imports.forEach(collect);
  };
  collect(root);

  return new DiscoveryAdapter(
    { rootModule: root.metatype, outputs: [], ...(ignore ? { ignore } : {}) },
    modules as never,
    new RuntimeTraceRecorder(),
    sourceMetadata,
  ).scan();
};

const allModules = (tree: ModuleTree): ModuleTree[] => [
  tree,
  ...tree.children.flatMap(allModules),
];

const moduleNames = (tree: ModuleTree): string[] =>
  allModules(tree).map((node) => node.name);

const findModule = (tree: ModuleTree, name: string): ModuleTree => {
  const found = allModules(tree).find((node) => node.name === name);
  if (!found) {
    throw new Error(`${name} is not in the scanned tree.`);
  }

  return found;
};

const memberNames = (members: { name: string }[]): string[] =>
  members.map((member) => member.name);

const isInstrumented = (metatype: Type<unknown>, methodName: string) =>
  getOriginalTracedMethod(ownMethod(metatype.prototype as object, methodName)) !==
  undefined;

describe(`${DiscoveryAdapter.name} ignore options`, () => {
  class RootModule {}

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("ignores modules by exact name, RegExp, and wildcard, with everything reached only through them", () => {
    class AdminModule {}
    class AdminChildModule {}
    class ReportingModule {}
    class InternalAuditModule {}
    class VisibleModule {}
    class AdminChildService {}

    const tree = scanIgnoring(
      { modules: ["AdminModule", /^Reporting/, "Internal*"] },
      moduleFixture(RootModule, {
        imports: [
          moduleFixture(AdminModule, {
            imports: [
              moduleFixture(AdminChildModule, {
                providers: [classWrapper(AdminChildService)],
              }),
            ],
          }),
          moduleFixture(ReportingModule),
          moduleFixture(InternalAuditModule),
          moduleFixture(VisibleModule),
        ],
      }),
    );

    expect(moduleNames(tree)).toEqual([RootModule.name, VisibleModule.name]);
    expect(tree.imports).toEqual([VisibleModule.name]);
  });

  it("ignores providers by class name, RegExp, injection token, and symbol token", () => {
    class HiddenService {
      run(): string {
        return "hidden";
      }
    }
    class UserCache {}
    class VisibleService {
      run(): string {
        return "visible";
      }
    }
    const FEATURE_FLAGS = Symbol("FEATURE_FLAGS");
    const AUDIT_SINK = Symbol("AUDIT_SINK");

    const tree = scanIgnoring(
      {
        providers: ["HiddenService", /Cache$/],
        inject: ["CONFIG", "FEATURE_FLAGS", "Symbol(AUDIT_SINK)"],
      },
      moduleFixture(RootModule, {
        providers: [
          classWrapper(HiddenService, new HiddenService()),
          classWrapper(UserCache),
          classWrapper(VisibleService, new VisibleService()),
          { token: "CONFIG" },
          { token: FEATURE_FLAGS },
          { token: AUDIT_SINK },
          { token: "VISIBLE_TOKEN" },
        ],
        exports: [HiddenService, VisibleService, "CONFIG", FEATURE_FLAGS],
      }),
    );

    expect(memberNames(tree.providers)).toEqual([
      VisibleService.name,
      "VISIBLE_TOKEN",
    ]);
    expect(tree.exports).toEqual([VisibleService.name]);
    expect([...tree.providerInstances.keys()]).toEqual([
      VisibleService.name,
      "VISIBLE_TOKEN",
    ]);
    expect(isInstrumented(HiddenService, "run")).toBe(false);
    expect(isInstrumented(VisibleService, "run")).toBe(true);
  });

  it("treats a RegExp with the global flag the same on every match", () => {
    class HiddenFirst {}
    class HiddenSecond {}

    const tree = scanIgnoring(
      { providers: [/Hidden/g] },
      moduleFixture(RootModule, {
        providers: [classWrapper(HiddenFirst), classWrapper(HiddenSecond)],
      }),
    );

    expect(tree.providers).toEqual([]);
  });

  it("ignores controllers by name and RegExp", () => {
    class HealthController {
      check(): string {
        return "ok";
      }
    }
    class DebugToolsController {}
    class UsersController {
      list(): string[] {
        return [];
      }
    }

    const tree = scanIgnoring(
      { controllers: ["HealthController", /^Debug/] },
      moduleFixture(RootModule, {
        controllers: [
          classWrapper(HealthController, new HealthController()),
          classWrapper(DebugToolsController),
          classWrapper(UsersController, new UsersController()),
        ],
      }),
    );

    expect(memberNames(tree.controllers)).toEqual([UsersController.name]);
    expect([...tree.controllerInstances.keys()]).toEqual([
      UsersController.name,
    ]);
    expect(isInstrumented(HealthController, "check")).toBe(false);
    expect(isInstrumented(UsersController, "list")).toBe(true);
  });

  it("ignores controllers by route path, as a path prefix or a glob", () => {
    @Controller("admin")
    class AdminController {
      dashboard(): string {
        return "dashboard";
      }
    }
    @Controller("/admin/users/")
    class AdminUsersController {}
    @Controller("administrator")
    class AdministratorController {}
    @Controller("internal/metrics")
    class InternalMetricsController {}
    @Controller("internal/deep/metrics")
    class InternalDeepController {}
    @Controller(["public", "internal/health"])
    class MultiPathController {}
    @Controller()
    class RootController {}

    const tree = scanIgnoring(
      { paths: ["/admin", "/internal/*"] },
      moduleFixture(RootModule, {
        controllers: [
          classWrapper(AdminController, new AdminController()),
          classWrapper(AdminUsersController),
          classWrapper(AdministratorController),
          classWrapper(InternalMetricsController),
          classWrapper(InternalDeepController),
          classWrapper(MultiPathController),
          classWrapper(RootController),
        ],
      }),
    );

    expect(memberNames(tree.controllers)).toEqual([
      AdministratorController.name,
      InternalDeepController.name,
      RootController.name,
    ]);
    expect(isInstrumented(AdminController, "dashboard")).toBe(false);
  });

  it("ignores a module mounted at an ignored route path, with all of its members and imports", () => {
    class InternalModule {}
    class InternalChildModule {}
    class InternalService {}
    @Controller("status")
    class InternalStatusController {}
    class ReportsModule {}
    @Controller("daily")
    class DailyReportController {}
    @Controller("weekly")
    class WeeklyReportController {}
    // RouterModule records a mount path under MODULE_PATH + application id.
    Reflect.defineMetadata(`${MODULE_PATH}app-id`, "/internal", InternalModule);
    Reflect.defineMetadata(`${MODULE_PATH}app-id`, "reports", ReportsModule);

    const tree = scanIgnoring(
      { paths: ["/internal", "/reports/daily"] },
      moduleFixture(RootModule, {
        imports: [
          moduleFixture(InternalModule, {
            imports: [moduleFixture(InternalChildModule)],
            providers: [classWrapper(InternalService)],
            controllers: [classWrapper(InternalStatusController)],
          }),
          moduleFixture(ReportsModule, {
            controllers: [
              classWrapper(DailyReportController),
              classWrapper(WeeklyReportController),
            ],
          }),
        ],
      }),
    );

    expect(moduleNames(tree)).toEqual([RootModule.name, ReportsModule.name]);
    expect(
      memberNames(findModule(tree, ReportsModule.name).controllers),
    ).toEqual([WeeklyReportController.name]);
  });

  it("ignores modules, providers, and controllers by source file path", () => {
    class LegacyModule {}
    class LegacyService {}
    class LegacyController {}
    class CurrentService {}
    const sourceMetadata = sourceMetadataFor({
      "/repo/src/legacy/legacy.module.ts": "class LegacyModule {}",
      "/repo/src/app/legacy.service.legacy.ts": "class LegacyService {}",
      "/repo/src/app/legacy.controller.ts": "class LegacyController {}",
      "/repo/src/app/current.service.ts": "class CurrentService {}",
    });

    const tree = scanIgnoring(
      { paths: ["**/legacy/**", "**/*.legacy.ts", /legacy\.controller\.ts$/] },
      moduleFixture(RootModule, {
        imports: [moduleFixture(LegacyModule)],
        providers: [classWrapper(LegacyService), classWrapper(CurrentService)],
        controllers: [classWrapper(LegacyController)],
      }),
      sourceMetadata,
    );

    expect(moduleNames(tree)).toEqual([RootModule.name]);
    expect(memberNames(tree.providers)).toEqual([CurrentService.name]);
    expect(tree.controllers).toEqual([]);
  });

  it("does not look up source files when no path is ignored", () => {
    class SomeService {}
    const sourceMetadata = sourceMetadataFor();
    const getClassFilePath = jest.spyOn(sourceMetadata, "getClassFilePath");

    scanIgnoring(
      { providers: ["Unrelated"] },
      moduleFixture(RootModule, { providers: [classWrapper(SomeService)] }),
      sourceMetadata,
    );

    expect(getClassFilePath).not.toHaveBeenCalled();
  });

  it("accepts singular aliases and single patterns, combined with their plural keys", () => {
    class AliasModule {}
    class PluralModule {}
    class AliasService {}
    class PluralService {}
    class AliasController {}
    @Controller("aliased")
    class RoutedController {}
    class KeptController {}

    const tree = scanIgnoring(
      {
        module: "AliasModule",
        modules: "PluralModule",
        provider: "AliasService",
        providers: [/^Plural/],
        inject: "ALIAS_TOKEN",
        controller: /^Alias/,
        path: "/aliased",
      },
      moduleFixture(RootModule, {
        imports: [moduleFixture(AliasModule), moduleFixture(PluralModule)],
        providers: [
          classWrapper(AliasService),
          classWrapper(PluralService),
          { token: "ALIAS_TOKEN" },
          { token: "KEPT_TOKEN" },
        ],
        controllers: [
          classWrapper(AliasController),
          classWrapper(RoutedController),
          classWrapper(KeptController),
        ],
      }),
    );

    expect(moduleNames(tree)).toEqual([RootModule.name]);
    expect(memberNames(tree.providers)).toEqual(["KEPT_TOKEN"]);
    expect(memberNames(tree.controllers)).toEqual([KeptController.name]);
  });

  it("replaces a category's default only when that category is configured", () => {
    class InternalCoreModule {}
    class ModuleRef {}

    const fixture = () =>
      moduleFixture(RootModule, {
        imports: [moduleFixture(InternalCoreModule)],
        providers: [classWrapper(ModuleRef)],
      });

    const withDefaults = scanIgnoring({ controllers: ["Unrelated"] }, fixture());
    expect(moduleNames(withDefaults)).toEqual([RootModule.name]);
    expect(withDefaults.providers).toEqual([]);

    const withoutDefaults = scanIgnoring(
      { modules: [], providers: [] },
      fixture(),
    );
    expect(moduleNames(withoutDefaults)).toEqual([
      RootModule.name,
      InternalCoreModule.name,
    ]);
    expect(memberNames(withoutDefaults.providers)).toEqual([ModuleRef.name]);
  });
});
