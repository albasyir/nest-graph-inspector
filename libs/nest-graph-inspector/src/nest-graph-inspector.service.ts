import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import type { NestGraphInspectorModuleOptions } from './nest-graph-inspector.config';
import { join } from 'node:path';

type ModuleController = {
  name: string;
  dependencies: string[];
};

type ModuleProvider = {
  name: string;
  dependencies: string[];
};

type Modules = {
  providers: ModuleProvider[];
  controllers: ModuleController[];
  imports: string[];
  exports: string[];
};

type ModuleMap = {
  root: string;
  modules: Record<string, Modules>;
};

type DependencyTarget = {
  moduleName: string;
  providerName: string;
};

@Injectable()
export class NestGraphInspectorService implements OnModuleInit {
  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: NestGraphInspectorModuleOptions,
    private readonly modulesContainer: ModulesContainer,
  ) {}

  private readonly ignoreProvider = ['ModuleRef', 'ApplicationConfig'];
  private readonly ignoreImport = [
    'InternalCoreModule',
    'NestGraphInspectorModule',
  ];
  private readonly nestCoreModuleName = 'NestJSCoreModule';
  private readonly nestCoreProviders = [
    'ModuleRef',
    'ApplicationConfig',
    'Reflector',
    'REQUEST',
    'INQUIRER',
  ];

  onModuleInit() {
    const moduleMap = this.buildModuleMap(this.options.rootModule);

    if (!this.options.output) {
      return;
    }

    const { file } = this.options.output;

    if (file) {
      const filePath = join(process.cwd(), file);

      if (filePath.endsWith('.md')) {
        const markdownText = this.buildMarkdownText(moduleMap);
        writeFileSync(filePath, markdownText, 'utf8');
      } else if (filePath.endsWith('.json')) {
        writeFileSync(filePath, JSON.stringify(moduleMap, null, 2), 'utf8');
      }
    }
  }

  buildModuleMap(rootModuleClass: Function): ModuleMap {
    const root = [...this.modulesContainer.values()].find(
      (m) => m.metatype === rootModuleClass,
    );

    if (!root) {
      throw new Error(`Root module not found: ${rootModuleClass.name}`);
    }

    const reachable = this.collectReachableModules(root, new Set<string>());
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
      root: this.moduleName(root),
      modules,
    };
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

  buildMarkdownText(moduleMap: ModuleMap): string {
    const lines: string[] = [];
    const moduleEntries = Object.entries(moduleMap.modules);

    lines.push('# NestJS Dependency Graph');
    lines.push('');
    lines.push(`Root Module: \`${moduleMap.root}\``);
    lines.push('');
    lines.push('```mermaid');
    lines.push('graph TD');
    lines.push('');

    this.appendMermaidModuleGroups(lines, moduleEntries);
    this.appendMermaidModuleRelations(lines, moduleEntries, moduleMap);

    lines.push('```');
    lines.push('');

    this.appendLegend(lines);
    this.appendModuleSections(lines, moduleEntries);

    return lines.join('\n');
  }

  private appendMermaidModuleGroups(
    lines: string[],
    moduleEntries: [string, Modules][],
  ): void {
    for (const [moduleName, moduleData] of moduleEntries) {
      lines.push(
        `  subgraph ${this.moduleGroupId(moduleName)}["${this.escapeMermaidLabel(moduleName)}"]`,
      );

      for (const provider of moduleData.providers) {
        lines.push(
          `    ${this.providerNodeId(moduleName, provider.name)}["${this.escapeMermaidLabel(provider.name)}"]`,
        );
      }

      for (const controller of moduleData.controllers) {
        lines.push(
          `    ${this.controllerNodeId(moduleName, controller.name)}["${this.escapeMermaidLabel(controller.name)}"]`,
        );
      }

      lines.push('  end');
    }
  }

  private appendMermaidModuleRelations(
    lines: string[],
    moduleEntries: [string, Modules][],
    moduleMap: ModuleMap,
  ): void {
    for (const [moduleName, moduleData] of moduleEntries) {
      this.appendMermaidImportRelations(
        lines,
        moduleName,
        moduleData,
        moduleMap,
      );
      this.appendMermaidProviderRelations(
        lines,
        moduleName,
        moduleData,
        moduleMap,
      );
      this.appendMermaidControllerRelations(
        lines,
        moduleName,
        moduleData,
        moduleMap,
      );
    }
  }

  private appendMermaidImportRelations(
    lines: string[],
    moduleName: string,
    moduleData: Modules,
    moduleMap: ModuleMap,
  ): void {
    const moduleGroupId = this.moduleGroupId(moduleName);
    if (moduleName === this.nestCoreModuleName) {
      return;
    }

    for (const importedModuleName of moduleData.imports) {
      if (!moduleMap.modules[importedModuleName]) {
        continue;
      }

      lines.push(
        `  ${this.moduleGroupId(importedModuleName)} --> ${moduleGroupId}`,
      );
    }
  }

  private appendMermaidProviderRelations(
    lines: string[],
    moduleName: string,
    moduleData: Modules,
    moduleMap: ModuleMap,
  ): void {
    for (const provider of moduleData.providers) {
      const providerNodeId = this.providerNodeId(moduleName, provider.name);
      this.appendDependencyRelations(
        lines,
        providerNodeId,
        moduleName,
        provider.name,
        provider.dependencies,
        moduleMap,
      );
    }
  }

  private appendMermaidControllerRelations(
    lines: string[],
    moduleName: string,
    moduleData: Modules,
    moduleMap: ModuleMap,
  ): void {
    for (const controller of moduleData.controllers) {
      const controllerNodeId = this.controllerNodeId(
        moduleName,
        controller.name,
      );
      this.appendDependencyRelations(
        lines,
        controllerNodeId,
        moduleName,
        controller.name,
        controller.dependencies,
        moduleMap,
      );
    }
  }

  private appendDependencyRelations(
    lines: string[],
    ownerNodeId: string,
    moduleName: string,
    ownerName: string,
    dependencies: string[],
    moduleMap: ModuleMap,
  ): void {
    for (const dependencyName of dependencies) {
      const dependencyTarget = this.findDependencyTarget(
        dependencyName,
        moduleName,
        moduleMap,
      );

      if (dependencyTarget) {
        lines.push(
          `  ${this.providerNodeId(dependencyTarget.moduleName, dependencyTarget.providerName)} --> ${ownerNodeId}`,
        );
        continue;
      }

      const dependencyNodeId = this.dependencyNodeId(
        moduleName,
        ownerName,
        dependencyName,
      );

      lines.push(
        `  ${dependencyNodeId}["${this.escapeMermaidLabel(dependencyName)}"]`,
      );
      lines.push(`  ${dependencyNodeId} --> ${ownerNodeId}`);
    }
  }

  private appendLegend(lines: string[]): void {
    lines.push('## Legend');
    lines.push('');
    lines.push('- Each module is rendered as a Mermaid group');
    lines.push(
      '- Inside each module group: providers and controllers owned by that module',
    );
    lines.push(
      '- Arrows between groups: imported module points to importing module',
    );
    lines.push(
      '- Arrows point from dependency/owned node to the dependent/owner node',
    );
    lines.push(
      '- Providers and controllers are grouped inside their owning module without extra ownership arrows',
    );
    lines.push(
      '- Internal and external runtime dependencies point to the provider/controller that uses them',
    );
    lines.push(
      '- Standalone dependency nodes are only used when a dependency cannot be resolved to a provider node',
    );
    lines.push('');
  }

  private appendModuleSections(
    lines: string[],
    moduleEntries: [string, Modules][],
  ): void {
    for (const [moduleName, moduleData] of moduleEntries) {
      lines.push(`## ${moduleName}`);
      lines.push('');

      this.appendStringSection(lines, 'Imports', moduleData.imports);
      this.appendStringSection(lines, 'Exports', moduleData.exports);
      this.appendProviderSection(lines, 'Providers', moduleData.providers);
      this.appendControllerSection(
        lines,
        'Controllers',
        moduleData.controllers,
      );
    }
  }

  private appendStringSection(
    lines: string[],
    title: string,
    values: string[],
  ): void {
    lines.push(`### ${title}`);

    if (values.length === 0) {
      lines.push('- None');
      lines.push('');
      return;
    }

    for (const value of values) {
      lines.push(`- ${value}`);
    }

    lines.push('');
  }

  private appendProviderSection(
    lines: string[],
    title: string,
    providers: ModuleProvider[],
  ): void {
    lines.push(`### ${title}`);

    if (providers.length === 0) {
      lines.push('- None');
      lines.push('');
      return;
    }

    for (const provider of providers) {
      this.appendNamedDependencyItem(
        lines,
        provider.name,
        provider.dependencies,
      );
    }

    lines.push('');
  }

  private appendControllerSection(
    lines: string[],
    title: string,
    controllers: ModuleController[],
  ): void {
    lines.push(`### ${title}`);

    if (controllers.length === 0) {
      lines.push('- None');
      lines.push('');
      return;
    }

    for (const controller of controllers) {
      this.appendNamedDependencyItem(
        lines,
        controller.name,
        controller.dependencies,
      );
    }

    lines.push('');
  }

  private appendNamedDependencyItem(
    lines: string[],
    name: string,
    dependencies: string[],
  ): void {
    lines.push(`- ${name}`);

    for (const dependencyName of dependencies) {
      lines.push(`  - depends on: ${dependencyName}`);
    }
  }

  private findDependencyTarget(
    dependencyName: string,
    currentModuleName: string,
    moduleMap: ModuleMap,
  ): DependencyTarget | null {
    const currentModule = moduleMap.modules[currentModuleName];
    if (currentModule) {
      const hasInternalProvider = currentModule.providers.some(
        (provider) => provider.name === dependencyName,
      );

      if (hasInternalProvider) {
        return {
          moduleName: currentModuleName,
          providerName: dependencyName,
        };
      }
    }

    const separatorIndex = dependencyName.indexOf(':');
    if (separatorIndex === -1) {
      return null;
    }

    const moduleName = dependencyName.slice(0, separatorIndex);
    const providerName = dependencyName.slice(separatorIndex + 1);

    if (!moduleName || !providerName) {
      return null;
    }

    const moduleData = moduleMap.modules[moduleName];
    if (!moduleData) {
      return null;
    }

    const hasProvider = moduleData.providers.some(
      (provider) => provider.name === providerName,
    );

    if (!hasProvider) {
      return null;
    }

    return {
      moduleName,
      providerName,
    };
  }

  private toMermaidNodeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private escapeMermaidLabel(value: string): string {
    return value.replace(/"/g, '\\"');
  }

  private collectReachableModules(root: any, visited: Set<string>): any[] {
    const id = this.moduleId(root);
    if (visited.has(id)) return [];

    visited.add(id);

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

    if (Array.isArray(wrapper?.inject)) {
      for (const token of wrapper.inject) {
        const dependencyName = this.resolveDependencyName(token, moduleRef);
        if (dependencyName) {
          dependencies.add(dependencyName);
        }
      }
    }

    const metatype = wrapper?.metatype;
    if (metatype && typeof metatype === 'function') {
      const paramTypes =
        Reflect.getMetadata('design:paramtypes', metatype) ?? [];

      for (const paramType of paramTypes) {
        const dependencyName = this.resolveDependencyName(paramType, moduleRef);
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

  private ownProviderNames(moduleRef: any): Set<string> {
    return new Set(
      [...moduleRef.providers.values()]
        .map((wrapper: any) => this.wrapperName(wrapper))
        .filter((providerName): providerName is string => !!providerName),
    );
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

  private moduleId(moduleRef: any): string {
    return this.moduleName(moduleRef).replace(/[^a-zA-Z0-9_]/g, '_');
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

  private moduleGroupId(moduleName: string): string {
    return this.toMermaidNodeId(`module-group:${moduleName}`);
  }

  private moduleNodeId(moduleName: string): string {
    return this.toMermaidNodeId(`module:${moduleName}`);
  }

  private providerNodeId(moduleName: string, providerName: string): string {
    return this.toMermaidNodeId(`provider:${moduleName}:${providerName}`);
  }

  private controllerNodeId(moduleName: string, controllerName: string): string {
    return this.toMermaidNodeId(`controller:${moduleName}:${controllerName}`);
  }

  private dependencyNodeId(
    moduleName: string,
    ownerName: string,
    dependencyName: string,
  ): string {
    return this.toMermaidNodeId(
      `dependency:${moduleName}:${ownerName}:${dependencyName}`,
    );
  }
}
