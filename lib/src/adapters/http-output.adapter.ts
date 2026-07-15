import { Injectable } from '@nestjs/common';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import { GRAPH_OUTPUT_JSON_SCHEMA } from '../types/graph-output.schema';
import { FileOutputAdapter } from './file-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';

type HttpOutputConfig = Extract<NestGraphInspectorOutput, { type: 'http' }>;

/**
 * Internal Configuration Options
 *
 * @private internal usage only
 */
interface HttpOutputInternalOptions {
  /**
   * When provided, the adapter will reuse the given HttpServeAdapter instance instead of creating a new one. This is useful for scenarios where multiple outputs need to be served on the same HTTP server instance.
   */
  httpAdapter?: HttpServeAdapter;
}

@Injectable()
export class HttpOutputAdapter implements OutputAdapter<HttpOutputConfig> {
  private static readonly inspectorEndpointInfo = {
    for: 'nest-graph-inspector',
    'is-static': false,
  };

  static readonly defaultConfig: Readonly<
    Required<Pick<HttpOutputConfig, 'host' | 'port'>>
  > = {
    host: '0.0.0.0',
    port: 53371,
  };

  constructor(
    private readonly fileOutputAdapter: FileOutputAdapter,
    private readonly httpServeAdapter: HttpServeAdapter,
  ) {}

  async execute(
    graphOutput: GraphOutput,
    config: HttpOutputConfig & HttpOutputInternalOptions,
  ): Promise<{ message: string }> {
    const origin = config.origin ?? this.httpOrigin;
    const path = this.normalizePath(config.path);
    const informationOutputPath = this.joinPath(path, 'information.json');
    const jsonOutputPath = this.joinPath(path, 'output.json');
    const jsonSchemaOutputPath = this.joinPath(path, 'output.schema.json');
    const markdownOutputPath = this.joinPath(path, 'output.md');

    const isReuseHttpAdapter = !!config.httpAdapter;
    const httpAdapter = config.httpAdapter ?? this.httpServeAdapter;

    const registration = httpAdapter.register(
      {
        origin,
        host: config.host,
        port: config.port,
      },
      [
        httpAdapter.get(
          informationOutputPath,
          () => HttpOutputAdapter.inspectorEndpointInfo,
          {
            responseHeaders: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        ),
        httpAdapter.get(jsonOutputPath, () => graphOutput, {
          responseHeaders: {
            'content-type': 'application/json; charset=utf-8',
          },
        }),
        httpAdapter.get(jsonSchemaOutputPath, () => GRAPH_OUTPUT_JSON_SCHEMA, {
          responseHeaders: {
            'content-type': 'application/schema+json; charset=utf-8',
          },
        }),
        httpAdapter.get(
          markdownOutputPath,
          () => this.fileOutputAdapter.buildMarkdownText(graphOutput),
          {
            responseHeaders: {
              'content-type': 'text/markdown; charset=utf-8',
            },
          },
        ),
      ],
    );

    if (!isReuseHttpAdapter) {
      try {
        await httpAdapter.serve();
      } catch (err) {
        httpAdapter.close(registration.origin);
        throw err;
      }
    }

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

  private get httpOrigin(): string {
    const { host, port } = HttpOutputAdapter.defaultConfig;

    return `http://${host}:${port}`;
  }

  private joinPath(basePath: string, childPath: string): string {
    return `${basePath.replace(/\/$/, '')}/${childPath.replace(/^\//, '')}`;
  }
}
