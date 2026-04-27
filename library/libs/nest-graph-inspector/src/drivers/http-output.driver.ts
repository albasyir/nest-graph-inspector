import { Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { OutputAdapter } from '../ports/output.adapter';
import { ModuleMap } from '../types/module-map.type';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';

type HttpOutputConfig = Extract<NestGraphInspectorOutput, { type: 'http' }>;
type HeaderResponse = {
  setHeader(name: string, value: string): void;
};

@Injectable()
export class HttpOutputDriver implements OutputAdapter<HttpOutputConfig> {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  execute(
    moduleMap: ModuleMap,
    config: HttpOutputConfig,
  ): Promise<{ message: string }> {
    const httpAdapter = this.adapterHost.httpAdapter;
    const path = this.normalizePath(config.path);

    httpAdapter.get(path, (_req: unknown, res: HeaderResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      httpAdapter.reply(res, moduleMap, 200);
    });

    return Promise.resolve({
      message: `Graph inspector HTTP endpoint is installed at ${path}`,
    });
  }

  normalizePath(path = '/__nest-graph-inspector'): string {
    return path.startsWith('/') ? path : `/${path}`;
  }
}
