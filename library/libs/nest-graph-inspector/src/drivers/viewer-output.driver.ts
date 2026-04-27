import { Injectable } from '@nestjs/common';
import { ModuleMap } from '../types/module-map.type';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import { HttpOutputDriver } from './http-output.driver';

type ViewerOutputConfig = Extract<NestGraphInspectorOutput, { type: 'viewer' }>;

@Injectable()
export class ViewerOutputDriver implements OutputAdapter<ViewerOutputConfig> {
  private readonly viewerBaseUrl =
    'https://albasyir.github.io/nest-graph-inspector';

  constructor(private readonly httpOutputDriver: HttpOutputDriver) {}

  async execute(
    moduleMap: ModuleMap,
    config: ViewerOutputConfig,
  ): Promise<{ message: string }> {
    const path = this.httpOutputDriver.normalizePath(
      config.path ?? '/__graph-inspector',
    );

    await this.httpOutputDriver.execute(moduleMap, { type: 'http', path });

    if (!config.origin) {
      return {
        message: `Graph Viewer is available at ${this.viewerBaseUrl}/view. Graph endpoint is installed at ${path}. See ${this.viewerBaseUrl}/configuration/outputs#web-viewer-output-type-viewer for detail`,
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
