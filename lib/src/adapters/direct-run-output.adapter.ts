import { Injectable } from '@nestjs/common';
import type { HttpServeResponse } from './http-serve.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import type { DirectRunResult } from '../types/direct-run.type';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';
import type { RuntimeTrace } from '../types/direct-run.type';

type DirectRunArgsResult =
  | { ok: true; args: unknown[] }
  | { ok: false; response: HttpServeResponse };

@Injectable()
export class DirectRunOutputAdapter {
  constructor(
    private readonly httpServeAdapter: HttpServeAdapter,
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
  ) {}

  createRoute(
    path: string,
    instanceLookup: (moduleName: string, providerName: string) => unknown,
    onComplete?: (trace: RuntimeTrace) => void | Promise<void>,
  ) {
    return this.httpServeAdapter.post(
      path,
      async ({ request }) => {
        const body = await this.readJsonBody(request);
        const moduleName = typeof body.module === 'string' ? body.module : '';
        const providerName =
          typeof body.provider === 'string' ? body.provider : '';
        const methodName = typeof body.method === 'string' ? body.method : '';

        if (!moduleName || !providerName || !methodName) {
          return this.badRequest('module, provider, and method are required.');
        }

        const instance = instanceLookup(moduleName, providerName) as
          | Record<string, unknown>
          | undefined;
        if (!instance) {
          return this.notFound(
            `Provider ${moduleName}:${providerName} is unavailable.`,
          );
        }

        const method = instance[methodName];
        if (typeof method !== 'function') {
          return this.badRequest(
            `Method ${methodName} is unavailable for direct run.`,
          );
        }

        const argsResult = this.resolveArgs(body, methodName, method.length);
        if (!argsResult.ok) {
          return argsResult.response;
        }

        const traceIdentity = this.runtimeTraceRecorder.start({
          moduleName,
          providerName,
          methodName,
          args: argsResult.args,
        });

        const invokeMethod = async (): Promise<unknown> =>
          (await method.call(instance, ...argsResult.args)) as unknown;

        const payload: DirectRunResult = await (async () => {
          try {
            const result = this.runtimeTraceRecorder.runWithContext
              ? await this.runtimeTraceRecorder.runWithContext(
                  traceIdentity,
                  invokeMethod,
                )
              : await invokeMethod();
            const runtimeTrace = await this.runtimeTraceRecorder.finishSuccess(
              traceIdentity,
              result,
            );

            return {
              ok: true,
              method: methodName,
              result,
              runId: traceIdentity.runId,
              traceId: traceIdentity.traceId,
              runtimeTrace,
            };
          } catch (error) {
            const runtimeTrace = await this.runtimeTraceRecorder.finishError(
              traceIdentity,
              error,
            );

            return {
              ok: false,
              method: methodName,
              error:
                error instanceof Error ? error.message : 'Direct run failed.',
              runId: traceIdentity.runId,
              traceId: traceIdentity.traceId,
              runtimeTrace,
            };
          }
        })();

        if (payload.runtimeTrace && onComplete) {
          await onComplete(payload.runtimeTrace);
        }

        return {
          statusCode: 200,
          body: payload,
        } satisfies HttpServeResponse;
      },
      {
        responseHeaders: {
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
  }

  createHistoriesRoute(path: string) {
    return this.httpServeAdapter.get(
      path,
      () => this.runtimeTraceRecorder.getCompletedTraces(),
      {
        responseHeaders: {
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
  }

  createHistoryIndexRoute(path: string) {
    return this.httpServeAdapter.get(
      path,
      () =>
        this.runtimeTraceRecorder
          .getCompletedTraces()
          .map((trace) => this.historyIndexItem(trace)),
      {
        responseHeaders: {
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
  }

  createHistoryTraceRoute(path: string) {
    return this.httpServeAdapter.get(
      `${path}/*`,
      ({ request }) => {
        const traceId = this.traceIdFromPath(request.url ?? '', path);
        const trace = traceId
          ? this.runtimeTraceRecorder.getCompletedTrace(traceId)
          : undefined;

        return trace ?? this.notFound(`Trace ${traceId || ''} is unavailable.`);
      },
      {
        responseHeaders: {
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
  }

  private async readJsonBody(
    request: NodeJS.ReadableStream,
  ): Promise<Record<string, unknown>> {
    let body = '';

    for await (const chunk of request) {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    }

    if (!body.trim()) {
      return {};
    }

    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private resolveArgs(
    body: Record<string, unknown>,
    methodName: string,
    parameterCount: number,
  ): DirectRunArgsResult {
    if (!Object.prototype.hasOwnProperty.call(body, 'args')) {
      if (parameterCount > 0) {
        return {
          ok: false,
          response: this.badRequest(
            `Method ${methodName} requires arguments. Send args as JSON in the request body.`,
          ),
        };
      }

      return { ok: true, args: [] };
    }

    const input = body.args;
    if (parameterCount > 1 && !Array.isArray(input)) {
      return {
        ok: false,
        response: this.badRequest(
          `Method ${methodName} expects ${parameterCount} arguments. Send args as a JSON array.`,
        ),
      };
    }

    return {
      ok: true,
      args:
        parameterCount === 1 ? [input] : Array.isArray(input) ? input : [input],
    };
  }

  private badRequest(message: string): HttpServeResponse {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: message,
      } satisfies DirectRunResult,
    };
  }

  private notFound(message: string): HttpServeResponse {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: message,
      } satisfies DirectRunResult,
    };
  }

  private traceIdFromPath(url: string, basePath: string): string {
    const path = new URL(url, 'http://localhost').pathname;
    const traceId = decodeURIComponent(
      path.slice(`${basePath.replace(/\/$/, '')}/`.length),
    );
    return traceId.replace(/\.json$/, '');
  }

  private historyIndexItem(trace: RuntimeTrace) {
    return {
      traceId: trace.traceId,
      entrypoint: trace.entrypoint,
      startedAt: trace.startedAt,
      status: trace.status,
      totalDurationMs: trace.totalDurationMs,
    };
  }
}
