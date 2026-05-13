import { mkdir, writeFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';

type JsonOutputConfig = Extract<NestGraphInspectorOutput, { type: 'json' }>;

@Injectable()
export class JsonOutputAdapter implements OutputAdapter<JsonOutputConfig> {
  async execute(
    graphOutput: GraphOutput,
    config: JsonOutputConfig,
  ): Promise<{ message: string }> {
    const filePath = join(process.cwd(), config.path);
    const json = JSON.stringify(graphOutput, null, 2);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, json);

    return {
      message: `Graph inspector JSON output was written to ${filePath}`,
    };
  }
}
