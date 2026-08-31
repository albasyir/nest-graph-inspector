import { Injectable } from '@nestjs/common';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import { GraphOutputSource, HttpOutputAdapter } from './http-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';
import type { RuntimeTrace } from '../types/direct-run.type';
import { AccessTokenService } from '../access-token.service';

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
    private readonly httpServeAdapter: HttpServeAdapter,
    private readonly directRunOutputAdapter: DirectRunOutputAdapter,
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
    private readonly accessTokenService: AccessTokenService,
  ) {}

  async execute(
    graphOutput: GraphOutputSource,
    config: ViewerOutputConfig,
  ): Promise<{ message: string }> {
    const internalConfig = config as ViewerOutputInternalConfig;
    const path = this.httpOutputAdapter.normalizePath(
      config.path ?? '/__graph-inspector',
    );

    await this.httpOutputAdapter.execute(graphOutput, {
      type: 'http',
      origin: config.origin,
      host: config.host,
      port: config.port,
      path,
      httpAdapter: this.httpServeAdapter,
    });

    if (internalConfig.directRun?.path) {
      this.httpServeAdapter.register(
        {
          origin: this.httpOrigin(config),
          host: config.host,
          port: config.port,
          authorize: this.accessTokenService.createHttpGuard(),
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

    // The token rides in the graph endpoint URL so the hosted viewer carries
    // it into every follow-up request without the developer copying it by hand.
    const graphEndpoint = this.accessTokenService
      .appendToUrl(new URL(path, this.httpOrigin(config)))
      .toString();
    const base64Origin = Buffer.from(graphEndpoint).toString('base64url');

    const viewerLink = `${this.viewerBaseUrl}/view/${base64Origin}`;

    return {
      message: `Graph Viewer is available at ${viewerLink}${this.accessTokenNotice()}`,
    };
  }

  /**
   * The link above already carries the token when it may be printed. When it
   * may not, the link is incomplete on purpose and the operator has to append
   * a token they minted themselves.
   */
  private accessTokenNotice(): string {
    if (!this.accessTokenService.isEnabled()) {
      return '';
    }

    if (!this.accessTokenService.isTokenLoggable()) {
      return ' (append your own access token to the endpoint, accessToken.logToken is off)';
    }

    return ` (access token expires at ${this.accessTokenService
      .currentExpiresAt()
      .toISOString()})`;
  }

  private httpOrigin(config: ViewerOutputConfig): string {
    const { host, port } = HttpOutputAdapter.defaultConfig;

    return (
      config.origin ?? `http://${config.host ?? host}:${config.port ?? port}`
    );
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
