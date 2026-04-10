import { writeFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { ModuleMap } from '../types/module-map.type';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';

type JsonOutputConfig = Extract<NestGraphInspectorOutput, { type: 'json' }>;

@Injectable()
export class JsonOutputDriver implements OutputAdapter<JsonOutputConfig> {
  async execute(moduleMap: ModuleMap, config: JsonOutputConfig): Promise<void> {
    const json = JSON.stringify(moduleMap, null, 2);
    await writeFile(config.path, json);
  }
}
