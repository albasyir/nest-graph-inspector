import { Injectable } from '@nestjs/common';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import type { ProxyCorsOptions } from '../ports/proxy.gateway';
import { HttpOutputAdapter } from './http-output.adapter';
import { ProxyAdapter } from './proxy.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { DirectRunOutputAdapter } from './direct-run-output.adapter';

type ViewerOutputConfig = Extract<NestGraphInspectorOutput, { type: 'viewer' }>;
type ViewerOutputInternalConfig = ViewerOutputConfig & {
  directRun?: {
    path: string;
    instanceLookup: (moduleName: string, providerName: string) => unknown;
  };
};

@Injectable()
export class ViewerOutputAdapter implements OutputAdapter<ViewerOutputConfig> {
  private readonly viewerBaseUrl =
    process.env.____DEV_VIEWER_BASE_URL ||
    'https://albasyir.github.io/nest-graph-inspector';

  constructor(
    private readonly httpOutputAdapter: HttpOutputAdapter,
    private readonly proxyAdapter: ProxyAdapter,
    private readonly httpServeAdapter: HttpServeAdapter,
    private readonly directRunOutputAdapter: DirectRunOutputAdapter,
  ) {}

  async execute(
    graphOutput: GraphOutput,
    config: ViewerOutputConfig,
  ): Promise<{ message: string }> {
    const internalConfig = config as ViewerOutputInternalConfig;
    const path = this.httpOutputAdapter.normalizePath(
      config.path ?? '/__graph-inspector',
    );
    const ollama = this.ollamaProxyOptions(config);

    await this.httpOutputAdapter.execute(graphOutput, {
      type: 'http',
      origin: config.origin,
      host: config.host,
      port: config.port,
      path,
      httpAdapter: this.httpServeAdapter,
    });
    await this.proxyAdapter.serve(
      {
        from: this.httpOrigin(config),
        to: ollama.origin,
        cors: this.viewerCorsOptions(),
      },
      {
        httpAdapter: this.httpServeAdapter,
        pathPrefix: ollama.path,
      },
    );

    if (internalConfig.directRun?.path) {
      this.httpServeAdapter.register(
        {
          origin: this.httpOrigin(config),
          host: config.host,
          port: config.port,
        },
        [this.directRunOutputAdapter.createRoute(
          internalConfig.directRun.path,
          (moduleName, providerName) => internalConfig.directRun?.instanceLookup(moduleName, providerName),
        )],
      );
    }

    try {
      await this.httpServeAdapter.serve();
    } catch (err) {
      this.httpServeAdapter.close();
      throw err;
    }

    const graphEndpoint = new URL(path, this.httpOrigin(config)).toString();
    const base64Origin = Buffer.from(graphEndpoint).toString('base64url');

    const viewerLink = `${this.viewerBaseUrl}/view/${base64Origin}`;

    return {
      message: `Graph Viewer is available at ${viewerLink}`,
    };
  }

  private httpOrigin(config: ViewerOutputConfig): string {
    const { host, port } = HttpOutputAdapter.defaultConfig;

    return (
      config.origin ?? `http://${config.host ?? host}:${config.port ?? port}`
    );
  }

  private ollamaProxyOptions(
    config: ViewerOutputConfig,
  ): Required<NonNullable<ViewerOutputConfig['ollama']>> {
    const origin = config.ollama?.origin;
    const path = config.ollama?.path;

    if (!origin || !path) {
      throw new Error('Viewer output requires Ollama proxy origin and path');
    }

    return { origin, path };
  }

  private viewerCorsOptions(): ProxyCorsOptions {
    return {
      origins: [new URL(this.viewerBaseUrl).origin],
    };
  }
}
