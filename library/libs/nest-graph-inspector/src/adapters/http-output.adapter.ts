import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import { FileOutputAdapter } from './file-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';

type HttpOutputConfig = Extract<NestGraphInspectorOutput, { type: 'http' }>;

const INSPECTOR_ENDPOINT_INFO = { for: 'nest-graph-inspector' };
export const defaultHttpOutputHost = 'localhost';
export const defaultHttpOutputPort = 3998;
export const defaultHttpOutputOrigin = `http://${defaultHttpOutputHost}:${defaultHttpOutputPort}`;

@Injectable()
export class HttpOutputAdapter
  implements OutputAdapter<HttpOutputConfig>, OnModuleDestroy
{
  private readonly httpServeAdapters: HttpServeAdapter[] = [];

  constructor(private readonly fileOutputAdapter: FileOutputAdapter) {}

  onModuleDestroy(): void {
    for (const httpServeAdapter of this.httpServeAdapters) {
      httpServeAdapter.close();
    }
    this.httpServeAdapters.length = 0;
  }

  async execute(
    graphOutput: GraphOutput,
    config: HttpOutputConfig,
  ): Promise<{ message: string }> {
    const origin = config.origin ?? defaultHttpOutputOrigin;
    const path = this.normalizePath(config.path);
    const informationOutputPath = this.joinPath(path, 'information.json');
    const jsonOutputPath = this.joinPath(path, 'output.json');
    const markdownOutputPath = this.joinPath(path, 'output.md');
    const httpServeAdapter = new HttpServeAdapter();

    const registration = httpServeAdapter.register(
      {
        origin,
        host: config.host,
        port: config.port,
      },
      [
        {
          type: 'GET',
          path: informationOutputPath,
          responseHeaders: {
            'content-type': 'application/json; charset=utf-8',
          },
          callback: () => INSPECTOR_ENDPOINT_INFO,
        },
        {
          type: 'GET',
          path: jsonOutputPath,
          responseHeaders: {
            'content-type': 'application/json; charset=utf-8',
          },
          callback: () => graphOutput,
        },
        {
          type: 'GET',
          path: markdownOutputPath,
          responseHeaders: {
            'content-type': 'text/markdown; charset=utf-8',
          },
          callback: () => this.fileOutputAdapter.buildMarkdownText(graphOutput),
        },
      ],
    );

    try {
      await httpServeAdapter.serve();
    } catch (err) {
      httpServeAdapter.close();
      throw err;
    }

    this.httpServeAdapters.push(httpServeAdapter);

    const informationOutputUrl = new URL(
      informationOutputPath,
      registration.origin,
    );
    const jsonOutputUrl = new URL(jsonOutputPath, registration.origin);
    const markdownOutputUrl = new URL(markdownOutputPath, registration.origin);

    return {
      message: `Graph inspector HTTP endpoints are installed at ${informationOutputUrl}, ${jsonOutputUrl}, and ${markdownOutputUrl}`,
    };
  }

  normalizePath(path = '/__nest-graph-inspector'): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  private joinPath(basePath: string, childPath: string): string {
    return `${basePath.replace(/\/$/, '')}/${childPath.replace(/^\//, '')}`;
  }
}
