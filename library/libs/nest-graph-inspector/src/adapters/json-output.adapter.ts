import { mkdir, writeFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type {
  GraphOutput,
  GraphOutputController,
  GraphOutputModule,
  GraphOutputProvider,
} from '../types/graph-output.type';

type JsonOutputConfig = Extract<NestGraphInspectorOutput, { type: 'json' }>;
type JsonOutputDependencyRef = {
  module: string;
  token: string;
};
type JsonOutputProvider = Omit<GraphOutputProvider, 'dependencies'> & {
  dependencies: JsonOutputDependencyRef[];
};
type JsonOutputController = Omit<GraphOutputController, 'dependencies'> & {
  dependencies: JsonOutputDependencyRef[];
};
type JsonOutputModule = Omit<
  GraphOutputModule,
  'providers' | 'controllers'
> & {
  providers: JsonOutputProvider[];
  controllers: JsonOutputController[];
};
type JsonGraphOutput = Omit<GraphOutput, 'modules'> & {
  modules: Record<string, JsonOutputModule>;
};

@Injectable()
export class JsonOutputAdapter implements OutputAdapter<JsonOutputConfig> {
  async execute(
    graphOutput: GraphOutput,
    config: JsonOutputConfig,
  ): Promise<{ message: string }> {
    const filePath = join(process.cwd(), config.path);
    const json = JSON.stringify(this.toJsonOutput(graphOutput), null, 2);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, json);

    return {
      message: `Graph inspector JSON output was written to ${filePath}`,
    };
  }

  private toJsonOutput(graphOutput: GraphOutput): JsonGraphOutput {
    return {
      ...graphOutput,
      modules: Object.fromEntries(
        Object.entries(graphOutput.modules).map(([moduleName, moduleData]) => [
          moduleName,
          {
            ...moduleData,
            providers: moduleData.providers.map((provider) => ({
              ...provider,
              dependencies: provider.dependencies.map((dependency) => ({
                module: dependency.providedBy.name,
                token: dependency.token,
              })),
            })),
            controllers: moduleData.controllers.map((controller) => ({
              ...controller,
              dependencies: controller.dependencies.map((dependency) => ({
                module: dependency.providedBy.name,
                token: dependency.token,
              })),
            })),
          },
        ]),
      ),
    };
  }
}
