import { Injectable } from '@nestjs/common';
import type { HttpServeResponse } from './http-serve.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import type { DirectRunResult } from '../types/direct-run.type';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';

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

        try {
          const invokeMethod = async (): Promise<unknown> =>
            await method.call(instance, ...argsResult.args) as unknown;
          const result = this.runtimeTraceRecorder.runWithContext
            ? await this.runtimeTraceRecorder.runWithContext(
                traceIdentity,
                invokeMethod,
              )
            : await invokeMethod();
          const runtimeTrace = this.runtimeTraceRecorder.finishSuccess(
            traceIdentity,
            result,
          );
          const payload: DirectRunResult = {
            ok: true,
            method: methodName,
            result,
            runId: traceIdentity.runId,
            traceId: traceIdentity.traceId,
            runtimeTrace,
          };

          return {
            statusCode: 200,
            body: payload,
          } satisfies HttpServeResponse;
        } catch (error) {
          const runtimeTrace = this.runtimeTraceRecorder.finishError(
            traceIdentity,
            error,
          );
          const payload: DirectRunResult = {
            ok: false,
            method: methodName,
            error:
              error instanceof Error ? error.message : 'Direct run failed.',
            runId: traceIdentity.runId,
            traceId: traceIdentity.traceId,
            runtimeTrace,
          };

          return {
            statusCode: 500,
            body: payload,
          } satisfies HttpServeResponse;
        }
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
}
