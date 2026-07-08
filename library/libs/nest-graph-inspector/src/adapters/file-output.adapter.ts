import { mkdir, writeFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type {
  GraphOutput,
  GraphOutputCycle,
  GraphOutputModule,
  GraphOutputProvider,
  GraphOutputController,
  GraphOutputDependencyRef,
} from '../types/graph-output.type';

type FileOutputConfig = Extract<NestGraphInspectorOutput, { type: 'markdown' }>;
type CircularDependencyWarnings = Map<string, string[]>;
type CircularWarningCycle = Pick<GraphOutputCycle, 'from' | 'to' | 'type'>;
type ImportWarnings = Map<string, Map<string, string[]>>;

@Injectable()
export class FileOutputAdapter implements OutputAdapter<FileOutputConfig> {
  private static readonly inspectorEndpointInfo = {
    for: 'nest-graph-inspector',
    'is-static': true,
  };

  private readonly markdownTitle = 'NestJS Dependency Graph';
  private readonly arrowDirectionDescription =
    'Arrow direction: `A --> B` means `A` depends on `B`.';
  private readonly nestCoreModuleName = 'NestJSCoreModule';

  async execute(
    graphOutput: GraphOutput,
    config: FileOutputConfig,
  ): Promise<{ message: string }> {
    const filePath = join(process.cwd(), config.path);
    const informationFilePath = join(dirname(filePath), 'information.json');
    const markdownText = this.buildMarkdownText(graphOutput);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      informationFilePath,
      JSON.stringify(FileOutputAdapter.inspectorEndpointInfo, null, 2),
      'utf8',
    );
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
    const providerCircularWarnings =
      this.findProviderCircularWarnings(graphOutput);
    const controllerCircularWarnings =
      this.findControllerCircularWarnings(graphOutput);
    const moduleCircularWarnings = this.findModuleCircularWarnings(graphOutput);
    const unusedImportWarnings = this.findUnusedImportWarnings(
      moduleEntries,
      graphOutput,
    );

    for (const [moduleName, moduleData] of moduleEntries) {
      lines.push(`## ${moduleName}`);
      lines.push('');
      this.appendJsDocBlock(lines, moduleData.jsdoc);

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
        moduleName,
        moduleData.controllers,
        controllerCircularWarnings,
      );
    }
  }

  private findProviderCircularWarnings(
    graphOutput: GraphOutput,
  ): CircularDependencyWarnings {
    return this.findCircularWarningsFromCycles(
      graphOutput.cycles?.providers,
      (providerKey) => this.providerDisplayNameFromKey(providerKey),
    );
  }

  private findControllerCircularWarnings(
    graphOutput: GraphOutput,
  ): CircularDependencyWarnings {
    return this.findCircularWarningsFromCycles(
      graphOutput.cycles?.controllers,
      (controllerKey) => this.providerDisplayNameFromKey(controllerKey),
    );
  }

  private findModuleCircularWarnings(
    graphOutput: GraphOutput,
  ): CircularDependencyWarnings {
    return this.findCircularWarningsFromCycles(
      graphOutput.cycles?.modules,
      (moduleName) => moduleName,
    );
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
        provider.jsdoc,
        provider.dependencies,
        circularWarnings.get(this.providerKey(moduleName, provider.name)),
      );
    }

    lines.push('');
  }

  private appendControllerSection(
    lines: string[],
    title: string,
    moduleName: string,
    controllers: GraphOutputController[],
    circularWarnings: CircularDependencyWarnings,
  ): void {
    if (controllers.length === 0) {
      return;
    }

    lines.push(`### ${title}`);

    for (const controller of controllers) {
      this.appendNamedDependencyItem(
        lines,
        controller.name,
        controller.jsdoc,
        controller.dependencies,
        circularWarnings.get(this.providerKey(moduleName, controller.name)),
      );
    }

    lines.push('');
  }

  private appendNamedDependencyItem(
    lines: string[],
    name: string,
    jsdoc: string | undefined,
    dependencies: GraphOutputDependencyRef[],
    warnings: string[] = [],
  ): void {
    lines.push(`- ${name}`);

    this.appendJsDocBlock(lines, jsdoc, '  ');
    this.appendWarningItems(lines, warnings, '  ');

    for (const dependency of dependencies) {
      lines.push(
        `  - depends on ${dependency.token} from ${dependency.providedBy.name}`,
      );
    }
  }

  private appendJsDocBlock(
    lines: string[],
    jsdoc: string | undefined,
    indent = '',
  ): void {
    if (!jsdoc) {
      return;
    }

    for (const line of jsdoc.split('\n')) {
      lines.push(`${indent}${line}`);
    }

    lines.push('');
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

  private findCircularWarningsFromCycles(
    cycles: CircularWarningCycle[] = [],
    displayName: (key: string) => string,
  ): CircularDependencyWarnings {
    const circularWarnings: CircularDependencyWarnings = new Map();

    for (const cycle of cycles) {
      const warnings = this.getOrCreateArray(circularWarnings, cycle.from);
      warnings.push(
        `${cycle.type} circular dependency with ${displayName(cycle.to)}`,
      );
    }

    return circularWarnings;
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
