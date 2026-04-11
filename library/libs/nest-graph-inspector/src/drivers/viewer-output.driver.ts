import { Injectable, Logger } from '@nestjs/common';
import { ModuleMap } from '../types/module-map.type';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import { HttpOutputDriver } from './http-output.driver';

type ViewerOutputConfig = Extract<NestGraphInspectorOutput, { type: 'viewer' }>;

@Injectable()
export class ViewerOutputDriver implements OutputAdapter<ViewerOutputConfig> {
  private readonly logger = new Logger(ViewerOutputDriver.name)

  constructor(
    private readonly httpOutputDriver: HttpOutputDriver,
  ) { }

  // private viewerBaseUrl: string = 'http://localhost:3000'
  private viewerBaseUrl: string = 'https://albasyir.github.io/nest-graph-inspector'

  async execute(moduleMap: ModuleMap, config: ViewerOutputConfig): Promise<void> {
    const path = config.path ?? `/__graph-inspector`

    await this.httpOutputDriver.execute(moduleMap, { type: 'http', path });

    const base64Origin = Buffer.from(config.origin + path).toString('base64url');

    const viewerLink = `${this.viewerBaseUrl}/view/${base64Origin}`;

    this.logger.debug(`Graph Viewer is available at ${viewerLink}`);
  }
}
