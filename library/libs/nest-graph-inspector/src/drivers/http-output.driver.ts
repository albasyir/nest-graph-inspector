import { Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { OutputAdapter } from '../ports/output.adapter';
import { ModuleMap } from '../types/module-map.type';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';

type HttpOutputConfig = Extract<NestGraphInspectorOutput, { type: 'http' }>;

@Injectable()
export class HttpOutputDriver implements OutputAdapter<HttpOutputConfig> {
  constructor(private readonly adapterHost: HttpAdapterHost) { }

  execute(
    moduleMap: ModuleMap,
    config: HttpOutputConfig,
  ): Promise<{ message: string }> {
    config.path = config.path || '/__nest-graph-inspector';

    const httpAdapter = this.adapterHost.httpAdapter;
    const path = config.path.startsWith('/') ? config.path : `/${config.path}`;

    httpAdapter.get(path, (_req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      httpAdapter.reply(res, moduleMap, 200);
    });

    return Promise.resolve({
      message: `Graph inspector HTTP endpoint is installed at ${path}`,
    });
  }
}
