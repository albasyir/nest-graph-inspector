/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { Inject, Injectable, Logger, OnModuleInit, Type } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
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
import { HttpOutputDriver } from './drivers/http-output.driver';
import { FileOutputDriver } from './drivers/file-output.driver';
import { JsonOutputDriver } from './drivers/json-output.driver';
import { ViewerOutputDriver } from './drivers/viewer-output.driver';
import { OutputAdapter } from './ports/output.adapter';

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

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: NestGraphInspectorModuleOptions,
    private readonly modulesContainer: ModulesContainer,
    private readonly httpOutputAdapter: HttpOutputDriver,
    private readonly fileOutputAdapter: FileOutputDriver,
    private readonly jsonOutputAdapter: JsonOutputDriver,
    private readonly viewerOutputAdapter: ViewerOutputDriver,
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
    const rootModuleClass = this.options.rootModule;
    const moduleMap = rootModuleClass
      ? this.buildModuleMap(rootModuleClass)
      : this.buildModuleMapFromAutoDetect();

    if (!this.options.outputs?.length) {
      return;
    }

    await Promise.all(
      this.options.outputs.map(async (output) => {
        const adapter = this.outputAdapters[output.type];
        if (!adapter) {
          this.logger.warn(`Unsupported output type: ${output.type}`);
          return;
        }

        try {
          const { message } = await adapter.execute(moduleMap, output);
          this.logger.debug(message);
        } catch (err) {
          this.logger.error(
            `Failed to execute output adapter for type ${output.type}`,
            err,
          );
        }
      }),
    );
  }

  buildModuleMapFromAutoDetect(): ModuleMap {
    const root = this.findRootModule();
    return this.buildModuleMapFromRef(root);
  }

  buildModuleMap(rootModuleClass: Type): ModuleMap {
    const root = [...this.modulesContainer.values()].find(
      (m) => m.metatype === rootModuleClass,
    );

    if (!root) {
      throw new Error(`Root module not found: ${rootModuleClass.name}`);
    }

    return this.buildModuleMapFromRef(root);
  }

  private buildModuleMapFromRef(root: any): ModuleMap {
    const reachable = this.collectReachableModules(root, new Set<unknown>());
    const modules: Record<string, Modules> = {};

    for (const moduleRef of reachable) {
      const moduleName = this.moduleName(moduleRef);
      if (this.ignoreImport.includes(moduleName)) {
        continue;
      }

      modules[moduleName] = {
        imports: this.extractImports(moduleRef),
        exports: this.extractExports(moduleRef),
        providers: this.extractProviders(moduleRef, moduleName),
        controllers: this.extractControllers(moduleRef, moduleName),
      };
    }

    const usedNestCoreProviders = this.findUsedNestCoreProviders(modules);

    if (usedNestCoreProviders.length > 0) {
      modules[this.nestCoreModuleName] = this.buildNestCoreModule(
        usedNestCoreProviders,
      );
    }

    return {
      version: '1',
      root: this.moduleName(root),
      modules,
    };
  }

  /**
   * Auto-detect the root module by finding which module imports NestGraphInspectorModule.
   */
  private findRootModule(): any {
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

  private buildNestCoreModule(usedProviders: string[]): Modules {
    return {
      imports: [],
      exports: [...usedProviders],
      providers: usedProviders.map((providerName) => ({
        name: providerName,
        dependencies: [],
      })),
      controllers: [],
    };
  }

  private findUsedNestCoreProviders(
    modules: Record<string, Modules>,
  ): string[] {
    const usedProviders = new Set<string>();

    for (const moduleData of Object.values(modules)) {
      for (const provider of moduleData.providers) {
        for (const dependencyName of provider.dependencies) {
          const nestCoreProviderName =
            this.extractNestCoreProviderName(dependencyName);

          if (nestCoreProviderName) {
            usedProviders.add(nestCoreProviderName);
          }
        }
      }

      for (const controller of moduleData.controllers) {
        for (const dependencyName of controller.dependencies) {
          const nestCoreProviderName =
            this.extractNestCoreProviderName(dependencyName);

          if (nestCoreProviderName) {
            usedProviders.add(nestCoreProviderName);
          }
        }
      }
    }

    return this.nestCoreProviders.filter((providerName) =>
      usedProviders.has(providerName),
    );
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

  private collectReachableModules(root: any, visited: Set<unknown>): any[] {
    if (visited.has(root)) return [];

    visited.add(root);

    const result = [root];
    for (const imported of root.imports.values()) {
      result.push(...this.collectReachableModules(imported, visited));
    }

    return result;
  }

  private extractImports(moduleRef: any): string[] {
    return [...moduleRef.imports.values()]
      .map((importedModuleRef: any) => this.moduleName(importedModuleRef))
      .filter((importName) => !this.ignoreImport.includes(importName));
  }

  private extractExports(moduleRef: any): string[] {
    return [...moduleRef.exports.values()]
      .map((exportedItem: any) => this.exportName(exportedItem))
      .filter(
        (exportName): exportName is string =>
          !!exportName && !this.ignoreProvider.includes(exportName),
      );
  }

  private extractProviders(
    moduleRef: any,
    moduleName: string,
  ): ModuleProvider[] {
    return [...moduleRef.providers.values()]
      .map((wrapper: any) =>
        this.extractProvider(wrapper, moduleName, moduleRef),
      )
      .filter((provider): provider is ModuleProvider => !!provider);
  }

  private extractControllers(
    moduleRef: any,
    moduleName: string,
  ): ModuleController[] {
    return [...moduleRef.controllers.values()]
      .map((wrapper: any) =>
        this.extractController(wrapper, moduleName, moduleRef),
      )
      .filter((controller): controller is ModuleController => !!controller);
  }

  private extractProvider(
    wrapper: any,
    moduleName: string,
    moduleRef: any,
  ): ModuleProvider | null {
    const name = this.wrapperName(wrapper);
    if (!name || this.ignoreProvider.includes(name) || name === moduleName) {
      return null;
    }

    return {
      name,
      dependencies: this.extractDependencies(wrapper, moduleRef),
    };
  }

  private extractController(
    wrapper: any,
    moduleName: string,
    moduleRef: any,
  ): ModuleController | null {
    const name = this.wrapperName(wrapper);
    if (!name) {
      return null;
    }
    return {
      name,
      dependencies: this.extractDependencies(wrapper, moduleRef),
    };
  }

  private extractDependencies(wrapper: any, moduleRef: any): string[] {
    const dependencies = new Set<string>();

    // Factory providers (useFactory with inject array)
    if (Array.isArray(wrapper?.inject)) {
      for (const token of wrapper.inject) {
        const dependencyName = this.resolveDependencyName(token, moduleRef);
        if (dependencyName) {
          dependencies.add(dependencyName);
        }
      }
    }

    // Constructor-injected dependencies (resolved by NestJS with @Inject() overrides)
    const ctorDeps: any[] = wrapper?.getCtorMetadata?.() ?? [];
    for (const depWrapper of ctorDeps) {
      if (depWrapper) {
        const dependencyName = this.resolveDependencyName(
          depWrapper.token ?? depWrapper.name,
          moduleRef,
        );
        if (dependencyName && dependencyName !== 'Object') {
          dependencies.add(dependencyName);
        }
      }
    }

    // Property-injected dependencies (@Inject() on class properties)
    const propertyDeps: any[] = wrapper?.getPropertiesMetadata?.() ?? [];
    for (const propertyDep of propertyDeps) {
      const depWrapper = propertyDep?.wrapper;
      if (depWrapper) {
        const dependencyName = this.resolveDependencyName(
          depWrapper.token ?? depWrapper.name,
          moduleRef,
        );
        if (dependencyName && dependencyName !== 'Object') {
          dependencies.add(dependencyName);
        }
      }
    }

    return [...dependencies];
  }

  private resolveDependencyName(token: any, moduleRef: any): string | null {
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
    moduleRef: any,
    token: any,
    includeModulePrefix: boolean,
  ): string | null {
    const moduleName = this.moduleName(moduleRef);

    for (const wrapper of moduleRef.providers.values()) {
      if (!this.isSameProviderToken(wrapper, token)) {
        continue;
      }

      const providerName = this.wrapperName(wrapper);
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

  private isSameProviderToken(wrapper: any, token: any): boolean {
    if (wrapper?.token === token) {
      return true;
    }

    if (wrapper?.metatype === token) {
      return true;
    }

    if (wrapper?.instance?.constructor === token) {
      return true;
    }

    return false;
  }

  private exportedNames(moduleRef: any): Set<string> {
    return new Set(
      [...moduleRef.exports.values()]
        .map((exportedItem: any) => this.exportName(exportedItem))
        .filter((exportName): exportName is string => !!exportName),
    );
  }

  private exportName(exportedItem: any): string | null {
    return (
      this.wrapperName(exportedItem) ||
      this.tokenName(exportedItem?.token || exportedItem)
    );
  }

  private isExportedProviderToken(moduleRef: any, token: any): boolean {
    const tokenName = this.tokenName(token);

    for (const exportedItem of moduleRef.exports.values()) {
      if (
        exportedItem === token ||
        exportedItem?.token === token ||
        exportedItem?.metatype === token
      ) {
        return true;
      }

      if (tokenName && this.exportName(exportedItem) === tokenName) {
        return true;
      }
    }

    return false;
  }

  private formatDependencyName(dependencyName: string, moduleRef: any): string {
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

  private moduleName(moduleRef: any): string {
    return (
      moduleRef.metatype?.name ||
      this.tokenName(moduleRef.token) ||
      'AnonymousModule'
    );
  }

  private wrapperName(wrapper: any): string | null {
    return (
      wrapper?.metatype?.name ||
      wrapper?.instance?.constructor?.name ||
      this.tokenName(wrapper?.token) ||
      null
    );
  }

  private tokenName(token: any): string | null {
    if (!token) return null;
    if (typeof token === 'string') return token;
    if (typeof token === 'symbol') return token.toString();
    if (typeof token === 'function') return token.name;
    return String(token);
  }
}
