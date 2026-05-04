import { mkdir, writeFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { ModuleMap } from '../types/module-map.type';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';

type JsonOutputConfig = Extract<NestGraphInspectorOutput, { type: 'json' }>;

type DependencyRef = {
  providedBy: { type: string; name: string };
  token: string;
};

@Injectable()
export class JsonOutputDriver implements OutputAdapter<JsonOutputConfig> {
  async execute(
    moduleMap: ModuleMap,
    config: JsonOutputConfig,
  ): Promise<{ message: string }> {
    const filePath = join(process.cwd(), config.path);
    const enriched = this.enrichModuleMap(moduleMap);
    const json = JSON.stringify(enriched, null, 2);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, json);

    return {
      message: `Graph inspector JSON output was written to ${filePath}`,
    };
  }

  private enrichModuleMap(moduleMap: ModuleMap) {
    if (!moduleMap.modules) {
      return moduleMap;
    }

    const enrichedModules: Record<string, unknown> = {};

    for (const [moduleName, moduleData] of Object.entries(moduleMap.modules)) {
      enrichedModules[moduleName] = {
        ...moduleData,
        providers: moduleData.providers.map((provider) => ({
          ...provider,
          dependencies: provider.dependencies.map((dep) =>
            this.enrichDependency(dep, moduleName),
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
    };
  }

  private enrichDependency(
    dependency: string,
    currentModule: string,
  ): DependencyRef {
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
