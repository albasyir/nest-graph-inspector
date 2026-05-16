import { mkdir, writeFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type {
  GraphOutput,
  GraphOutputModule,
  GraphOutputProvider,
  GraphOutputController,
  GraphOutputDependencyRef,
} from '../types/graph-output.type';

type FileOutputConfig = Extract<NestGraphInspectorOutput, { type: 'markdown' }>;
type CircularDependencyWarnings = Map<string, string[]>;
type ImportWarnings = Map<string, Map<string, string[]>>;

@Injectable()
export class FileOutputAdapter implements OutputAdapter<FileOutputConfig> {
  private readonly markdownTitle = 'NestJS Dependency Graph';
  private readonly arrowDirectionDescription =
    'Arrow direction: `A --> B` means `A` depends on `B`.';
  private readonly nestCoreModuleName = 'NestJSCoreModule';

  async execute(
    graphOutput: GraphOutput,
    config: FileOutputConfig,
  ): Promise<{ message: string }> {
    const filePath = join(process.cwd(), config.path);
    const markdownText = this.buildMarkdownText(graphOutput);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdownText, 'utf8');

    return {
      message: `Graph inspector markdown output was written to ${filePath}`,
    };
  }

  buildMarkdownText(graphOutput: GraphOutput): string {
    const lines: string[] = [];
    const moduleEntries = Object.entries(graphOutput.modules);

    lines.push(`# ${this.markdownTitle}`);
    lines.push('');
    lines.push('```mermaid');
    lines.push('graph TD');
    lines.push('');

    this.appendMermaidModuleGroups(lines, moduleEntries);
    this.appendMermaidModuleRelations(lines, moduleEntries, graphOutput);

    lines.push('```');
    lines.push('');
    lines.push(`> ${this.arrowDirectionDescription}`);
    lines.push('');

    this.appendModuleSections(lines, moduleEntries, graphOutput);

    return lines.join('\n');
  }

  private appendMermaidModuleGroups(
    lines: string[],
    moduleEntries: [string, GraphOutputModule][],
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
    moduleEntries: [string, GraphOutputModule][],
    graphOutput: GraphOutput,
  ): void {
    for (const [moduleName, moduleData] of moduleEntries) {
      this.appendMermaidImportRelations(
        lines,
        moduleName,
        moduleData,
        graphOutput,
      );
      this.appendMermaidProviderRelations(
        lines,
        moduleName,
        moduleData,
        graphOutput,
      );
      this.appendMermaidControllerRelations(
        lines,
        moduleName,
        moduleData,
        graphOutput,
      );
    }
  }

  private appendMermaidImportRelations(
    lines: string[],
    moduleName: string,
    moduleData: GraphOutputModule,
    graphOutput: GraphOutput,
  ): void {
    const importingModuleGroupId = this.moduleGroupId(moduleName);
    if (moduleName === this.nestCoreModuleName) {
      return;
    }

    for (const importedModuleName of moduleData.imports) {
      if (!graphOutput.modules[importedModuleName]) {
        continue;
      }

      const importedModuleGroupId = this.moduleGroupId(importedModuleName);
      lines.push(`  ${importingModuleGroupId} --> ${importedModuleGroupId}`);
    }
  }

  private appendMermaidProviderRelations(
    lines: string[],
    moduleName: string,
    moduleData: GraphOutputModule,
    graphOutput: GraphOutput,
  ): void {
    for (const provider of moduleData.providers) {
      const providerNodeId = this.providerNodeId(moduleName, provider.name);
      this.appendDependencyRelations(
        lines,
        providerNodeId,
        moduleName,
        provider.name,
        provider.dependencies,
        graphOutput,
      );
    }
  }

  private appendMermaidControllerRelations(
    lines: string[],
    moduleName: string,
    moduleData: GraphOutputModule,
    graphOutput: GraphOutput,
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
        graphOutput,
      );
    }
  }

  private appendDependencyRelations(
    lines: string[],
    ownerNodeId: string,
    moduleName: string,
    ownerName: string,
    dependencies: GraphOutputDependencyRef[],
    graphOutput: GraphOutput,
  ): void {
    for (const dependency of dependencies) {
      const dependencyModule = graphOutput.modules[dependency.providedBy.name];
      const hasDependencyProvider = dependencyModule?.providers.some(
        (provider) => provider.name === dependency.token,
      );

      if (hasDependencyProvider) {
        const dependencyProviderNodeId = this.providerNodeId(
          dependency.providedBy.name,
          dependency.token,
        );
        lines.push(`  ${ownerNodeId} --> ${dependencyProviderNodeId}`);
        continue;
      }

      const dependencyLabel = `${dependency.providedBy.name}:${dependency.token}`;
      const dependencyNodeId = this.dependencyNodeId(
        moduleName,
        ownerName,
        dependencyLabel,
      );

      lines.push(
        `  ${dependencyNodeId}["${this.escapeMermaidLabel(dependencyLabel)}"]`,
      );
      lines.push(`  ${ownerNodeId} --> ${dependencyNodeId}`);
    }
  }

  private appendModuleSections(
    lines: string[],
    moduleEntries: [string, GraphOutputModule][],
    graphOutput: GraphOutput,
  ): void {
    const providerCircularWarnings = this.findProviderCircularWarnings(
      moduleEntries,
      graphOutput,
    );
    const moduleCircularWarnings = this.findModuleCircularWarnings(
      moduleEntries,
      graphOutput,
    );
    const unusedImportWarnings = this.findUnusedImportWarnings(
      moduleEntries,
      graphOutput,
    );

    for (const [moduleName, moduleData] of moduleEntries) {
      lines.push(`## ${moduleName}`);
      lines.push('');

      const moduleWarnings = moduleCircularWarnings.get(moduleName);
      this.appendModuleWarningBlock(lines, moduleWarnings);
      if (moduleWarnings && moduleWarnings.length > 0) {
        lines.push('');
      }

      this.appendStringSection(
        lines,
        'Imports',
        moduleData.imports,
        unusedImportWarnings.get(moduleName),
      );
      this.appendStringSection(lines, 'Exports', moduleData.exports);
      this.appendProviderSection(
        lines,
        'Providers',
        moduleName,
        moduleData.providers,
        providerCircularWarnings,
      );
      this.appendControllerSection(
        lines,
        'Controllers',
        moduleData.controllers,
      );
    }
  }

  private findProviderCircularWarnings(
    moduleEntries: [string, GraphOutputModule][],
    graphOutput: GraphOutput,
  ): CircularDependencyWarnings {
    const providerKeys = new Set<string>();
    const providerEdges = this.createNodeMap(moduleEntries, ([moduleName]) =>
      graphOutput.modules[moduleName].providers.map((provider) =>
        this.providerKey(moduleName, provider.name),
      ),
    );

    for (const [moduleName, moduleData] of moduleEntries) {
      for (const provider of moduleData.providers) {
        providerKeys.add(this.providerKey(moduleName, provider.name));
      }
    }

    for (const [moduleName, moduleData] of moduleEntries) {
      for (const provider of moduleData.providers) {
        const providerKey = this.providerKey(moduleName, provider.name);
        const dependencies = this.getOrCreateSet(providerEdges, providerKey);

        for (const dependency of provider.dependencies) {
          const dependencyModule =
            graphOutput.modules[dependency.providedBy.name];
          const dependencyKey = this.providerKey(
            dependency.providedBy.name,
            dependency.token,
          );
          const hasDependencyProvider = dependencyModule?.providers.some(
            (candidate) => candidate.name === dependency.token,
          );

          if (hasDependencyProvider && providerKeys.has(dependencyKey)) {
            dependencies.add(dependencyKey);
          }
        }
      }
    }

    return this.findCircularWarnings(providerEdges, (providerKey) =>
      this.providerDisplayNameFromKey(providerKey),
    );
  }

  private findModuleCircularWarnings(
    moduleEntries: [string, GraphOutputModule][],
    graphOutput: GraphOutput,
  ): CircularDependencyWarnings {
    const moduleEdges = this.createNodeMap(moduleEntries, ([moduleName]) => [
      moduleName,
    ]);

    for (const [moduleName, moduleData] of moduleEntries) {
      const imports = this.getOrCreateSet(moduleEdges, moduleName);

      for (const importedModuleName of moduleData.imports) {
        if (!graphOutput.modules[importedModuleName]) {
          continue;
        }

        imports.add(importedModuleName);
      }
    }

    return this.findCircularWarnings(moduleEdges, (moduleName) => moduleName);
  }

  private findUnusedImportWarnings(
    moduleEntries: [string, GraphOutputModule][],
    graphOutput: GraphOutput,
  ): ImportWarnings {
    const unusedImportWarnings: ImportWarnings = new Map();

    for (const [moduleName, moduleData] of moduleEntries) {
      if (
        moduleName === graphOutput.root ||
        moduleName === this.nestCoreModuleName
      ) {
        continue;
      }

      const dependencies = [
        ...moduleData.providers.flatMap((provider) => provider.dependencies),
        ...moduleData.controllers.flatMap(
          (controller) => controller.dependencies,
        ),
      ];

      for (const importedModuleName of moduleData.imports) {
        const importedModule = graphOutput.modules[importedModuleName];

        if (!importedModule) {
          continue;
        }

        if (
          this.isModuleImportUsed(
            moduleData,
            importedModuleName,
            importedModule,
            dependencies,
          )
        ) {
          continue;
        }

        this.addImportWarning(
          unusedImportWarnings,
          moduleName,
          importedModuleName,
          'unused import module',
        );
      }
    }

    return unusedImportWarnings;
  }

  private isModuleImportUsed(
    moduleData: GraphOutputModule,
    importedModuleName: string,
    importedModule: GraphOutputModule,
    dependencies: GraphOutputDependencyRef[],
  ): boolean {
    if (moduleData.exports.includes(importedModuleName)) {
      return true;
    }

    return dependencies.some((dependency) => {
      if (dependency.providedBy.name === importedModuleName) {
        return true;
      }

      if (importedModule.exports.includes(dependency.providedBy.name)) {
        return true;
      }

      return importedModule.exports.includes(dependency.token);
    });
  }

  private appendStringSection(
    lines: string[],
    title: string,
    values: string[],
    warnings: Map<string, string[]> = new Map(),
  ): void {
    if (values.length === 0) {
      return;
    }

    lines.push(`### ${title}`);

    for (const value of values) {
      lines.push(`- ${value}`);
      this.appendWarningItems(lines, warnings.get(value), '  ');
    }

    lines.push('');
  }

  private appendProviderSection(
    lines: string[],
    title: string,
    moduleName: string,
    providers: GraphOutputProvider[],
    circularWarnings: CircularDependencyWarnings,
  ): void {
    if (providers.length === 0) {
      return;
    }

    lines.push(`### ${title}`);

    for (const provider of providers) {
      this.appendNamedDependencyItem(
        lines,
        provider.name,
        provider.dependencies,
        circularWarnings.get(this.providerKey(moduleName, provider.name)),
      );
    }

    lines.push('');
  }

  private appendControllerSection(
    lines: string[],
    title: string,
    controllers: GraphOutputController[],
  ): void {
    if (controllers.length === 0) {
      return;
    }

    lines.push(`### ${title}`);

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
    dependencies: GraphOutputDependencyRef[],
    warnings: string[] = [],
  ): void {
    lines.push(`- ${name}`);

    this.appendWarningItems(lines, warnings, '  ');

    for (const dependency of dependencies) {
      lines.push(
        `  - depends on ${dependency.token} from ${dependency.providedBy.name}`,
      );
    }
  }

  private appendWarningItems(
    lines: string[],
    warnings: string[] = [],
    indent = '',
  ): void {
    for (const warning of warnings) {
      lines.push(`${indent}- Warning: ${warning}`);
    }
  }

  private appendModuleWarningBlock(
    lines: string[],
    warnings: string[] = [],
  ): void {
    if (warnings.length === 0) {
      return;
    }

    lines.push('> warnings');

    for (const warning of warnings) {
      lines.push(`> - ${warning}`);
    }
  }

  private addImportWarning(
    warnings: ImportWarnings,
    moduleName: string,
    importedModuleName: string,
    warning: string,
  ): void {
    const moduleWarnings = this.getOrCreateMap(warnings, moduleName);
    const importWarnings = this.getOrCreateArray(
      moduleWarnings,
      importedModuleName,
    );
    importWarnings.push(warning);
  }

  private providerKey(moduleName: string, providerName: string): string {
    return `${moduleName}:${providerName}`;
  }

  private providerDisplayName(
    moduleName: string,
    providerName: string,
  ): string {
    return `${providerName} from ${moduleName}`;
  }

  private providerDisplayNameFromKey(providerKey: string): string {
    const separatorIndex = providerKey.indexOf(':');

    return this.providerDisplayName(
      providerKey.slice(0, separatorIndex),
      providerKey.slice(separatorIndex + 1),
    );
  }

  private getOrCreateSet(
    map: Map<string, Set<string>>,
    key: string,
  ): Set<string> {
    const existingValue = map.get(key);
    if (existingValue) {
      return existingValue;
    }

    const value = new Set<string>();
    map.set(key, value);
    return value;
  }

  private getOrCreateMap(
    map: Map<string, Map<string, string[]>>,
    key: string,
  ): Map<string, string[]> {
    const existingValue = map.get(key);
    if (existingValue) {
      return existingValue;
    }

    const value = new Map<string, string[]>();
    map.set(key, value);
    return value;
  }

  private getOrCreateArray(map: Map<string, string[]>, key: string): string[] {
    const existingValue = map.get(key);
    if (existingValue) {
      return existingValue;
    }

    const value: string[] = [];
    map.set(key, value);
    return value;
  }

  private createNodeMap<T>(
    values: T[],
    getKeys: (value: T) => string[],
  ): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();

    for (const value of values) {
      for (const key of getKeys(value)) {
        this.getOrCreateSet(map, key);
      }
    }

    return map;
  }

  private findCircularWarnings(
    graph: Map<string, Set<string>>,
    displayName: (key: string) => string,
  ): CircularDependencyWarnings {
    const circularWarnings: CircularDependencyWarnings = new Map();
    const reachableKeys = new Map<string, Set<string>>();

    for (const source of graph.keys()) {
      reachableKeys.set(source, this.findReachableKeys(source, graph));
    }

    for (const [source, targets] of graph) {
      const warnings = [...targets]
        .filter(
          (target) =>
            source === target || reachableKeys.get(target)?.has(source),
        )
        .map((target) => `circular dependency with ${displayName(target)}`);

      if (warnings.length > 0) {
        circularWarnings.set(source, warnings);
      }
    }

    return circularWarnings;
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

  private toMermaidNodeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private escapeMermaidLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private moduleGroupId(moduleName: string): string {
    return this.toMermaidNodeId(`module-group:${moduleName}`);
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
