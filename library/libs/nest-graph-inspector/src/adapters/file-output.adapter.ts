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

    this.appendModuleSections(lines, moduleEntries);

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
      lines.push(
        `  ${importingModuleGroupId} --> ${importedModuleGroupId}`,
      );
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
        lines.push(
          `  ${ownerNodeId} --> ${dependencyProviderNodeId}`,
        );
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
    if (values.length === 0) {
      return;
    }

    lines.push(`### ${title}`);

    for (const value of values) {
      lines.push(`- ${value}`);
    }

    lines.push('');
  }

  private appendProviderSection(
    lines: string[],
    title: string,
    providers: GraphOutputProvider[],
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
  ): void {
    lines.push(`- ${name}`);

    for (const dependency of dependencies) {
      lines.push(
        `  - depends on ${dependency.token} from ${dependency.providedBy.name}`,
      );
    }
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
