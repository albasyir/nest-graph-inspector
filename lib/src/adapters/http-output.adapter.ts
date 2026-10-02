import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Injectable } from '@nestjs/common';
import { createInspectorEndpointInfo } from '../inspector-endpoint-info';
import { OutputAdapter } from '../ports/output.adapter';
import { NestGraphInspectorOutput } from '../nest-graph-inspector.type';
import type { GraphOutput } from '../types/graph-output.type';
import type { GraphLayout } from '../types/graph-layout.type';
import { GRAPH_OUTPUT_JSON_SCHEMA } from '../types/graph-output.schema';
import {
  GRAPH_LAYOUT_SCHEMA_VERSION,
  validateGraphLayout,
} from '../types/graph-layout.schema';
import { FileOutputAdapter } from './file-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import type { HttpServeResponse } from './http-serve.adapter';
import { AccessTokenService } from '../access-token.service';

type HttpOutputConfig = Extract<NestGraphInspectorOutput, { type: 'http' }>;

/** Used when neither the output nor the module sets `layoutFilePath`. */
export const DEFAULT_LAYOUT_FILE_PATH = './nest-graph-layout.json';

/**
 * Upper bound on a layout request body, in encoded bytes. A large
 * application's layout is around a megabyte; this leaves room and still keeps
 * one request from holding unbounded memory.
 */
export const MAX_LAYOUT_BODY_BYTES = 10 * 1024 * 1024;

type LayoutBodyResult =
  | { ok: true; text: string }
  | { ok: false; response: HttpServeResponse };

/**
 * Two-space indentation and a trailing newline, so a committed layout file
 * diffs and merges cleanly.
 */
export function serializeGraphLayout(layout: GraphLayout): string {
  return `${JSON.stringify(layout, null, 2)}\n`;
}

/**
 * A graph value or a resolver evaluated by a graph HTTP endpoint on request.
 *
 * This lets a host install endpoints during bootstrap without discovering the
 * Nest container until a client actually asks for graph output.
 */
export type GraphOutputSource =
  | GraphOutput
  | (() => GraphOutput | Promise<GraphOutput>);

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
  static readonly defaultConfig: Readonly<
    Required<Pick<HttpOutputConfig, 'host' | 'port'>>
  > = {
    host: '0.0.0.0',
    port: 53371,
  };

  /** The layout write still running, or last queued, for each file. */
  private readonly pendingLayoutWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly fileOutputAdapter: FileOutputAdapter,
    private readonly httpServeAdapter: HttpServeAdapter,
    private readonly accessTokenService: AccessTokenService,
  ) {}

  async execute(
    graphOutput: GraphOutputSource,
    config: HttpOutputConfig & HttpOutputInternalOptions,
  ): Promise<{ message: string }> {
    const origin = config.origin ?? this.httpOrigin;
    const path = this.normalizePath(config.path);
    const informationOutputPath = this.joinPath(path, 'information.json');
    const jsonOutputPath = this.joinPath(path, 'output.json');
    const jsonSchemaOutputPath = this.joinPath(path, 'output.schema.json');
    const markdownOutputPath = this.joinPath(path, 'output.md');
    const layoutOutputPaths = [
      this.joinPath(path, 'layout.json'),
      this.joinPath(path, 'layout'),
    ];
    const layoutFilePath = resolve(
      process.cwd(),
      config.layoutFilePath ?? DEFAULT_LAYOUT_FILE_PATH,
    );
    const inspectorEndpointInfo = await createInspectorEndpointInfo(false);

    const isReuseHttpAdapter = !!config.httpAdapter;
    const httpAdapter = config.httpAdapter ?? this.httpServeAdapter;

    const registration = httpAdapter.register(
      {
        origin,
        host: config.host,
        port: config.port,
        authorize: this.accessTokenService.createHttpGuard(),
      },
      [
        httpAdapter.get(
          informationOutputPath,
          () => inspectorEndpointInfo,
          {
            responseHeaders: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        ),
        httpAdapter.get(jsonOutputPath, () => this.resolveGraphOutput(graphOutput), {
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
          async () =>
            this.fileOutputAdapter.buildMarkdownText(
              await this.resolveGraphOutput(graphOutput),
            ),
          {
            responseHeaders: {
              'content-type': 'text/markdown; charset=utf-8',
            },
          },
        ),
        ...layoutOutputPaths.flatMap((layoutOutputPath) => [
          httpAdapter.get(
            layoutOutputPath,
            () => this.readLayout(layoutFilePath),
            {
              responseHeaders: {
                'content-type': 'application/json; charset=utf-8',
              },
            },
          ),
          httpAdapter.post(
            layoutOutputPath,
            ({ request }) => this.saveLayout(request, layoutFilePath),
            {
              responseHeaders: {
                'content-type': 'application/json; charset=utf-8',
              },
            },
          ),
        ]),
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
      message: `Graph inspector HTTP endpoints are installed at ${informationOutputUrl}, ${jsonOutputUrl}, and ${markdownOutputUrl}${this.accessTokenNotice()}`,
    };
  }

  /**
   * These endpoints are token-gated, and this log line is the only place an
   * operator can pick a token up, so it is stated once rather than repeated
   * into each URL.
   *
   * The token is a credential, so anything that captures application logs
   * captures it too. `accessToken.logToken: false` keeps it out, at the cost
   * of having to mint tokens from a configured secret instead.
   */
  private accessTokenNotice(): string {
    if (!this.accessTokenService.isEnabled()) {
      return '';
    }

    if (!this.accessTokenService.isTokenLoggable()) {
      return '. These endpoints require an access token, which is not printed because accessToken.logToken is off';
    }

    return `. Access token (expires at ${this.accessTokenService
      .currentExpiresAt()
      .toISOString()}): ${this.accessTokenService.current()}`;
  }

  normalizePath(path = '/__nest-graph-inspector'): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  /**
   * The saved layout, or an empty one when nothing has been saved yet. A file
   * that exists but cannot be read back as a layout is reported rather than
   * served as empty, so the next save cannot silently replace it unseen.
   */
  private async readLayout(filePath: string): Promise<HttpServeResponse> {
    // A read that starts mid-write would see a truncated file.
    await this.pendingLayoutWrites.get(filePath)?.catch(() => undefined);

    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (err) {
      if (isMissingFileError(err)) {
        return {
          statusCode: 200,
          body: {
            version: GRAPH_LAYOUT_SCHEMA_VERSION,
            modules: {},
          } satisfies GraphLayout,
        };
      }

      return this.layoutFailure(
        500,
        `Graph layout file ${filePath} could not be read: ${errorMessage(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return this.layoutFailure(
        500,
        `Graph layout file ${filePath} is not valid JSON: ${errorMessage(err)}`,
      );
    }

    const validation = validateGraphLayout(parsed);
    if (!validation.ok) {
      return {
        statusCode: 500,
        body: {
          ok: false,
          message: `Graph layout file ${filePath} is not a valid graph layout`,
          errors: validation.errors,
        },
      };
    }

    return { statusCode: 200, body: validation.layout };
  }

  private async saveLayout(
    request: NodeJS.ReadableStream,
    filePath: string,
  ): Promise<HttpServeResponse> {
    const bodyResult = await this.readLayoutBody(request);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyResult.text);
    } catch {
      return this.layoutFailure(400, 'Request body is not valid JSON.');
    }

    const validation = validateGraphLayout(payload);
    if (!validation.ok) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          message: 'Invalid layout payload',
          errors: validation.errors,
        },
      };
    }

    try {
      await this.writeLayout(filePath, validation.layout);
    } catch (err) {
      return this.layoutFailure(
        500,
        `Graph layout could not be saved to ${filePath}: ${errorMessage(err)}`,
      );
    }

    return {
      statusCode: 200,
      body: { ok: true, message: 'Layout saved successfully' },
    };
  }

  /**
   * Writes to one file run one at a time, in arrival order: two overlapping
   * `writeFile` calls on one path can interleave into invalid JSON, and the
   * later request is the one that has to land.
   */
  private async writeLayout(
    filePath: string,
    layout: GraphLayout,
  ): Promise<void> {
    const text = serializeGraphLayout(layout);
    const write = (this.pendingLayoutWrites.get(filePath) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, text, 'utf8');
      });
    this.pendingLayoutWrites.set(filePath, write);

    try {
      await write;
    } finally {
      if (this.pendingLayoutWrites.get(filePath) === write) {
        this.pendingLayoutWrites.delete(filePath);
      }
    }
  }

  private async readLayoutBody(
    request: NodeJS.ReadableStream,
  ): Promise<LayoutBodyResult> {
    let text = '';
    let byteLength = 0;
    const decoder = new StringDecoder('utf8');

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > MAX_LAYOUT_BODY_BYTES) {
        request.resume?.();
        return {
          ok: false,
          response: this.layoutFailure(413, 'Request body is too large.'),
        };
      }

      text += decoder.write(buffer);
    }

    return { ok: true, text: text + decoder.end() };
  }

  private layoutFailure(
    statusCode: number,
    message: string,
  ): HttpServeResponse {
    return { statusCode, body: { ok: false, message } };
  }

  private async resolveGraphOutput(
    graphOutput: GraphOutputSource,
  ): Promise<GraphOutput> {
    return typeof graphOutput === 'function'
      ? graphOutput()
      : graphOutput;
  }

  private get httpOrigin(): string {
    const { host, port } = HttpOutputAdapter.defaultConfig;

    return `http://${host}:${port}`;
  }

  private joinPath(basePath: string, childPath: string): string {
    return `${basePath.replace(/\/$/, '')}/${childPath.replace(/^\//, '')}`;
  }
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
