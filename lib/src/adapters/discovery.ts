import { Inject, Injectable, Type } from "@nestjs/common";
import type {
  InjectionToken,
  OptionalFactoryDependency,
} from "@nestjs/common/interfaces";
import { ModulesContainer } from "@nestjs/core";
import type { InstanceWrapper } from "@nestjs/core/injector/instance-wrapper";
import type { Module } from "@nestjs/core/injector/module";
import { MODULE_OPTIONS_TOKEN } from "../nest-graph-inspector.config";
import type { NestGraphInspectorModuleOptions } from "../nest-graph-inspector.type";
import {
  defaultOptions,
  NestGraphInspectorModule,
} from "../nest-graph-inspector.module";
import { ModuleController } from "../types/module-controller.type";
import { ModuleProvider } from "../types/module-provider.type";
import { RuntimeTraceSpanType } from "../types/direct-run.type";
import { RuntimeTraceRecorder } from "../runtime-trace.recorder";
import { SourceMetadataService } from "../source-metadata.service";

export type ModuleTree = {
  name: string;
  jsdoc?: string;
  moduleRef: Module | null;
  imports: string[];
  exports: string[];
  providers: ModuleProvider[];
  providerInstances: Map<string, unknown>;
  controllers: ModuleController[];
  children: ModuleTree[];
};

@Injectable()
export class DiscoveryAdapter {
  private readonly ignoreProvider: string[];
  private readonly ignoreImport: string[];
  private readonly nestCoreModuleName: string;
  private readonly nestCoreProviders: string[];
  private readonly runtimeTraceInstrumentedInstances = new WeakSet<object>();
  private cachedTree: ModuleTree | undefined;

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: NestGraphInspectorModuleOptions,
    private readonly modulesContainer: ModulesContainer,
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
    private readonly sourceMetadata: SourceMetadataService,
  ) {
    this.ignoreProvider = [
      ...(this.options.ignoreProvider ?? defaultOptions.ignoreProvider ?? []),
    ];
    this.ignoreImport = [
      ...(this.options.ignoreImport ?? defaultOptions.ignoreImport ?? []),
    ];
    this.nestCoreModuleName =
      this.options.nestCoreModuleName ??
      defaultOptions.nestCoreModuleName ??
      "NestJSCoreModule";
    this.nestCoreProviders = [
      ...(this.options.nestCoreProviders ??
        defaultOptions.nestCoreProviders ??
        []),
    ];
  }

  scan(): ModuleTree {
    if (!this.cachedTree) {
      this.cachedTree = this.getModuleTree(this.getRootModule());
    }

    return this.cachedTree;
  }

  get tree(): ModuleTree {
    if (!this.cachedTree) {
      throw new Error("Discovery tree is unavailable before scan() is called.");
    }

    return this.cachedTree;
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

  /**
   * Auto-detect the root module by finding which module imports NestGraphInspectorModule.
   */
  private findRootModule(): Module {
    for (const moduleRef of this.modulesContainer.values()) {
      const moduleName = this.moduleName(moduleRef);

      if (
        this.ignoreImport.includes(moduleName) ||
        moduleName === "InternalCoreModule"
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
      "Could not auto-detect root module. No module imports NestGraphInspectorModule.",
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
      providerInstances: new Map(),
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
      providerInstances: new Map(),
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
      node.providerInstances = this.extractProviderInstances(
        node.moduleRef,
        node.providers,
      );
      node.controllers = this.extractControllers(node.moduleRef);
    });
  }

  private instrumentRuntimeTrace(moduleTree: ModuleTree): void {
    this.walkModuleTree(moduleTree, (node) => {
      if (!node.moduleRef) {
        return;
      }

      this.instrumentRuntimeTraceWrappers({
        moduleName: node.name,
        type: "provider",
        wrappers: node.moduleRef.providers.values(),
        shouldIgnore: (name) =>
          name === node.name || this.ignoreProvider.includes(name),
      });
      this.instrumentRuntimeTraceWrappers({
        moduleName: node.name,
        type: "controller",
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
      if (!instance || typeof instance !== "object") {
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
      if (methodName === "constructor") {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
      const method = descriptor?.value;
      if (typeof method !== "function") {
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
              args: this.runtimeTraceRecorder.previewValue(args),
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
      providerInstances: new Map(),
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

  private extractProviderInstances(
    moduleRef: Module,
    providers: ModuleProvider[],
  ): Map<string, unknown> {
    const providerNames = new Set(providers.map((provider) => provider.name));
    const providerInstances = new Map<string, unknown>();

    for (const wrapper of moduleRef.providers.values()) {
      const name =
        this.wrapperClassName(wrapper) || this.tokenName(wrapper.token);
      if (name && providerNames.has(name)) {
        providerInstances.set(name, wrapper.instance);
      }
    }

    return providerInstances;
  }

  private extractControllers(moduleRef: Module): ModuleController[] {
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
    return this.sourceMetadata.getClassJsDoc(className);
  }

  private wrapperClassName(wrapper: InstanceWrapper<unknown>): string | null {
    if (wrapper.metatype?.name) {
      return wrapper.metatype.name;
    }

    const instance = wrapper.instance;
    if (
      instance &&
      (typeof instance === "object" || typeof instance === "function")
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
        if (dependencyName && dependencyName !== "Object") {
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
        if (dependencyName && dependencyName !== "Object") {
          dependencies.add(dependencyName);
        }
      }
    }

    return [...dependencies];
  }

  private resolveInjectionToken(
    token: InjectionToken | OptionalFactoryDependency,
  ): InjectionToken {
    if (typeof token === "object" && token !== null && "token" in token) {
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
        (typeof wrapper.instance === "object" ||
          typeof wrapper.instance === "function")
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
      typeof wrapper.instance === "object" &&
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
      "AnonymousModule"
    );
  }

  private tokenName(token: InjectionToken | null | undefined): string | null {
    if (!token) return null;
    if (typeof token === "string") return token;
    if (typeof token === "symbol") return token.toString();
    if (typeof token === "function") return token.name;
    return null;
  }
}
