import { dirname, join } from "node:path";
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { ModulesContainer } from "@nestjs/core";
import { DiscoveryAdapter } from "./adapters/discovery";
import { GraphOutputBuilder } from "./graph-output.builder";
import { MODULE_OPTIONS_TOKEN } from "./nest-graph-inspector.config";
import type {
  NestGraphInspectorLayoutOptions,
  NestGraphInspectorModuleOptions,
  NestGraphInspectorOutput,
} from "./nest-graph-inspector.type";
import { defaultOptions } from "./nest-graph-inspector.module";
import type { GraphOutput } from "./types/graph-output.type";
import { HttpOutputAdapter } from "./adapters/http-output.adapter";
import { FileOutputAdapter } from "./adapters/file-output.adapter";
import { JsonOutputAdapter } from "./adapters/json-output.adapter";
import { ViewerOutputAdapter } from "./adapters/viewer-output.adapter";
import { OutputAdapter } from "./ports/output.adapter";
import type { NestGraphInspectorViewerDirectRunOptions } from "./nest-graph-inspector.type";
import { RuntimeTraceRecorder } from "./runtime-trace.recorder";
import { SourceMetadataService } from "./source-metadata.service";

const DEFAULT_DIRECT_RUN_MAX_BODY_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Publishes the graph `GraphOutputBuilder` builds to every configured output
 * when the host application starts.
 */
@Injectable()
export class NestGraphInspectorSetup
  extends GraphOutputBuilder
  implements OnModuleInit
{
  private readonly logger = new Logger(NestGraphInspectorSetup.name);
  private readonly outputAdapters: Record<
    NestGraphInspectorOutput["type"],
    OutputAdapter
  >;

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    options: NestGraphInspectorModuleOptions,
    modulesContainer: ModulesContainer,
    discovery: DiscoveryAdapter,
    private readonly httpOutputAdapter: HttpOutputAdapter,
    private readonly fileOutputAdapter: FileOutputAdapter,
    private readonly jsonOutputAdapter: JsonOutputAdapter,
    private readonly viewerOutputAdapter: ViewerOutputAdapter,
    runtimeTraceRecorder: RuntimeTraceRecorder,
    sourceMetadata: SourceMetadataService,
  ) {
    super(
      options,
      modulesContainer,
      discovery,
      runtimeTraceRecorder,
      sourceMetadata,
    );
    this.outputAdapters = {
      http: this.httpOutputAdapter,
      markdown: this.fileOutputAdapter,
      json: this.jsonOutputAdapter,
      viewer: this.viewerOutputAdapter,
    };
  }

  async onModuleInit(): Promise<void> {
    const outputs = this.options.outputs ?? [];
    if (!outputs.length) {
      return;
    }

    const viewerOutputs = outputs.filter(
      (
        output,
      ): output is Extract<NestGraphInspectorOutput, { type: "viewer" }> =>
        output.type === "viewer",
    );
    const eagerOutputs = outputs.filter((output) => output.type !== "viewer");

    // Viewer routes are installed without inspecting the Nest container. Their
    // graph endpoint creates and caches the graph on the first client request.
    await Promise.all(
      viewerOutputs.map((output) => this.installViewerOutput(output)),
    );

    // File and standalone HTTP outputs keep their established bootstrap-time
    // publication behavior.
    if (eagerOutputs.length) {
      await this.publishOutputs({
        graphOutput: this.getGraphOutput(),
        outputs: eagerOutputs,
      });
    }
  }

  private async installViewerOutput(
    output: Extract<NestGraphInspectorOutput, { type: "viewer" }>,
  ): Promise<void> {
    const configuredOutput = this.withDefaultOutputOptions(output);
    if (configuredOutput.type !== "viewer") {
      return;
    }

    try {
      const { message } = await this.viewerOutputAdapter.execute(
        () => this.getGraphOutput(),
        configuredOutput,
      );
      this.logger.debug(message);
    } catch (err) {
      this.logger.error(
        "Failed to execute output adapter for type viewer",
        err,
      );
    }
  }

  private async publishOutputs(param: {
    graphOutput: GraphOutput;
    outputs: NestGraphInspectorOutput[];
  }): Promise<void> {
    await Promise.all(
      param.outputs.map((output) =>
        this.publishSingleOutput(param.graphOutput, output),
      ),
    );
  }

  private async publishSingleOutput(
    graphOutput: GraphOutput,
    output: NestGraphInspectorOutput,
  ): Promise<void> {
    output = this.withDefaultOutputOptions(output);
    const adapter = this.outputAdapters[output.type];

    try {
      const { message } = await adapter.execute(graphOutput, output);
      this.logger.debug(message);
    } catch (err) {
      this.logger.error(
        `Failed to execute output adapter for type ${output.type}`,
        err,
      );
    }
  }

  private withDefaultOutputOptions(
    output: NestGraphInspectorOutput,
  ): NestGraphInspectorOutput & { layout?: NestGraphInspectorLayoutOptions } {
    if (output.type !== "viewer" && output.type !== "http") {
      return output;
    }

    const layout = this.options.ui?.layout;
    if (output.type === "http") {
      return { ...output, layout };
    }

    const defaultViewerOutput = defaultOptions.outputs?.find(
      (defaultOutput) => defaultOutput.type === "viewer",
    );
    if (!defaultViewerOutput || defaultViewerOutput.type !== "viewer") {
      return { ...output, layout };
    }

    return {
      ...output,
      layout,
      directRun: this.mergeViewerDirectRunOptions(
        defaultViewerOutput.directRun,
        output.directRun,
      ),
    };
  }

  private mergeViewerDirectRunOptions(
    defaultViewerOutputOptions?: NestGraphInspectorViewerDirectRunOptions,
    outputOptions?: NestGraphInspectorViewerDirectRunOptions,
  ) {
    // Precedence, most specific first: the output's own `directRun`, then the
    // module-wide `directRun` default, then the library's built-in default
    // (which only ever sets `path`), then the hardcoded, permissive-by-default
    // fallback.
    const moduleOptions = this.options.directRun;
    const enabled =
      outputOptions?.enabled ??
      moduleOptions?.enabled ??
      defaultViewerOutputOptions?.enabled ??
      true;
    const path =
      outputOptions?.path ?? moduleOptions?.path ?? defaultViewerOutputOptions?.path;
    if (!path) {
      return undefined;
    }

    const allowUnsafeMethods =
      outputOptions?.allowUnsafeMethods ??
      moduleOptions?.allowUnsafeMethods ??
      defaultViewerOutputOptions?.allowUnsafeMethods ??
      true;
    const maxBodySizeBytes =
      outputOptions?.maxBodySizeBytes ??
      moduleOptions?.maxBodySizeBytes ??
      defaultViewerOutputOptions?.maxBodySizeBytes ??
      DEFAULT_DIRECT_RUN_MAX_BODY_SIZE_BYTES;

    return {
      enabled,
      path,
      allowUnsafeMethods,
      maxBodySizeBytes,
      historyDirPath: this.getDirectRunHistoryDirPath(),
      instanceLookup: (moduleName: string, providerName: string) =>
        this.findDirectRunProviderInstance(moduleName, providerName),
      allowedMethodsLookup: (moduleName: string, providerName: string) =>
        this.getDirectRunAllowedMethods(moduleName, providerName),
      controllerInstanceLookup: (moduleName: string, controllerName: string) =>
        this.findDirectRunControllerInstance(moduleName, controllerName),
      controllerAllowedMethodsLookup: (
        moduleName: string,
        controllerName: string,
      ) => this.getDirectRunControllerAllowedMethods(moduleName, controllerName),
    };
  }

  private getDirectRunHistoryDirPath(): string | undefined {
    const jsonOutput = this.options.outputs?.find(
      (output) => output.type === "json",
    );

    return jsonOutput?.type === "json"
      ? join(process.cwd(), dirname(jsonOutput.path), "direct-run", "history")
      : undefined;
  }
}
