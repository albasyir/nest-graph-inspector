import { RuntimeTraceRecorder } from "../runtime-trace.recorder";
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
});
