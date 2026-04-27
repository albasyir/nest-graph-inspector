import { mkdir, writeFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { ModuleMap } from '../types/module-map.type';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';

type JsonOutputConfig = Extract<NestGraphInspectorOutput, { type: 'json' }>;

@Injectable()
export class JsonOutputDriver implements OutputAdapter<JsonOutputConfig> {
  async execute(
    moduleMap: ModuleMap,
    config: JsonOutputConfig,
  ): Promise<{ message: string }> {
    const filePath = join(process.cwd(), config.path);
    const json = JSON.stringify(moduleMap, null, 2);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, json);

    return {
      message: `Graph inspector JSON output was written to ${filePath}`,
    };
  }
}
