import { Injectable } from '@nestjs/common';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import { HttpOutputAdapter } from './http-output.adapter';

type ViewerOutputConfig = Extract<NestGraphInspectorOutput, { type: 'viewer' }>;

@Injectable()
export class ViewerOutputAdapter implements OutputAdapter<ViewerOutputConfig> {
  private readonly viewerBaseUrl =
    process.env.____DEV_VIEWER_BASE_URL ||
    'https://albasyir.github.io/nest-graph-inspector';

  constructor(private readonly httpOutputAdapter: HttpOutputAdapter) {}

  async execute(
    graphOutput: GraphOutput,
    config: ViewerOutputConfig,
  ): Promise<{ message: string }> {
    const path = this.httpOutputAdapter.normalizePath(
      config.path ?? '/__graph-inspector',
    );

    await this.httpOutputAdapter.execute(graphOutput, { type: 'http', path });

    if (!config.origin) {
      return {
        message: `Graph Viewer is available at ${this.viewerBaseUrl}/view and follow the configuration instructions.`,
      };
    }

    const graphEndpoint = new URL(path, config.origin).toString();
    const base64Origin = Buffer.from(graphEndpoint).toString('base64url');

    const viewerLink = `${this.viewerBaseUrl}/view/${base64Origin}`;

    return {
      message: `Graph Viewer is available at ${viewerLink}`,
    };
  }
}
