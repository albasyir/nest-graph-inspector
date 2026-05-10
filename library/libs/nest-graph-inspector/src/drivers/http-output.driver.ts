import { Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import { FileOutputDriver } from './file-output.driver';

type HttpOutputConfig = Extract<NestGraphInspectorOutput, { type: 'http' }>;
type HeaderResponse = {
  setHeader(name: string, value: string): void;
};

@Injectable()
export class HttpOutputDriver implements OutputAdapter<HttpOutputConfig> {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly fileOutputDriver: FileOutputDriver,
  ) {}

  execute(
    graphOutput: GraphOutput,
    config: HttpOutputConfig,
  ): Promise<{ message: string }> {
    const httpAdapter = this.adapterHost.httpAdapter;
    const path = this.normalizePath(config.path);
    const jsonOutputPath = this.joinPath(path, 'output.json');
    const markdownOutputPath = this.joinPath(path, 'output.md');

    httpAdapter.get(path, (_req: unknown, res: HeaderResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      httpAdapter.reply(res, graphOutput, 200);
    });

    httpAdapter.get(jsonOutputPath, (_req: unknown, res: HeaderResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      httpAdapter.reply(res, graphOutput, 200);
    });

    httpAdapter.get(
      markdownOutputPath,
      (_req: unknown, res: HeaderResponse) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        httpAdapter.reply(
          res,
          this.fileOutputDriver.buildMarkdownText(graphOutput),
          200,
        );
      },
    );

    return Promise.resolve({
      message: `Graph inspector HTTP endpoints are installed at ${path}, ${jsonOutputPath}, and ${markdownOutputPath}`,
    });
  }

  normalizePath(path = '/__nest-graph-inspector'): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  private joinPath(basePath: string, childPath: string): string {
    return `${basePath.replace(/\/$/, '')}/${childPath.replace(/^\//, '')}`;
  }
}
