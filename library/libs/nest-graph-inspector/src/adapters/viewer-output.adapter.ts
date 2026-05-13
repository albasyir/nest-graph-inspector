import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import {
  defaultHttpOutputHost,
  defaultHttpOutputPort,
  HttpOutputAdapter,
} from './http-output.adapter';
import { ProxyAdapter } from './proxy.adapter';

type ViewerOutputConfig = Extract<NestGraphInspectorOutput, { type: 'viewer' }>;

@Injectable()
export class ViewerOutputAdapter
  implements OutputAdapter<ViewerOutputConfig>, OnModuleDestroy
{
  private readonly viewerBaseUrl =
    process.env.____DEV_VIEWER_BASE_URL ||
    'https://albasyir.github.io/nest-graph-inspector';

  constructor(
    private readonly httpOutputAdapter: HttpOutputAdapter,
    private readonly proxyAdapter: ProxyAdapter,
  ) {}

  onModuleDestroy(): void {
    this.proxyAdapter.close();
  }

  async execute(
    graphOutput: GraphOutput,
    config: ViewerOutputConfig,
  ): Promise<{ message: string }> {
    const path = this.httpOutputAdapter.normalizePath(
      config.path ?? '/__graph-inspector',
    );

    await this.httpOutputAdapter.execute(graphOutput, {
      type: 'http',
      origin: config.origin,
      host: config.host,
      port: config.port,
      path,
    });
    if (config.proxy) {
      await this.proxyAdapter.serve(config.proxy);
    }

    const origin = this.graphOrigin(config);
    if (!origin) {
      return {
        message: `Graph Viewer is available at ${this.viewerBaseUrl}/view and follow the configuration instructions.`,
      };
    }

    const graphEndpoint = new URL(path, origin).toString();
    const base64Origin = Buffer.from(graphEndpoint).toString('base64url');

    const viewerLink = `${this.viewerBaseUrl}/view/${base64Origin}`;

    return {
      message: `Graph Viewer is available at ${viewerLink}`,
    };
  }

  private graphOrigin(config: ViewerOutputConfig): string | undefined {
    if (config.origin) {
      return config.origin;
    }

    if (!config.host && config.port === undefined) {
      return undefined;
    }

    return `http://${config.host ?? defaultHttpOutputHost}:${config.port ?? defaultHttpOutputPort}`;
  }
}
