import { RuntimeTraceRecorder } from "../runtime-trace.recorder";
import { SourceMetadataService } from "../source-metadata.service";
import { DiscoveryAdapter } from "./discovery";

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

    expect(instance.join.length).toBe(2);
    expect(Object.hasOwn(instance, "join")).toBe(false);
    expect(instance.join("left", "right")).toBe("left:right");
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
});
