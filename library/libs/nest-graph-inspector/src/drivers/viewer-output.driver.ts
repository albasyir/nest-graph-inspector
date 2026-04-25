import { Injectable } from '@nestjs/common';
import { ModuleMap } from '../types/module-map.type';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import { HttpOutputDriver } from './http-output.driver';

type ViewerOutputConfig = Extract<NestGraphInspectorOutput, { type: 'viewer' }>;

@Injectable()
export class ViewerOutputDriver implements OutputAdapter<ViewerOutputConfig> {
  constructor(
    private readonly httpOutputDriver: HttpOutputDriver,
  ) { }

  // private viewerBaseUrl: string = 'http://localhost:3000'
  private viewerBaseUrl: string = 'https://albasyir.github.io/nest-graph-inspector'

  async execute(
    moduleMap: ModuleMap,
    config: ViewerOutputConfig,
  ): Promise<{ message: string }> {
    const path = config.path ?? `/__graph-inspector`

    await this.httpOutputDriver.execute(moduleMap, { type: 'http', path });

    if (!config.origin) {
      return {
        message: `Graph Viewer is available at ${this.viewerBaseUrl}/view. Graph endpoint is installed at ${path}. See ${this.viewerBaseUrl}/configuration/outputs#web-viewer-output-type-viewer for detail`,
      };
    }

    const base64Origin = Buffer.from(config.origin + path).toString('base64url');

    const viewerLink = `${this.viewerBaseUrl}/view/${base64Origin}`;

    return {
      message: `Graph Viewer is available at ${viewerLink}`,
    };
  }
}
