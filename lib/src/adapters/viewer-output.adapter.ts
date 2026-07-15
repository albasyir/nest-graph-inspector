import { Injectable } from '@nestjs/common';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import type { ProxyCorsOptions } from '../ports/proxy.gateway';
import { HttpOutputAdapter } from './http-output.adapter';
import { ProxyAdapter } from './proxy.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';
import type { RuntimeTrace } from '../types/direct-run.type';

type ViewerOutputConfig = Extract<NestGraphInspectorOutput, { type: 'viewer' }>;
type ViewerOutputInternalConfig = ViewerOutputConfig & {
  directRun?: {
    path: string;
    instanceLookup: (moduleName: string, providerName: string) => unknown;
    historyDirPath?: string;
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
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
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
        [
          this.directRunOutputAdapter.createRoute(
            internalConfig.directRun.path,
            (moduleName, providerName) =>
              internalConfig.directRun?.instanceLookup(
                moduleName,
                providerName,
              ),
            internalConfig.directRun.historyDirPath
              ? (trace) =>
                  this.writeHistoryFiles(
                    internalConfig.directRun!.historyDirPath!,
                    trace,
                  )
              : undefined,
          ),
          this.directRunOutputAdapter.createHistoriesRoute(
            `${internalConfig.directRun.path}/histories`,
          ),
          this.directRunOutputAdapter.createHistoryIndexRoute(
            `${internalConfig.directRun.path}/history/index.json`,
          ),
          this.directRunOutputAdapter.createHistoryTraceRoute(
            `${internalConfig.directRun.path}/history`,
          ),
        ],
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

  private async writeHistoryFiles(
    dirPath: string,
    trace: RuntimeTrace,
  ): Promise<void> {
    const traceIndex = this.runtimeTraceRecorder
      .getCompletedTraces()
      .map((item) => ({
        traceId: item.traceId,
        entrypoint: item.entrypoint,
        startedAt: item.startedAt,
        status: item.status,
        totalDurationMs: item.totalDurationMs,
      }));

    await mkdir(dirPath, { recursive: true });
    await writeFile(
      join(dirPath, `${trace.traceId}.json`),
      JSON.stringify(trace, null, 2),
    );
    await writeFile(
      join(dirPath, 'index.json'),
      JSON.stringify(traceIndex, null, 2),
    );
  }
}
