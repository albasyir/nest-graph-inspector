// Keep this the first import from this package. Its modules import each other
// in a cycle that only resolves when this file loads first, as it does through
// the package entry; starting from `graph-output.builder` or
// `adapters/discovery` instead fails to load, or leaves `NestGraphInspectorModule`
// with undefined providers.
import {
  DEFAULT_IGNORE_PATHS,
  NestGraphInspectorModule,
} from "../nest-graph-inspector.module";
import type { LoggerService, Type } from "@nestjs/common";
import type * as NestCoreExports from "@nestjs/core";
import type { ModulesContainer } from "@nestjs/core";
import type { Module } from "@nestjs/core/injector/module";
import { DiscoveryAdapter } from "../adapters/discovery";
import type { ModuleTree } from "../adapters/discovery";
import { GraphOutputBuilder } from "../graph-output.builder";
import { MODULE_OPTIONS_TOKEN } from "../nest-graph-inspector.config";
import type { NestGraphInspectorModuleOptions } from "../nest-graph-inspector.type";
import { RuntimeTraceRecorder } from "../runtime-trace.recorder";
import { SourceMetadataService } from "../source-metadata.service";
import type { GraphOutput } from "../types/graph-output.type";
import { describeError } from "./cli-error";

/**
 * What an export needs from `@nestjs/core` — the application's own copy, the
 * one its modules were decorated against. A second copy would build a second,
 * empty container.
 */
export type NestCore = Pick<
  typeof NestCoreExports,
  "NestFactory" | "ModulesContainer"
>;

/**
 * How the application is booted. Both build the same container, and so the
 * same graph: `application` is `NestFactory.create()`, which needs
 * `@nestjs/platform-express` — without it Nest exits the process — and
 * `application-context` is `NestFactory.createApplicationContext()`, which
 * needs no HTTP platform.
 */
export type GraphExportBoot = "application" | "application-context";

/** Where the options the graph was built with came from. */
export type GraphExportOptionsSource =
  /** Read from the application's `NestGraphInspectorModule` (plain or `forRoot()`). */
  | "application"
  /** `forRootAsync()`: its factory never runs in preview mode, so defaults were used. */
  | "unresolved"
  /** A different copy of this package's module: defaults were used. */
  | "other-copy"
  /** The application does not import the inspector: defaults were used. */
  | "defaults";

export type GraphExportParams = {
  nestCore: NestCore;
  entryModule: Type<unknown>;
  boot: GraphExportBoot;
  /** Passed to Nest as the application's logger; `false` silences it. */
  logger: LoggerService | false;
};

export type GraphExportResult = {
  graph: GraphOutput;
  optionsSource: GraphExportOptionsSource;
  warnings: string[];
};

/** Nest could not bootstrap the application in preview mode; `cause` says why. */
export class PreviewBootstrapError extends Error {
  constructor(entryName: string, cause: unknown) {
    super(
      `Nest could not bootstrap ${entryName} in preview mode: ${describeError(cause)}`,
      { cause },
    );
    this.name = "PreviewBootstrapError";
  }
}

/**
 * Builds the graph of an application without running it.
 *
 * The application is booted in Nest's own preview mode
 * (https://docs.nestjs.com/devtools/ci-cd-integration): Nest scans every
 * module and resolves every dependency, but calls no constructor, no factory,
 * and no lifecycle hook, except in a module on Nest's
 * `InitializeOnPreviewAllowlist` — in Nest itself, only `InternalCoreModule`.
 * The application is never initialised and never listens. The graph is then
 * built by the same `DiscoveryAdapter` and `GraphOutputBuilder` a running
 * inspector serves `/output.json` from, with the options the application gave
 * the inspector.
 */
export async function exportGraph(
  params: GraphExportParams,
): Promise<GraphExportResult> {
  const { NestFactory, ModulesContainer } = params.nestCore;
  const previewOptions = {
    preview: true,
    snapshot: true,
    // Otherwise a failed bootstrap calls process.abort() instead of throwing.
    abortOnError: false,
    logger: params.logger,
  };
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  try {
    app =
      params.boot === "application"
        ? await NestFactory.create(params.entryModule, previewOptions)
        : await NestFactory.createApplicationContext(
            params.entryModule,
            previewOptions,
          );
  } catch (error) {
    throw new PreviewBootstrapError(params.entryModule.name, error);
  }
  const warnings: string[] = [];

  try {
    const modulesContainer = app.get(ModulesContainer);
    const resolved = resolveExportOptions(
      modulesContainer,
      params.entryModule,
    );
    warnings.push(...resolved.warnings);

    return {
      graph: buildGraphOutput(modulesContainer, resolved.options),
      optionsSource: resolved.source,
      warnings,
    };
  } finally {
    // Safe in preview mode: close() runs lifecycle hooks only in the modules
    // preview mode initialised, and the HTTP server it stops never listened.
    await app.close().catch((error: unknown) => {
      warnings.push(
        `Closing the preview application failed: ${describeError(error)}`,
      );
    });
  }
}

/**
 * The graph a running inspector configured with `options` would serve, built
 * over an already-booted container.
 */
export function buildGraphOutput(
  modulesContainer: ModulesContainer,
  options: NestGraphInspectorModuleOptions,
): GraphOutput {
  const sourceMetadata = new SourceMetadataService();
  const runtimeTraceRecorder = new RuntimeTraceRecorder();
  const discovery = new ExportDiscoveryAdapter(
    options,
    modulesContainer,
    runtimeTraceRecorder,
    sourceMetadata,
  );

  return new GraphOutputBuilder(
    options,
    modulesContainer,
    discovery,
    runtimeTraceRecorder,
    sourceMetadata,
  ).getGraphOutput();
}

/**
 * A discovery that leaves the application's classes alone. A running
 * inspector wraps provider and controller methods so Direct Run can trace
 * them; an export calls no method, so it has nothing to trace.
 */
class ExportDiscoveryAdapter extends DiscoveryAdapter {
  protected override instrumentRuntimeTrace(_moduleTree: ModuleTree): void {
    // Intentionally empty: see the class comment.
  }
}

/**
 * The options the application gave the inspector, so the export walks from
 * the same root module and ignores the same things a running inspector
 * would. When they cannot be read, the defaults apply with the entry module
 * as the root.
 */
function resolveExportOptions(
  modulesContainer: ModulesContainer,
  entryModule: Type<unknown>,
): {
  options: NestGraphInspectorModuleOptions;
  source: GraphExportOptionsSource;
  warnings: string[];
} {
  const moduleRefs = [...modulesContainer.values()];
  const inspectorModules = moduleRefs.filter(
    (moduleRef) => moduleRef.metatype === NestGraphInspectorModule,
  );
  const fallback = `the default options, with ${entryModule.name} as the root module`;

  if (inspectorModules.length) {
    const warnings =
      inspectorModules.length > 1
        ? [
            `The application imports NestGraphInspectorModule ${inspectorModules.length} times; the export uses the options of the first one Nest registered.`,
          ]
        : [];
    const options = readModuleOptions(inspectorModules[0]);

    return options
      ? { options, source: "application", warnings }
      : {
          options: { rootModule: entryModule },
          source: "unresolved",
          warnings: [
            ...warnings,
            `NestGraphInspectorModule is configured with forRootAsync(), whose options come from a factory that preview mode never runs. The graph uses ${fallback}: any rootModule, ignore, nestCoreModuleName, or nestCoreProviders set there is not applied.`,
          ],
        };
  }

  if (
    moduleRefs.some(
      (moduleRef) => moduleRef.metatype?.name === NestGraphInspectorModule.name,
    )
  ) {
    return {
      options: {
        rootModule: entryModule,
        // A running inspector leaves its own module out by class identity,
        // which another copy's class cannot match, so it is ignored by name.
        ignore: {
          modules: [NestGraphInspectorModule.name],
          paths: [...DEFAULT_IGNORE_PATHS],
        },
      },
      source: "other-copy",
      warnings: [
        `The application imports NestGraphInspectorModule from a different copy of nest-graph-inspector than the one exporting, so its options cannot be read. The graph uses ${fallback}.`,
      ],
    };
  }

  return {
    options: { rootModule: entryModule },
    source: "defaults",
    warnings: [],
  };
}

/**
 * What `forRoot()` — or a plain import of the module — registered as a value.
 * `forRootAsync()` registers a factory instead, and preview mode never calls
 * it, so there is nothing to read.
 */
function readModuleOptions(
  moduleRef: Module,
): NestGraphInspectorModuleOptions | undefined {
  const wrapper = moduleRef.providers.get(MODULE_OPTIONS_TOKEN);
  if (!wrapper || Array.isArray(wrapper.inject)) {
    return undefined;
  }

  const value: unknown = wrapper.instance;
  return value && typeof value === "object" ? value : undefined;
}
