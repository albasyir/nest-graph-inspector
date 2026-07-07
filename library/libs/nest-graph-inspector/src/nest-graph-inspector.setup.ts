import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnModuleInit, Type } from '@nestjs/common';
import type {
  InjectionToken,
  OptionalFactoryDependency,
} from '@nestjs/common/interfaces';
import { ModulesContainer } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import type { Module } from '@nestjs/core/injector/module';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import type {
  NestGraphInspectorModuleOptions,
  NestGraphInspectorOutput,
} from './nest-graph-inspector.type';
import {
  defaultOptions,
  NestGraphInspectorModule,
} from './nest-graph-inspector.module';
import { ModuleController } from './types/module-controller.type';
import { ModuleProvider } from './types/module-provider.type';
import { Modules } from './types/module.type';
import { ModuleMap } from './types/module-map.type';
import type {
  DirectRunProviderMeta,
  DirectRunProviderMethod,
  RuntimeTraceSpanType,
} from './types/direct-run.type';
import type {
  GraphOutput,
  GraphOutputCycle,
  GraphOutputCycles,
  GraphOutputCycleType,
  GraphOutputDependencyRef,
  GraphOutputModule,
  GraphOutputProviderCycle,
  GraphOutputProviderCyclePathItem,
  GraphOutputProvider,
} from './types/graph-output.type';
import { HttpOutputAdapter } from './adapters/http-output.adapter';
import { FileOutputAdapter } from './adapters/file-output.adapter';
import { JsonOutputAdapter } from './adapters/json-output.adapter';
import { ViewerOutputAdapter } from './adapters/viewer-output.adapter';
import { OutputAdapter } from './ports/output.adapter';
import { Node, Project, SyntaxKind, Type as TsMorphType } from 'ts-morph';
import type { NestGraphInspectorViewerDirectRunOptions } from './nest-graph-inspector.type';
import { RuntimeTraceRecorder } from './runtime-trace.recorder';

type DependencyNodeKind = 'provider' | 'controller';
type DependencyNode = {
  key: string;
  kind: DependencyNodeKind;
  moduleName: string;
  name: string;
};
type NextCycleId = () => number;
type ModuleTree = {
  name: string;
  jsdoc?: string;
  moduleRef: Module | null;
  imports: string[];
  exports: string[];
  providers: ModuleProvider[];
  controllers: ModuleController[];
  children: ModuleTree[];
};

@Injectable()
export class NestGraphInspectorSetup implements OnModuleInit {
  private readonly logger = new Logger(NestGraphInspectorSetup.name);
  private readonly outputAdapters: Record<
    NestGraphInspectorOutput['type'],
    OutputAdapter
  >;
  private readonly ignoreProvider: string[];
  private readonly ignoreImport: string[];
  private readonly nestCoreModuleName: string;
  private readonly nestCoreProviders: string[];
  private readonly tsMorphProject = this.createTsMorphProject();
  private readonly runtimeTraceInstrumentedInstances = new WeakSet<object>();

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: NestGraphInspectorModuleOptions,
    private readonly modulesContainer: ModulesContainer,
    private readonly httpOutputAdapter: HttpOutputAdapter,
    private readonly fileOutputAdapter: FileOutputAdapter,
    private readonly jsonOutputAdapter: JsonOutputAdapter,
    private readonly viewerOutputAdapter: ViewerOutputAdapter,
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
  ) {
    this.outputAdapters = {
      http: this.httpOutputAdapter,
      markdown: this.fileOutputAdapter,
      json: this.jsonOutputAdapter,
      viewer: this.viewerOutputAdapter,
    };
    this.ignoreProvider = [
      ...(this.options.ignoreProvider ?? defaultOptions.ignoreProvider ?? []),
    ];
    this.ignoreImport = [
      ...(this.options.ignoreImport ?? defaultOptions.ignoreImport ?? []),
    ];
    this.nestCoreModuleName =
      this.options.nestCoreModuleName ??
      defaultOptions.nestCoreModuleName ??
      'NestJSCoreModule';
    this.nestCoreProviders = [
      ...(this.options.nestCoreProviders ??
        defaultOptions.nestCoreProviders ??
        []),
    ];
  }

  async onModuleInit(): Promise<void> {
    await this.inspectAndPublishGraph();
  }

  private async inspectAndPublishGraph(): Promise<void> {
    if (!this.hasOutput) {
      return;
    }

    const rootModule = this.getRootModule();
    const moduleTree = this.getModuleTree(rootModule);

    await this.publishModuleTree(moduleTree);
  }

  private get hasOutput(): boolean {
    return !!this.options.outputs?.length;
  }

  private getRootModule(): Module {
    const rootModuleClass = this.options.rootModule;

    return rootModuleClass
      ? this.getRootModuleFromClass(rootModuleClass)
      : this.findRootModule();
  }

  private getRootModuleFromClass(rootModuleClass: Type<unknown>): Module {
    const root = [...this.modulesContainer.values()].find(
      (m) => m.metatype === rootModuleClass,
    );

    if (!root) {
      throw new Error(`Root module not found: ${rootModuleClass.name}`);
    }

    return root;
  }

  private getModuleTree(rootModule: Module): ModuleTree {
    const moduleTree = this.resolveModuleTree(rootModule);
    this.resolveModuleMembers(moduleTree);
    this.instrumentRuntimeTrace(moduleTree);
    this.appendNestCoreModule(moduleTree);

    return moduleTree;
  }

  private async publishModuleTree(moduleTree: ModuleTree): Promise<void> {
    const moduleMap = this.createModuleMapFromModuleTree(moduleTree);
    const graphOutput = this.createGraphOutput(moduleMap);
    const outputs = this.prepareOutputs();

    await this.publishOutputs({ graphOutput, outputs });
  }

  private createGraphOutput(moduleMap: ModuleMap): GraphOutput {
    return this.enrichModuleMap(moduleMap);
  }

  private prepareOutputs(): NestGraphInspectorOutput[] {
    return this.options.outputs ?? [];
  }

  private async publishOutputs(param: {
    graphOutput: GraphOutput;
    outputs: NestGraphInspectorOutput[];
  }): Promise<void> {
    await Promise.all(
      param.outputs.map(async (output) => {
        await this.publishSingleOutput(param.graphOutput, output);
      }),
    );
  }

  private async publishSingleOutput(
    graphOutput: GraphOutput,
    output: NestGraphInspectorOutput,
  ): Promise<void> {
    output = this.withDefaultOutputOptions(output);
    const adapter = this.outputAdapters[output.type];
    if (!adapter) {
      this.logger.warn(`Unsupported output type: ${output.type}`);
      return;
    }

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
    if (output.type !== 'viewer') {
      return output;
    }

    const defaultViewerOutput = defaultOptions.outputs?.find(
      (defaultOutput) => defaultOutput.type === 'viewer',
    );

    if (!defaultViewerOutput || defaultViewerOutput.type !== 'viewer') {
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
      instanceLookup: (moduleName: string, providerName: string) =>
        this.findDirectRunProviderInstance(moduleName, providerName),
    };
  }

  buildModuleMapFromAutoDetect(): ModuleMap {
    const root = this.findRootModule();
    const moduleTree = this.getModuleTree(root);
    return this.createModuleMapFromModuleTree(moduleTree);
  }

  buildModuleMap(rootModuleClass: Type<unknown>): ModuleMap {
    const root = this.getRootModuleFromClass(rootModuleClass);
    const moduleTree = this.getModuleTree(root);
    return this.createModuleMapFromModuleTree(moduleTree);
  }

  private createModuleMapFromModuleTree(moduleTree: ModuleTree): ModuleMap {
    const modules = this.flattenModuleTree(moduleTree);

    return {
      version: '3',
      root: moduleTree.name,
      modules,
    };
  }

  /**
   * Auto-detect the root module by finding which module imports NestGraphInspectorModule.
   */
  private findRootModule(): Module {
    for (const moduleRef of this.modulesContainer.values()) {
      const moduleName = this.moduleName(moduleRef);

      if (
        this.ignoreImport.includes(moduleName) ||
        moduleName === 'InternalCoreModule'
      ) {
        continue;
      }

      for (const importedModule of moduleRef.imports.values()) {
        if (importedModule.metatype === NestGraphInspectorModule) {
          return moduleRef;
        }
      }
    }

    throw new Error(
      'Could not auto-detect root module. No module imports NestGraphInspectorModule.',
    );
  }

  private resolveModuleTree(
    moduleRef: Module,
    visited = new Set<Module>(),
  ): ModuleTree {
    if (visited.has(moduleRef)) {
      return this.createModuleTreeReference(moduleRef);
    }

    visited.add(moduleRef);

    return {
      name: this.moduleName(moduleRef),
      jsdoc: this.extractModuleJsDoc(moduleRef),
      moduleRef,
      imports: [],
      exports: [],
      providers: [],
      controllers: [],
      children: [...moduleRef.imports.values()]
        .filter((childModule) => !this.shouldIgnoreModule(childModule))
        .map((childModule) => this.resolveModuleTree(childModule, visited)),
    };
  }

  private createModuleTreeReference(moduleRef: Module): ModuleTree {
    return {
      name: this.moduleName(moduleRef),
      jsdoc: this.extractModuleJsDoc(moduleRef),
      moduleRef,
      imports: [],
      exports: [],
      providers: [],
      controllers: [],
      children: [],
    };
  }

  private resolveModuleMembers(moduleTree: ModuleTree): void {
    this.walkModuleTree(moduleTree, (node) => {
      if (!node.moduleRef) {
        return;
      }

      node.imports = node.children.map((child) => child.name);
      node.exports = this.extractExports(node.moduleRef);
      node.providers = this.extractProviders(node.moduleRef, node.name);
      node.controllers = this.extractControllers(node.moduleRef, node.name);
    });
  }

  private instrumentRuntimeTrace(moduleTree: ModuleTree): void {
    this.walkModuleTree(moduleTree, (node) => {
      if (!node.moduleRef) {
        return;
      }

      this.instrumentRuntimeTraceWrappers({
        moduleName: node.name,
        type: 'provider',
        wrappers: node.moduleRef.providers.values(),
        shouldIgnore: (name) =>
          name === node.name || this.ignoreProvider.includes(name),
      });
      this.instrumentRuntimeTraceWrappers({
        moduleName: node.name,
        type: 'controller',
        wrappers: node.moduleRef.controllers.values(),
      });
    });
  }

  private instrumentRuntimeTraceWrappers(param: {
    moduleName: string;
    type: RuntimeTraceSpanType;
    wrappers: Iterable<InstanceWrapper<unknown>>;
    shouldIgnore?: (name: string) => boolean;
  }): void {
    for (const wrapper of param.wrappers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') {
        continue;
      }

      const className = this.wrapperClassName(wrapper);
      if (!className || param.shouldIgnore?.(className)) {
        continue;
      }

      this.instrumentRuntimeTraceInstance({
        instance,
        moduleName: param.moduleName,
        className,
        type: param.type,
      });
    }
  }

  private instrumentRuntimeTraceInstance(param: {
    instance: object;
    moduleName: string;
    className: string;
    type: RuntimeTraceSpanType;
  }): void {
    if (this.runtimeTraceInstrumentedInstances.has(param.instance)) {
      return;
    }

    this.runtimeTraceInstrumentedInstances.add(param.instance);

    const prototype = Object.getPrototypeOf(param.instance) as object | null;
    if (!prototype) {
      return;
    }

    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      if (methodName === 'constructor') {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
      const method = descriptor?.value;
      if (typeof method !== 'function') {
        continue;
      }

      Object.defineProperty(param.instance, methodName, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) =>
          this.runtimeTraceRecorder.recordSpan(
            {
              name: `${param.className}.${methodName}`,
              type: param.type,
              moduleName: param.moduleName,
              className: param.className,
              methodName,
            },
            () => method.apply(param.instance, args),
          ),
      });
    }
  }

  private appendNestCoreModule(moduleTree: ModuleTree): void {
    const usedProviders = this.findUsedNestCoreProvidersFromTree(moduleTree);

    if (!usedProviders.length) {
      return;
    }

    moduleTree.children.push({
      name: this.nestCoreModuleName,
      moduleRef: null,
      imports: [],
      exports: [...usedProviders],
      providers: usedProviders.map((name) => ({
        name,
        dependencies: [],
      })),
      controllers: [],
      children: [],
    });
  }

  private findUsedNestCoreProvidersFromTree(moduleTree: ModuleTree): string[] {
    const usedProviders = new Set<string>();

    this.walkModuleTree(moduleTree, (node) => {
      for (const provider of node.providers) {
        for (const dependencyName of provider.dependencies) {
          const nestCoreProviderName =
            this.extractNestCoreProviderName(dependencyName);

          if (nestCoreProviderName) {
            usedProviders.add(nestCoreProviderName);
          }
        }
      }

      for (const controller of node.controllers) {
        for (const dependencyName of controller.dependencies) {
          const nestCoreProviderName =
            this.extractNestCoreProviderName(dependencyName);

          if (nestCoreProviderName) {
            usedProviders.add(nestCoreProviderName);
          }
        }
      }
    });

    return this.nestCoreProviders.filter((providerName) =>
      usedProviders.has(providerName),
    );
  }

  private flattenModuleTree(moduleTree: ModuleTree): Record<string, Modules> {
    const modules: Record<string, Modules> = {};

    this.walkModuleTree(moduleTree, (node) => {
      if (modules[node.name] || this.ignoreImport.includes(node.name)) {
        return;
      }

      modules[node.name] = {
        ...(node.jsdoc ? { jsdoc: node.jsdoc } : {}),
        imports: node.imports,
        exports: node.exports,
        providers: node.providers,
        controllers: node.controllers,
      };
    });

    return modules;
  }

  private walkModuleTree(
    moduleTree: ModuleTree,
    visit: (node: ModuleTree) => void,
  ): void {
    visit(moduleTree);

    for (const child of moduleTree.children) {
      this.walkModuleTree(child, visit);
    }
  }

  private shouldIgnoreModule(moduleRef: Module): boolean {
    return this.ignoreImport.includes(this.moduleName(moduleRef));
  }

  private extractNestCoreProviderName(dependencyName: string): string | null {
    const prefix = `${this.nestCoreModuleName}:`;

    if (!dependencyName.startsWith(prefix)) {
      return null;
    }

    const providerName = dependencyName.slice(prefix.length);
    if (!providerName) {
      return null;
    }

    if (!this.nestCoreProviders.includes(providerName)) {
      return null;
    }

    return providerName;
  }

  private extractImports(moduleRef: Module): string[] {
    return [...moduleRef.imports.values()]
      .map((importedModuleRef) => this.moduleName(importedModuleRef))
      .filter((importName) => !this.ignoreImport.includes(importName));
  }

  private extractExports(moduleRef: Module): string[] {
    return [...moduleRef.exports.values()]
      .map((exportedItem) => this.exportName(exportedItem))
      .filter(
        (exportName): exportName is string =>
          !!exportName && !this.ignoreProvider.includes(exportName),
      );
  }

  private extractProviders(
    moduleRef: Module,
    moduleName: string,
  ): ModuleProvider[] {
    return this.extractModuleMembers<ModuleProvider>({
      wrappers: moduleRef.providers.values(),
      moduleRef,
      extract: (wrapper) =>
        this.extractModuleMember({
          wrapper,
          moduleRef,
          shouldIgnore: (name) => this.ignoreProvider.includes(name),
        }),
      shouldSkip: (provider) => provider.name === moduleName,
    });
  }

  private extractControllers(
    moduleRef: Module,
    moduleName: string,
  ): ModuleController[] {
    return this.extractModuleMembers<ModuleController>({
      wrappers: moduleRef.controllers.values(),
      moduleRef,
      extract: (wrapper) => this.extractModuleMember({ wrapper, moduleRef }),
    });
  }

  private extractModuleMembers<T extends { name: string }>(param: {
    wrappers: Iterable<InstanceWrapper<unknown>>;
    moduleRef: Module;
    extract: (wrapper: InstanceWrapper<object>, moduleRef: Module) => T | null;
    shouldSkip?: (item: T) => boolean;
  }): T[] {
    return [...param.wrappers].reduce<T[]>((items, wrapper) => {
      const executableWrapper = wrapper as InstanceWrapper<object>;
      const item = param.extract(executableWrapper, param.moduleRef);
      if (item) {
        if (param.shouldSkip?.(item)) {
          return items;
        }

        items.push(item);
      }

      return items;
    }, []);
  }

  private extractModuleMember(param: {
    wrapper: InstanceWrapper<object>;
    moduleRef: Module;
    shouldIgnore?: (name: string) => boolean;
  }): ModuleProvider | null {
    const { wrapper, moduleRef, shouldIgnore = () => false } = param;
    const name =
      this.wrapperClassName(wrapper) || this.tokenName(wrapper.token);

    if (!name || shouldIgnore(name)) {
      return null;
    }

    const jsdoc = this.extractClassJsDoc(wrapper);

    return {
      name,
      ...(jsdoc ? { jsdoc } : {}),
      dependencies: this.extractDependencies(wrapper, moduleRef),
    };
  }

  private createTsMorphProject(): Project {
    const tsConfigFilePath = join(process.cwd(), 'tsconfig.json');

    if (!existsSync(tsConfigFilePath)) {
      this.logger.warn(
        `Could not find tsconfig.json at ${tsConfigFilePath}; JSDoc metadata will be skipped.`,
      );
      return new Project();
    }

    return new Project({
      tsConfigFilePath,
      skipAddingFilesFromTsConfig: false,
    });
  }

  private extractModuleJsDoc(moduleRef: Module): string | undefined {
    return moduleRef.metatype
      ? this.extractClassJsDocByName(moduleRef.metatype.name)
      : undefined;
  }

  private extractClassJsDoc(
    wrapper: InstanceWrapper<unknown>,
  ): string | undefined {
    const className = this.wrapperClassName(wrapper);

    return className ? this.extractClassJsDocByName(className) : undefined;
  }

  private extractClassJsDocByName(className: string): string | undefined {
    const targetClass = this.tsMorphProject
      .getSourceFiles()
      .flatMap((sourceFile) => sourceFile.getClasses())
      .find((classDeclaration) => classDeclaration.getName() === className);

    return targetClass
      ?.getJsDocs()
      .map((doc) => doc.getCommentText())
      .filter((comment): comment is string => !!comment)
      .join('\n');
  }

  private wrapperClassName(wrapper: InstanceWrapper<unknown>): string | null {
    if (wrapper.metatype?.name) {
      return wrapper.metatype.name;
    }

    const instance = wrapper.instance;
    if (
      instance &&
      (typeof instance === 'object' || typeof instance === 'function')
    ) {
      return instance.constructor?.name ?? null;
    }

    return null;
  }

  private extractDependencies(
    wrapper: InstanceWrapper<unknown>,
    moduleRef: Module,
  ): string[] {
    const dependencies = new Set<string>();

    // Factory providers (useFactory with inject array)
    if (Array.isArray(wrapper?.inject)) {
      for (const token of wrapper.inject) {
        const dependencyName = this.resolveDependencyName(
          this.resolveInjectionToken(token),
          moduleRef,
        );
        if (dependencyName) {
          dependencies.add(dependencyName);
        }
      }
    }

    // Constructor-injected dependencies (resolved by NestJS with @Inject() overrides)
    const ctorDeps = wrapper.getCtorMetadata?.() ?? [];
    for (const depWrapper of ctorDeps) {
      if (depWrapper) {
        const dependencyName = this.resolveDependencyName(
          depWrapper.token,
          moduleRef,
        );
        if (dependencyName && dependencyName !== 'Object') {
          dependencies.add(dependencyName);
        }
      }
    }

    // Property-injected dependencies (@Inject() on class properties)
    const propertyDeps = wrapper.getPropertiesMetadata?.() ?? [];
    for (const propertyDep of propertyDeps) {
      const depWrapper = propertyDep?.wrapper;
      if (depWrapper) {
        const dependencyName = this.resolveDependencyName(
          depWrapper.token,
          moduleRef,
        );
        if (dependencyName && dependencyName !== 'Object') {
          dependencies.add(dependencyName);
        }
      }
    }

    return [...dependencies];
  }

  private resolveInjectionToken(
    token: InjectionToken | OptionalFactoryDependency,
  ): InjectionToken {
    if (typeof token === 'object' && token !== null && 'token' in token) {
      return token.token;
    }

    return token;
  }

  private resolveDependencyName(
    token: InjectionToken,
    moduleRef: Module,
  ): string | null {
    const tokenName = this.tokenName(token);
    if (!tokenName) {
      return null;
    }

    if (this.nestCoreProviders.includes(tokenName)) {
      return `${this.nestCoreModuleName}:${tokenName}`;
    }

    const ownProviderDependencyName = this.findProviderDependencyNameByToken(
      moduleRef,
      token,
      false,
    );

    if (ownProviderDependencyName) {
      return ownProviderDependencyName;
    }

    for (const importedModuleRef of moduleRef.imports.values()) {
      if (!this.isExportedProviderToken(importedModuleRef, token)) {
        continue;
      }

      const importedProviderDependencyName =
        this.findProviderDependencyNameByToken(importedModuleRef, token, true);

      if (importedProviderDependencyName) {
        return importedProviderDependencyName;
      }
    }

    return this.formatDependencyName(tokenName, moduleRef);
  }

  private findProviderDependencyNameByToken(
    moduleRef: Module,
    token: InjectionToken,
    includeModulePrefix: boolean,
  ): string | null {
    const moduleName = this.moduleName(moduleRef);

    for (const wrapper of moduleRef.providers.values()) {
      if (!this.isSameProviderToken(wrapper, token)) {
        continue;
      }

      const providerInstance =
        wrapper.instance &&
        (typeof wrapper.instance === 'object' ||
          typeof wrapper.instance === 'function')
          ? (wrapper.instance as { constructor?: { name?: string } })
          : null;
      const providerName =
        wrapper.metatype?.name ||
        providerInstance?.constructor?.name ||
        this.tokenName(wrapper.token);

      if (!providerName) {
        return null;
      }

      if (includeModulePrefix) {
        return `${moduleName}:${providerName}`;
      }

      return providerName;
    }

    return null;
  }

  private isSameProviderToken(
    wrapper: InstanceWrapper<unknown>,
    token: InjectionToken,
  ): boolean {
    if (wrapper?.token === token) {
      return true;
    }

    if (wrapper?.metatype === token) {
      return true;
    }

    if (
      wrapper.instance &&
      typeof wrapper.instance === 'object' &&
      wrapper.instance.constructor === token
    ) {
      return true;
    }

    return false;
  }

  private exportedNames(moduleRef: Module): Set<string> {
    return new Set(
      [...moduleRef.exports.values()]
        .map((exportedItem) => this.exportName(exportedItem))
        .filter((exportName): exportName is string => !!exportName),
    );
  }

  private exportName(exportedItem: InjectionToken): string | null {
    return this.tokenName(exportedItem);
  }

  private isExportedProviderToken(
    moduleRef: Module,
    token: InjectionToken,
  ): boolean {
    const tokenName = this.tokenName(token);

    for (const exportedItem of moduleRef.exports.values()) {
      if (exportedItem === token) {
        return true;
      }

      if (tokenName && this.exportName(exportedItem) === tokenName) {
        return true;
      }
    }

    return false;
  }

  private formatDependencyName(
    dependencyName: string,
    moduleRef: Module,
  ): string {
    if (this.nestCoreProviders.includes(dependencyName)) {
      return `${this.nestCoreModuleName}:${dependencyName}`;
    }

    for (const importedModuleRef of moduleRef.imports.values()) {
      const importedModuleName = this.moduleName(importedModuleRef);
      const exportedNames = this.exportedNames(importedModuleRef);

      if (exportedNames.has(dependencyName)) {
        return `${importedModuleName}:${dependencyName}`;
      }
    }

    return dependencyName;
  }

  private moduleName(moduleRef: Module): string {
    return (
      moduleRef.metatype?.name ||
      this.tokenName(moduleRef.token) ||
      'AnonymousModule'
    );
  }

  private tokenName(token: InjectionToken | null | undefined): string | null {
    if (!token) return null;
    if (typeof token === 'string') return token;
    if (typeof token === 'symbol') return token.toString();
    if (typeof token === 'function') return token.name;
    return null;
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
          directRun: this.resolveDirectRunProviderMeta(provider.name, moduleName),
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
    const instance = this.findDirectRunProviderInstance(moduleName, providerName);
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
    const moduleRef = [...this.modulesContainer.values()].find(
      candidate => this.moduleName(candidate) === moduleName,
    );
    if (!moduleRef) {
      return undefined;
    }

    const providerWrapper = [...moduleRef.providers.values()].find((wrapper) => {
      const instance =
        wrapper.instance &&
        (typeof wrapper.instance === 'object' || typeof wrapper.instance === 'function')
          ? (wrapper.instance as { constructor?: { name?: string } })
          : null;
      const resolvedName =
        wrapper.metatype?.name ||
        instance?.constructor?.name ||
        this.tokenName(wrapper.token);

      return resolvedName === providerName;
    });

    return providerWrapper?.instance;
  }

  private getDirectRunMethods(instance: unknown): DirectRunProviderMethod[] {
    if (!instance || (typeof instance !== 'object' && typeof instance !== 'function')) {
      return [];
    }

    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
    if (!prototype || prototype === Object.prototype) {
      return [];
    }

    const methods = Object.getOwnPropertyNames(prototype)
      .filter(name => name !== 'constructor')
      .map((name) => {
        const candidate = prototype[name];
        if (typeof candidate !== 'function') {
          return null;
        }

        const method = candidate as (...args: unknown[]) => unknown;
        const parameterTypes = this.getDirectRunMethodParameterTypes({
          instance,
          method,
          methodName: name,
        });

        return {
          name,
          parameterTypes,
        };
      })
      .filter((method): method is DirectRunProviderMethod => method !== null)
      .sort((left, right) => left.name.localeCompare(right.name));

    return [...new Map(methods.map(method => [method.name, method])).values()];
  }

  private getDirectRunMethodParameterTypes(param: {
    instance: object | ((...args: unknown[]) => unknown);
    method: (...args: unknown[]) => unknown;
    methodName: string;
  }): string {
    const { instance, method, methodName } = param;
    const className =
      typeof instance === 'function'
        ? instance.name
        : instance.constructor?.name;
    const sourceTypes = className
      ? this.extractMethodParameterTypesFromProject(className, methodName)
      : undefined;
    if (sourceTypes) {
      return sourceTypes;
    }

    const runtimeNames = this.extractMethodParameterNamesFromFunctionSource(
      methodName,
      method,
    );
    if (!runtimeNames?.length) {
      return '[]';
    }

    return `[${runtimeNames.map(name => `${name}: unknown`).join(', ')}]`;
  }

  private extractMethodParameterTypesFromProject(
    className: string,
    methodName: string,
  ): string | undefined {
    const targetClass = this.tsMorphProject
      .getSourceFiles()
      .flatMap(sourceFile =>
        sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration),
      )
      .find(classDeclaration => classDeclaration.getName() === className);

    const method = targetClass?.getInstanceMethod(methodName);
    if (!method) {
      return undefined;
    }

    const parameters = method.getParameters();
    return `[${parameters
      .map(parameter =>
        `${parameter.getName()}: ${this.typeToTypeScriptCode(parameter.getType(), parameter)}`,
      )
      .join(', ')}]`;
  }

  private extractMethodParameterNamesFromFunctionSource(
    methodName: string,
    method: (...args: unknown[]) => unknown,
  ): string[] | undefined {
    const methodSource = method.toString().trim();
    const project = new Project({ useInMemoryFileSystem: true });

    try {
      const sourceFile = project.createSourceFile(
        'direct-run-method.ts',
        `class DirectRunMethodSource { ${methodSource} }`,
      );

      const names = sourceFile
        .getClassOrThrow('DirectRunMethodSource')
        .getInstanceMethod(methodName)
        ?.getParameters()
        .map(parameter => parameter.getName());
      if (names) {
        return names;
      }
    } catch {
      // Runtime function strings are best-effort metadata only.
    }

    try {
      const sourceFile = project.createSourceFile(
        'direct-run-function.ts',
        `const directRunMethod = ${methodSource};`,
      );
      const initializer = sourceFile
        .getVariableDeclarationOrThrow('directRunMethod')
        .getInitializer();
      const callable =
        initializer?.asKind(SyntaxKind.FunctionExpression) ??
        initializer?.asKind(SyntaxKind.ArrowFunction);

      return callable?.getParameters().map(parameter => parameter.getName());
    } catch {
      return undefined;
    }
  }

  private typeToTypeScriptCode(
    type: TsMorphType,
    enclosingNode: Node,
    seenTypeTexts = new Set<string>(),
  ): string {
    if (
      type.isAny()
      || type.isUnknown()
    ) {
      return 'unknown';
    }

    if (type.isNever()) {
      return 'never';
    }

    if (type.isUndefined()) {
      return 'undefined';
    }

    if (type.isVoid()) {
      return 'void';
    }

    if (type.isString()) {
      return 'string';
    }

    if (type.isNumber()) {
      return 'number';
    }

    if (type.isBoolean()) {
      return 'boolean';
    }

    if (type.isNull()) {
      return 'null';
    }

    if (type.isStringLiteral()) {
      return JSON.stringify(type.getLiteralValue());
    }

    if (type.isNumberLiteral()) {
      return String(type.getLiteralValue());
    }

    if (type.isBooleanLiteral()) {
      return type.getText(enclosingNode);
    }

    if (type.isUnion()) {
      return type
        .getUnionTypes()
        .map(unionType =>
          this.typeToTypeScriptCode(
            unionType,
            enclosingNode,
            new Set(seenTypeTexts),
          ),
        )
        .join(' | ');
    }

    if (type.isTuple()) {
      return `[${type
        .getTupleElements()
        .map(tupleType =>
          this.typeToTypeScriptCode(
            tupleType,
            enclosingNode,
            new Set(seenTypeTexts),
          ),
        )
        .join(', ')}]`;
    }

    if (type.isArray() || type.isReadonlyArray()) {
      const itemType = this.typeToTypeScriptCode(
        type.getArrayElementType() ?? type,
        enclosingNode,
        new Set(seenTypeTexts),
      );

      return `${this.wrapArrayItemType(itemType)}[]`;
    }

    if (!type.isObject() || type.getCallSignatures().length > 0) {
      return type.getText(enclosingNode);
    }

    const typeText = type.getText(enclosingNode);
    if (seenTypeTexts.has(typeText)) {
      return typeText;
    }

    seenTypeTexts.add(typeText);

    const properties = type.getProperties();
    if (properties.length === 0) {
      return typeText;
    }

    return `{ ${properties
      .map((property) => {
        const propertyNode =
          property.getValueDeclaration() ?? property.getDeclarations()[0];
        const propertyType = property.getTypeAtLocation(
          propertyNode ?? enclosingNode,
        );
        const optional = property.isOptional()
          || this.typeAllowsUndefined(propertyType);

        return `${this.propertyNameToTypeScriptCode(property.getName())}${optional ? '?' : ''}: ${this.typeToTypeScriptCode(
          propertyType,
          propertyNode ?? enclosingNode,
          new Set(seenTypeTexts),
        )}`;
      })
      .join('; ')} }`;
  }

  private wrapArrayItemType(typeText: string): string {
    return typeText.includes(' | ') || typeText.includes('&')
      ? `(${typeText})`
      : typeText;
  }

  private propertyNameToTypeScriptCode(name: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  }

  private typeAllowsUndefined(type: TsMorphType): boolean {
    return type.isUndefined()
      || (type.isUnion()
        && type.getUnionTypes().some(unionType => unionType.isUndefined()));
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
  ): Pick<GraphOutputCycles, 'providers' | 'controllers'> {
    const nodes = new Map<string, DependencyNode>();

    for (const [moduleName, moduleData] of Object.entries(modules)) {
      for (const provider of moduleData.providers) {
        const key = this.dependencyNodeKey(moduleName, provider.name);
        nodes.set(key, {
          key,
          kind: 'provider',
          moduleName,
          name: provider.name,
        });
      }

      for (const controller of moduleData.controllers) {
        const key = this.dependencyNodeKey(moduleName, controller.name);
        nodes.set(key, {
          key,
          kind: 'controller',
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
        .filter((cycle) => nodes.get(cycle.from)?.kind === 'provider')
        .map((cycle) => this.toProviderCycle(cycle, nodes)),
      controllers: cycles.filter(
        (cycle) => nodes.get(cycle.from)?.kind === 'controller',
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
      return cyclePath.join('->');
    }

    const rotations = cyclePath.map((_, index) => [
      ...cyclePath.slice(index),
      ...cyclePath.slice(0, index),
    ]);

    return rotations
      .map((rotation) => rotation.join('->'))
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

    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) {
      return {
        module: { name: '' },
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
      return 'direct';
    }

    return 'indirect';
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
    const colonIndex = dependency.indexOf(':');

    if (colonIndex !== -1) {
      return {
        providedBy: {
          type: 'module',
          name: dependency.substring(0, colonIndex),
        },
        token: dependency.substring(colonIndex + 1),
      };
    }

    return {
      providedBy: { type: 'module', name: currentModule },
      token: dependency,
    };
  }
}
