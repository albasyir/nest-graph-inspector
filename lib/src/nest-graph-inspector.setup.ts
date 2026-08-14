import { dirname, join } from "node:path";
import { Inject, Injectable, Logger, OnModuleInit, Type } from "@nestjs/common";

import { ModulesContainer } from "@nestjs/core";
import { DiscoveryAdapter } from "./adapters/discovery";
import type { ModuleTree } from "./adapters/discovery";
import { MODULE_OPTIONS_TOKEN } from "./nest-graph-inspector.config";
import type {
  NestGraphInspectorModuleOptions,
  NestGraphInspectorOutput,
} from "./nest-graph-inspector.type";
import { defaultOptions } from "./nest-graph-inspector.module";
import { Modules } from "./types/module.type";
import { ModuleMap } from "./types/module-map.type";
import type {
  DirectRunProviderMeta,
  DirectRunProviderMethod,
} from "./types/direct-run.type";
import type {
  GraphOutput,
  GraphOutputCycle,
  GraphOutputCycles,
  GraphOutputCycleType,
  GraphOutputDependencyRef,
  GraphOutputModule,
  GraphOutputProviderCycle,
  GraphOutputProviderCyclePathItem,
} from "./types/graph-output.type";
import { HttpOutputAdapter } from "./adapters/http-output.adapter";
import { FileOutputAdapter } from "./adapters/file-output.adapter";
import { JsonOutputAdapter } from "./adapters/json-output.adapter";
import { ViewerOutputAdapter } from "./adapters/viewer-output.adapter";
import { OutputAdapter } from "./ports/output.adapter";
import { Node, Project, SyntaxKind, Type as TsMorphType } from "ts-morph";
import type { NestGraphInspectorViewerDirectRunOptions } from "./nest-graph-inspector.type";
import { RuntimeTraceRecorder } from "./runtime-trace.recorder";
import { SourceMetadataService } from "./source-metadata.service";

type DependencyNodeKind = "provider" | "controller";
type DependencyNode = {
  key: string;
  kind: DependencyNodeKind;
  moduleName: string;
  name: string;
};
type NextCycleId = () => number;

// Direct-run type metadata must remain bounded even for recursive application types.
const MAX_TYPE_RENDER_DEPTH = 12;
const MAX_TYPE_RENDER_MEMBERS = 50;
const MAX_TYPE_RENDER_LENGTH = 8_000;
const MAX_TYPE_PROPERTY_NAME_LENGTH = 160;
const MIN_TYPE_RENDER_LENGTH = "unknown".length;

type TypeRenderState = {
  activeTypes: Set<TsMorphType>;
  depth: number;
  maxLength: number;
};

@Injectable()
export class NestGraphInspectorSetup implements OnModuleInit {
  private readonly logger = new Logger(NestGraphInspectorSetup.name);
  private readonly outputAdapters: Record<
    NestGraphInspectorOutput["type"],
    OutputAdapter
  >;
  private graphOutput: GraphOutput | undefined;
  private readonly directRunParameterTypes = new WeakMap<
    (...args: unknown[]) => unknown,
    string
  >();
  private directRunProviderInstances:
    | { tree: ModuleTree; modules: Map<string, Map<string, unknown>> }
    | undefined;

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: NestGraphInspectorModuleOptions,
    private readonly modulesContainer: ModulesContainer,
    private readonly discovery: DiscoveryAdapter,
    private readonly httpOutputAdapter: HttpOutputAdapter,
    private readonly fileOutputAdapter: FileOutputAdapter,
    private readonly jsonOutputAdapter: JsonOutputAdapter,
    private readonly viewerOutputAdapter: ViewerOutputAdapter,
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
    private readonly sourceMetadata: SourceMetadataService,
  ) {
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

  private getGraphOutput(): GraphOutput {
    if (!this.graphOutput) {
      this.graphOutput = this.createGraphOutput(
        this.createModuleMapFromTree(this.discovery.scan()),
      );
    }

    return this.graphOutput;
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

  private createGraphOutput(moduleMap: ModuleMap): GraphOutput {
    return this.enrichModuleMap(moduleMap);
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
  ): NestGraphInspectorOutput {
    if (output.type !== "viewer") {
      return output;
    }

    const defaultViewerOutput = defaultOptions.outputs?.find(
      (defaultOutput) => defaultOutput.type === "viewer",
    );
    if (!defaultViewerOutput || defaultViewerOutput.type !== "viewer") {
      return output;
    }

    return {
      ...output,
      ollama: {
        ...defaultViewerOutput.ollama,
        ...output.ollama,
      },
      directRun: this.mergeViewerDirectRunOptions(
        defaultViewerOutput.directRun,
        output.directRun,
      ),
    };
  }

  private mergeViewerDirectRunOptions(
    defaultOptions?: NestGraphInspectorViewerDirectRunOptions,
    outputOptions?: NestGraphInspectorViewerDirectRunOptions,
  ) {
    const path = outputOptions?.path ?? defaultOptions?.path;
    if (!path) {
      return undefined;
    }

    return {
      path,
      historyDirPath: this.getDirectRunHistoryDirPath(),
      instanceLookup: (moduleName: string, providerName: string) =>
        this.findDirectRunProviderInstance(moduleName, providerName),
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

  buildModuleMapFromAutoDetect(): ModuleMap {
    const discovery = this.options.rootModule
      ? this.createDiscovery({ ...this.options, rootModule: undefined })
      : this.discovery;

    return this.createModuleMapFromTree(discovery.scan());
  }

  buildModuleMap(rootModuleClass: Type<unknown>): ModuleMap {
    const discovery =
      this.options.rootModule === rootModuleClass
        ? this.discovery
        : this.createDiscovery({
            ...this.options,
            rootModule: rootModuleClass,
          });

    return this.createModuleMapFromTree(discovery.scan());
  }

  private createDiscovery(
    options: NestGraphInspectorModuleOptions,
  ): DiscoveryAdapter {
    return new DiscoveryAdapter(
      options,
      this.modulesContainer,
      this.runtimeTraceRecorder,
      this.sourceMetadata,
    );
  }

  private createModuleMapFromTree(moduleTree: ModuleTree): ModuleMap {
    return {
      version: "3",
      root: moduleTree.name,
      modules: this.flattenModuleTree(moduleTree),
    };
  }

  private flattenModuleTree(moduleTree: ModuleTree): Record<string, Modules> {
    const modules: Record<string, Modules> = {};
    const visit = (node: ModuleTree): void => {
      if (!modules[node.name]) {
        modules[node.name] = {
          ...(node.jsdoc ? { jsdoc: node.jsdoc } : {}),
          imports: node.imports,
          exports: node.exports,
          providers: node.providers,
          controllers: node.controllers,
        };
      }

      for (const child of node.children) {
        visit(child);
      }
    };

    visit(moduleTree);
    return modules;
  }

  private enrichModuleMap(moduleMap: ModuleMap): GraphOutput {
    if (!moduleMap.modules) {
      return moduleMap as unknown as GraphOutput;
    }

    const enrichedModules: Record<string, GraphOutputModule> = {};

    for (const [moduleName, moduleData] of Object.entries(moduleMap.modules)) {
      enrichedModules[moduleName] = {
        ...moduleData,
        providers: moduleData.providers.map((provider) => ({
          ...provider,
          dependencies: provider.dependencies.map((dep) =>
            this.enrichDependency(dep, moduleName),
          ),
          directRun: this.resolveDirectRunProviderMeta(
            provider.name,
            moduleName,
          ),
        })),
        controllers: moduleData.controllers.map((controller) => ({
          ...controller,
          dependencies: controller.dependencies.map((dep) =>
            this.enrichDependency(dep, moduleName),
          ),
        })),
      };
    }

    return {
      ...moduleMap,
      modules: enrichedModules,
      cycles: this.findGraphCycles(enrichedModules),
    };
  }

  private resolveDirectRunProviderMeta(
    providerName: string,
    moduleName: string,
  ): DirectRunProviderMeta | undefined {
    const instance = this.findDirectRunProviderInstance(
      moduleName,
      providerName,
    );
    if (!instance) {
      return undefined;
    }

    const methods = this.getDirectRunMethods(instance);
    if (!methods.length) {
      return undefined;
    }

    return {
      methods,
    };
  }

  private findDirectRunProviderInstance(
    moduleName: string,
    providerName: string,
  ): unknown {
    const moduleInstances =
      this.getDirectRunProviderInstances().get(moduleName);
    return moduleInstances?.get(providerName);
  }

  private getDirectRunProviderInstances(): Map<string, Map<string, unknown>> {
    const tree = this.discovery.scan();
    if (this.directRunProviderInstances?.tree === tree) {
      return this.directRunProviderInstances.modules;
    }

    const modules = new Map<string, Map<string, unknown>>();
    const visit = (node: ModuleTree): void => {
      // The previous depth-first lookup returned the first module occurrence.
      if (!modules.has(node.name)) {
        modules.set(node.name, node.providerInstances);
      }

      for (const child of node.children) {
        visit(child);
      }
    };
    visit(tree);

    this.directRunProviderInstances = { tree, modules };
    return modules;
  }

  private getDirectRunMethods(instance: unknown): DirectRunProviderMethod[] {
    if (
      !instance ||
      (typeof instance !== "object" && typeof instance !== "function")
    ) {
      return [];
    }

    const prototype = Object.getPrototypeOf(instance) as Record<
      string,
      unknown
    > | null;
    if (!prototype || prototype === Object.prototype) {
      return [];
    }

    const methods = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== "constructor")
      .map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const method = descriptor?.value;
        if (typeof method !== "function") {
          return null;
        }

        const callable = method as (...args: unknown[]) => unknown;
        const parameterTypes = this.getDirectRunMethodParameterTypes({
          instance,
          method: callable,
          methodName: name,
        });

        return {
          name,
          parameterTypes,
        };
      })
      .filter((method): method is DirectRunProviderMethod => method !== null)
      .sort((left, right) => left.name.localeCompare(right.name));

    return [
      ...new Map(methods.map((method) => [method.name, method])).values(),
    ];
  }

  private getDirectRunMethodParameterTypes(param: {
    instance: object | ((...args: unknown[]) => unknown);
    method: (...args: unknown[]) => unknown;
    methodName: string;
  }): string {
    const { instance, method, methodName } = param;
    const cachedParameterTypes = this.directRunParameterTypes.get(method);
    if (cachedParameterTypes) {
      return cachedParameterTypes;
    }

    const className =
      typeof instance === "function"
        ? instance.name
        : instance.constructor?.name;
    const sourceTypes = className
      ? this.extractMethodParameterTypesFromProject(className, methodName)
      : undefined;
    const parameterTypes =
      sourceTypes ?? this.runtimeParameterTypes(methodName, method);
    this.directRunParameterTypes.set(method, parameterTypes);

    return parameterTypes;
  }

  private runtimeParameterTypes(
    methodName: string,
    method: (...args: unknown[]) => unknown,
  ): string {
    const runtimeNames = this.extractMethodParameterNamesFromFunctionSource(
      methodName,
      method,
    );
    if (!runtimeNames?.length) {
      return "[]";
    }

    return `[${runtimeNames.map((name) => `${name}: unknown`).join(", ")}]`;
  }

  private extractMethodParameterTypesFromProject(
    className: string,
    methodName: string,
  ): string | undefined {
    const method = this.sourceMetadata.getInstanceMethod(className, methodName);
    if (!method) {
      return undefined;
    }

    const parameters = method.getParameters();
    return `[${parameters
      .map(
        (parameter) =>
          `${parameter.getName()}: ${this.typeToTypeScriptCode(parameter.getType(), parameter)}`,
      )
      .join(", ")}]`;
  }

  private extractMethodParameterNamesFromFunctionSource(
    methodName: string,
    method: (...args: unknown[]) => unknown,
  ): string[] | undefined {
    const methodSource = method.toString().trim();
    const project = new Project({ useInMemoryFileSystem: true });

    try {
      const sourceFile = project.createSourceFile(
        "direct-run-method.ts",
        `class DirectRunMethodSource { ${methodSource} }`,
      );

      const names = sourceFile
        .getClassOrThrow("DirectRunMethodSource")
        .getInstanceMethod(methodName)
        ?.getParameters()
        .map((parameter) => parameter.getName());
      if (names) {
        return names;
      }
    } catch {
      // Runtime function strings are best-effort metadata only.
    }

    try {
      const sourceFile = project.createSourceFile(
        "direct-run-function.ts",
        `const directRunMethod = ${methodSource};`,
      );
      const initializer = sourceFile
        .getVariableDeclarationOrThrow("directRunMethod")
        .getInitializer();
      const callable =
        initializer?.asKind(SyntaxKind.FunctionExpression) ??
        initializer?.asKind(SyntaxKind.ArrowFunction);

      return callable?.getParameters().map((parameter) => parameter.getName());
    } catch {
      return undefined;
    }
  }

  private typeToTypeScriptCode(
    type: TsMorphType,
    enclosingNode: Node,
    state: TypeRenderState = {
      activeTypes: new Set<TsMorphType>(),
      depth: 0,
      maxLength: MAX_TYPE_RENDER_LENGTH,
    },
  ): string {
    if (type.isAny() || type.isUnknown()) {
      return "unknown";
    }

    if (type.isNever()) {
      return "never";
    }

    if (type.isUndefined()) {
      return "undefined";
    }

    if (type.isVoid()) {
      return "void";
    }

    if (type.isString()) {
      return "string";
    }

    if (type.isNumber()) {
      return "number";
    }

    if (type.isBoolean()) {
      return "boolean";
    }

    if (type.isNull()) {
      return "null";
    }

    if (type.isStringLiteral()) {
      const literalValue = type.getLiteralValue();
      if (
        typeof literalValue !== "string" ||
        literalValue.length > Math.floor(state.maxLength / 6)
      ) {
        return "string";
      }

      const literal = JSON.stringify(literalValue);
      return literal.length <= state.maxLength ? literal : "string";
    }

    if (type.isNumberLiteral()) {
      // getLiteralValue() is typed to also return ts.PseudoBigInt, which would
      // stringify to "[object Object]" — narrow to number before formatting.
      const literalValue = type.getLiteralValue();
      const literal =
        typeof literalValue === "number" ? String(literalValue) : "number";
      return literal.length <= state.maxLength ? literal : "number";
    }

    if (type.isBooleanLiteral()) {
      return this.typeTextWithinLimit(type, enclosingNode, state.maxLength);
    }

    const isArray = type.isArray() || type.isReadonlyArray();
    const isComposite =
      type.isUnion() || type.isTuple() || isArray || type.isObject();

    if (!isComposite) {
      return (
        this.typeReferenceCode(type) ??
        this.typeTextWithinLimit(type, enclosingNode, state.maxLength)
      );
    }

    if (state.activeTypes.has(type) || state.depth >= MAX_TYPE_RENDER_DEPTH) {
      return this.typeReferenceCode(type) ?? "unknown";
    }

    state.activeTypes.add(type);
    try {
      if (type.isUnion()) {
        const unionTypes = type.getUnionTypes();
        if (unionTypes.length > MAX_TYPE_RENDER_MEMBERS) {
          return "unknown";
        }

        return this.renderTypeSequence({
          types: unionTypes,
          enclosingNode,
          state,
          prefix: "",
          delimiter: " | ",
          suffix: "",
          fallback: "unknown",
        });
      }

      if (type.isTuple()) {
        const tupleTypes = type.getTupleElements();
        if (tupleTypes.length > MAX_TYPE_RENDER_MEMBERS) {
          return this.typeFallback(state.maxLength, "unknown[]");
        }

        return this.renderTypeSequence({
          types: tupleTypes,
          enclosingNode,
          state,
          prefix: "[",
          delimiter: ", ",
          suffix: "]",
          fallback: "unknown[]",
        });
      }

      if (isArray) {
        if (state.maxLength < MIN_TYPE_RENDER_LENGTH + 4) {
          return this.typeFallback(state.maxLength, "unknown[]");
        }

        const itemType = this.typeToTypeScriptCode(
          type.getArrayElementType() ?? type,
          enclosingNode,
          {
            ...state,
            depth: state.depth + 1,
            maxLength: state.maxLength - 4,
          },
        );

        return `${this.wrapArrayItemType(itemType)}[]`;
      }

      if (type.getCallSignatures().length > 0) {
        return (
          this.typeReferenceCode(type) ??
          this.typeTextWithinLimit(type, enclosingNode, state.maxLength)
        );
      }

      const properties = type.getProperties();
      if (properties.length === 0) {
        return (
          this.typeReferenceCode(type) ??
          this.typeTextWithinLimit(type, enclosingNode, state.maxLength)
        );
      }

      return this.renderObjectType(properties, enclosingNode, state);
    } finally {
      state.activeTypes.delete(type);
    }
  }

  private renderTypeSequence(param: {
    types: TsMorphType[];
    enclosingNode: Node;
    state: TypeRenderState;
    prefix: string;
    delimiter: string;
    suffix: string;
    fallback: string;
  }): string {
    const { types, enclosingNode, state, prefix, delimiter, suffix, fallback } =
      param;
    let output = prefix;

    for (let index = 0; index < types.length; index += 1) {
      const remainingTypes = types.length - index - 1;
      const separator = index === 0 ? "" : delimiter;
      const childMaxLength =
        state.maxLength -
        output.length -
        separator.length -
        suffix.length -
        remainingTypes * (delimiter.length + MIN_TYPE_RENDER_LENGTH);
      if (childMaxLength < MIN_TYPE_RENDER_LENGTH) {
        return this.typeFallback(state.maxLength, fallback);
      }

      output += `${separator}${this.typeToTypeScriptCode(
        types[index],
        enclosingNode,
        {
          ...state,
          depth: state.depth + 1,
          maxLength: childMaxLength,
        },
      )}`;
    }

    return `${output}${suffix}`;
  }

  private renderObjectType(
    properties: ReturnType<TsMorphType["getProperties"]>,
    enclosingNode: Node,
    state: TypeRenderState,
  ): string {
    const maxProperties = Math.min(properties.length, MAX_TYPE_RENDER_MEMBERS);
    const truncation = "[key: string]: unknown";
    const propertyCodes: string[] = [];
    let propertyCodesLength = 0;
    let truncated = properties.length > maxProperties;

    for (let index = 0; index < maxProperties; index += 1) {
      const property = properties[index];
      const propertyName = property.getName();
      if (propertyName.length > MAX_TYPE_PROPERTY_NAME_LENGTH) {
        truncated = true;
        break;
      }

      const propertyNode =
        property.getValueDeclaration() ?? property.getDeclarations()[0];
      const propertyType = property.getTypeAtLocation(
        propertyNode ?? enclosingNode,
      );
      const optional =
        property.isOptional() || this.typeAllowsUndefined(propertyType);
      const propertyPrefix = `${this.propertyNameToTypeScriptCode(propertyName)}${optional ? "?" : ""}: `;
      const separator = propertyCodes.length === 0 ? "" : "; ";
      const reservedTruncationLength =
        2 + (propertyCodes.length === 0 ? 0 : 2) + truncation.length;
      const childMaxLength =
        state.maxLength -
        2 -
        propertyCodesLength -
        separator.length -
        propertyPrefix.length -
        reservedTruncationLength;
      if (childMaxLength < MIN_TYPE_RENDER_LENGTH) {
        truncated = true;
        break;
      }

      const propertyCode = `${propertyPrefix}${this.typeToTypeScriptCode(
        propertyType,
        propertyNode ?? enclosingNode,
        {
          ...state,
          depth: state.depth + 1,
          maxLength: childMaxLength,
        },
      )}`;
      propertyCodes.push(propertyCode);
      propertyCodesLength += separator.length + propertyCode.length;
    }

    if (truncated) {
      const separator = propertyCodes.length === 0 ? "" : "; ";
      const output = `{ ${propertyCodes.join("; ")}${separator}${truncation} }`;
      return output.length <= state.maxLength
        ? output
        : this.typeFallback(state.maxLength, "unknown");
    }

    const output = `{ ${propertyCodes.join("; ")} }`;
    return output.length <= state.maxLength
      ? output
      : this.typeFallback(state.maxLength, "unknown");
  }

  private typeReferenceCode(type: TsMorphType): string | undefined {
    const name =
      type.getAliasSymbol()?.getName() ?? type.getSymbol()?.getName();
    return name && !name.startsWith("__") && /^[A-Za-z_$][\w$]*$/.test(name)
      ? name
      : undefined;
  }

  private typeTextWithinLimit(
    type: TsMorphType,
    enclosingNode: Node,
    maxLength: number,
  ): string {
    try {
      const typeText = type.getText(enclosingNode);
      return typeText.length <= maxLength ? typeText : "unknown";
    } catch {
      return "unknown";
    }
  }

  private typeFallback(maxLength: number, preferred: string): string {
    return preferred.length <= maxLength ? preferred : "unknown";
  }

  private wrapArrayItemType(typeText: string): string {
    return typeText.includes(" | ") || typeText.includes("&")
      ? `(${typeText})`
      : typeText;
  }

  private propertyNameToTypeScriptCode(name: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  }

  private typeAllowsUndefined(type: TsMorphType): boolean {
    return (
      type.isUndefined() ||
      (type.isUnion() &&
        type.getUnionTypes().some((unionType) => unionType.isUndefined()))
    );
  }

  private findGraphCycles(
    modules: Record<string, GraphOutputModule>,
  ): GraphOutputCycles {
    let nextId = 1;
    const nextCycleId: NextCycleId = () => nextId++;

    return {
      modules: this.findModuleCycles(modules, nextCycleId),
      ...this.findDependencyCycles(modules, nextCycleId),
    };
  }

  private findModuleCycles(
    modules: Record<string, GraphOutputModule>,
    nextCycleId: NextCycleId,
  ): GraphOutputCycle[] {
    const graph = this.createGraph(Object.keys(modules));

    for (const [moduleName, moduleData] of Object.entries(modules)) {
      for (const importedModuleName of moduleData.imports) {
        if (modules[importedModuleName]) {
          graph.get(moduleName)?.add(importedModuleName);
        }
      }
    }

    return this.findCycles(graph, nextCycleId);
  }

  private findDependencyCycles(
    modules: Record<string, GraphOutputModule>,
    nextCycleId: NextCycleId,
  ): Pick<GraphOutputCycles, "providers" | "controllers"> {
    const nodes = new Map<string, DependencyNode>();

    for (const [moduleName, moduleData] of Object.entries(modules)) {
      for (const provider of moduleData.providers) {
        const key = this.dependencyNodeKey(moduleName, provider.name);
        nodes.set(key, {
          key,
          kind: "provider",
          moduleName,
          name: provider.name,
        });
      }

      for (const controller of moduleData.controllers) {
        const key = this.dependencyNodeKey(moduleName, controller.name);
        nodes.set(key, {
          key,
          kind: "controller",
          moduleName,
          name: controller.name,
        });
      }
    }

    const graph = this.createGraph([...nodes.keys()]);

    for (const [moduleName, moduleData] of Object.entries(modules)) {
      for (const provider of moduleData.providers) {
        this.addDependencyEdges(
          graph,
          this.dependencyNodeKey(moduleName, provider.name),
          provider.dependencies,
          nodes,
        );
      }

      for (const controller of moduleData.controllers) {
        this.addDependencyEdges(
          graph,
          this.dependencyNodeKey(moduleName, controller.name),
          controller.dependencies,
          nodes,
        );
      }
    }

    const cycles = this.findCycles(graph, nextCycleId);

    return {
      providers: cycles
        .filter((cycle) => nodes.get(cycle.from)?.kind === "provider")
        .map((cycle) => this.toProviderCycle(cycle, nodes)),
      controllers: cycles.filter(
        (cycle) => nodes.get(cycle.from)?.kind === "controller",
      ),
    };
  }

  private addDependencyEdges(
    graph: Map<string, Set<string>>,
    sourceKey: string,
    dependencies: GraphOutputDependencyRef[],
    nodes: Map<string, DependencyNode>,
  ): void {
    const sourceEdges = graph.get(sourceKey);
    if (!sourceEdges) {
      return;
    }

    for (const dependency of dependencies) {
      const targetKey = this.dependencyNodeKey(
        dependency.providedBy.name,
        dependency.token,
      );

      if (nodes.has(targetKey)) {
        sourceEdges.add(targetKey);
      }
    }
  }

  private createGraph(keys: string[]): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();

    for (const key of keys) {
      graph.set(key, new Set<string>());
    }

    return graph;
  }

  private findCycles(
    graph: Map<string, Set<string>>,
    nextCycleId: NextCycleId,
  ): GraphOutputCycle[] {
    const cycles: GraphOutputCycle[] = [];
    const seenCycleKeys = new Set<string>();
    const reachableKeys = new Map<string, Set<string>>();

    for (const source of graph.keys()) {
      reachableKeys.set(source, this.findReachableKeys(source, graph));
    }

    for (const [source, targets] of graph) {
      for (const target of targets) {
        if (source !== target && !reachableKeys.get(target)?.has(source)) {
          continue;
        }

        const path =
          source === target
            ? [source, source]
            : [source, ...this.findPath(target, source, graph)];
        const cycleKey = this.getCanonicalCycleKey(path);

        if (seenCycleKeys.has(cycleKey)) {
          continue;
        }

        seenCycleKeys.add(cycleKey);

        cycles.push({
          id: nextCycleId(),
          from: source,
          to: target,
          type: this.getCycleType(source, target, graph),
          path,
        });
      }
    }

    return cycles;
  }

  private getCanonicalCycleKey(path: string[]): string {
    const cyclePath = path.slice(0, -1);

    if (cyclePath.length <= 1) {
      return cyclePath.join("->");
    }

    const rotations = cyclePath.map((_, index) => [
      ...cyclePath.slice(index),
      ...cyclePath.slice(0, index),
    ]);

    return rotations
      .map((rotation) => rotation.join("->"))
      .sort((a, b) => a.localeCompare(b))[0];
  }

  private toProviderCycle(
    cycle: GraphOutputCycle,
    nodes: Map<string, DependencyNode>,
  ): GraphOutputProviderCycle {
    return {
      ...cycle,
      path: cycle.path.map((key) => this.toProviderCyclePathItem(key, nodes)),
    };
  }

  private toProviderCyclePathItem(
    key: string,
    nodes: Map<string, DependencyNode>,
  ): GraphOutputProviderCyclePathItem {
    const node = nodes.get(key);
    if (node) {
      return {
        module: { name: node.moduleName },
        provider: { name: node.name },
      };
    }

    const separatorIndex = key.indexOf(":");
    if (separatorIndex === -1) {
      return {
        module: { name: "" },
        provider: { name: key },
      };
    }

    return {
      module: { name: key.slice(0, separatorIndex) },
      provider: { name: key.slice(separatorIndex + 1) },
    };
  }

  private getCycleType(
    source: string,
    target: string,
    graph: Map<string, Set<string>>,
  ): GraphOutputCycleType {
    if (source === target || graph.get(target)?.has(source)) {
      return "direct";
    }

    return "indirect";
  }

  private findPath(
    source: string,
    target: string,
    graph: Map<string, Set<string>>,
  ): string[] {
    const visited = new Set<string>();
    const pendingPaths = [[source]];

    while (pendingPaths.length > 0) {
      const currentPath = pendingPaths.shift();
      const current = currentPath?.[currentPath.length - 1];

      if (!currentPath || !current || visited.has(current)) {
        continue;
      }

      if (current === target) {
        return currentPath;
      }

      visited.add(current);

      for (const next of graph.get(current) ?? []) {
        pendingPaths.push([...currentPath, next]);
      }
    }

    return [source, target];
  }

  private findReachableKeys(
    source: string,
    graph: Map<string, Set<string>>,
  ): Set<string> {
    const reachableKeys = new Set<string>();
    const pendingKeys = [...(graph.get(source) ?? [])];

    while (pendingKeys.length > 0) {
      const currentKey = pendingKeys.pop();

      if (!currentKey || reachableKeys.has(currentKey)) {
        continue;
      }

      reachableKeys.add(currentKey);

      for (const nextKey of graph.get(currentKey) ?? []) {
        pendingKeys.push(nextKey);
      }
    }

    return reachableKeys;
  }

  private dependencyNodeKey(
    moduleName: string,
    dependencyName: string,
  ): string {
    return `${moduleName}:${dependencyName}`;
  }

  private enrichDependency(
    dependency: string,
    currentModule: string,
  ): GraphOutputDependencyRef {
    const colonIndex = dependency.indexOf(":");

    if (colonIndex !== -1) {
      return {
        providedBy: {
          type: "module",
          name: dependency.substring(0, colonIndex),
        },
        token: dependency.substring(colonIndex + 1),
      };
    }

    return {
      providedBy: { type: "module", name: currentModule },
      token: dependency,
    };
  }
}
