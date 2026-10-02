import { Injectable } from '@nestjs/common';
import { StringDecoder } from 'node:string_decoder';
import type { HttpServeResponse } from './http-serve.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import type { DirectRunResult, DirectRunTargetType } from '../types/direct-run.type';
import { RuntimeTraceRecorder } from '../runtime-trace.recorder';
import type { RuntimeTrace } from '../types/direct-run.type';
import {
  BUILTIN_PROTOTYPES,
  DIRECT_RUN_EXCLUDED_METHODS,
} from '../direct-run.constants';

type DirectRunArgsResult =
  | { ok: true; args: unknown[] }
  | { ok: false; response: HttpServeResponse };
type DirectRunBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: HttpServeResponse };
type DirectRunMethodResult =
  | { ok: true; method: (...args: unknown[]) => unknown }
  | { ok: false; response: HttpServeResponse };
type DirectRunTargetResult =
  | { ok: true; target: DirectRunTargetType; name: string }
  | { ok: false; response: HttpServeResponse };

const TARGET_LABEL: Record<DirectRunTargetType, string> = {
  provider: 'Provider',
  controller: 'Controller',
};

export type DirectRunRouteOptions = {
  /**
   * Permissive (default, `true`): any callable method found on a provider's
   * prototype chain or instance may be invoked; a controller is narrower —
   * only a direct method of its own, never a lifecycle hook, getter, or
   * inherited method. Strict (`false`): only methods `allowedMethodsLookup`
   * advertises, and only when not shadowed on the instance.
   */
  allowUnsafeMethods?: boolean;

  /** Defaults to 50 MiB. `0` or negative removes the limit. */
  maxBodySizeBytes?: number;
};

const DEFAULT_MAX_JSON_BODY_BYTES = 50 * 1024 * 1024;

@Injectable()
export class DirectRunOutputAdapter {
  constructor(
    private readonly httpServeAdapter: HttpServeAdapter,
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
  ) {}

  createRoute(
    path: string,
    instanceLookup: (
      target: DirectRunTargetType,
      moduleName: string,
      name: string,
    ) => unknown,
    allowedMethodsLookup: (
      target: DirectRunTargetType,
      moduleName: string,
      name: string,
    ) => ReadonlySet<string> | undefined,
    options: DirectRunRouteOptions = {},
    onComplete?: (trace: RuntimeTrace) => void | Promise<void>,
  ) {
    const allowUnsafeMethods = options.allowUnsafeMethods ?? true;
    const maxBodySizeBytes =
      options.maxBodySizeBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;

    return this.httpServeAdapter.post(
      path,
      async ({ request }) => {
        const bodyResult = await this.readJsonBody(request, maxBodySizeBytes);
        if (!bodyResult.ok) {
          return bodyResult.response;
        }

        const { body } = bodyResult;
        const targetResult = this.resolveTarget(body);
        if (!targetResult.ok) {
          return targetResult.response;
        }

        const { target, name } = targetResult;
        const moduleName = typeof body.module === 'string' ? body.module : '';
        const methodName = typeof body.method === 'string' ? body.method : '';

        if (!moduleName || !name || !methodName) {
          return this.badRequest(
            `module, ${target}, and method are required.`,
          );
        }

        const instance = instanceLookup(target, moduleName, name) as
          | Record<string, unknown>
          | undefined;
        if (!instance) {
          return this.notFound(
            `${TARGET_LABEL[target]} ${moduleName}:${name} is unavailable.`,
          );
        }

        const methodResult = allowUnsafeMethods
          ? target === 'controller'
            ? this.resolvePermissiveControllerMethod(instance, methodName)
            : this.resolvePermissiveMethod(instance, methodName)
          : this.resolveStrictMethod(
              instance,
              methodName,
              allowedMethodsLookup(target, moduleName, name),
            );
        if (!methodResult.ok) {
          return methodResult.response;
        }

        const { method } = methodResult;
        const argsResult = this.resolveArgs(body, methodName, method.length);
        if (!argsResult.ok) {
          return argsResult.response;
        }

        const traceIdentity = this.runtimeTraceRecorder.start({
          moduleName,
          // Holds the provider or controller class name regardless of
          // `target` — a label for the trace, not a claim about which table
          // it was resolved from.
          providerName: name,
          methodName,
          args: argsResult.args,
        });

        const invokeMethod = async (): Promise<unknown> =>
          await method.call(instance, ...argsResult.args);

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
    maxBodySizeBytes: number,
  ): Promise<DirectRunBodyResult> {
    const limit =
      maxBodySizeBytes > 0 ? maxBodySizeBytes : Number.POSITIVE_INFINITY;
    let body = '';
    let byteLength = 0;
    const decoder = new StringDecoder('utf8');

    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > limit) {
        request.resume?.();
        return {
          ok: false,
          response: this.payloadTooLarge(),
        };
      }

      body += decoder.write(buffer);
    }

    body += decoder.end();

    if (!body.trim()) {
      return { ok: true, body: {} };
    }

    try {
      return { ok: true, body: JSON.parse(body) as Record<string, unknown> };
    } catch {
      return { ok: true, body: {} };
    }
  }

  /**
   * Strict mode: only a method `allowedMethodsLookup` advertises, resolved
   * as an own property of the provider's immediate prototype and never
   * shadowed on the instance itself.
   */
  private resolveStrictMethod(
    instance: Record<string, unknown>,
    methodName: string,
    allowedMethods: ReadonlySet<string> | undefined,
  ): DirectRunMethodResult {
    if (!allowedMethods?.has(methodName)) {
      return {
        ok: false,
        response: this.badRequest(
          `Method ${methodName} is unavailable for direct run.`,
        ),
      };
    }

    if (Object.hasOwn(instance, methodName)) {
      return {
        ok: false,
        response: this.badRequest(
          `Method ${methodName} is unavailable for direct run.`,
        ),
      };
    }

    const prototype = Object.getPrototypeOf(instance) as
      | Record<string, unknown>
      | null;
    const method =
      prototype &&
      Object.getOwnPropertyDescriptor(prototype, methodName)?.value;
    if (typeof method !== 'function') {
      return {
        ok: false,
        response: this.badRequest(
          `Method ${methodName} is unavailable for direct run.`,
        ),
      };
    }

    return { ok: true, method: method as (...args: unknown[]) => unknown };
  }

  /**
   * Permissive mode (default): any callable method found on the instance or
   * its prototype chain may be invoked, including ones TypeScript would have
   * marked `private` or `protected` — that keyword does not survive
   * compilation, so it was never a runtime boundary. `constructor` is the
   * one name refused outright: it builds the instance rather than acting on
   * it, so invoking it as a plain method call is not a provider "method" in
   * any sense a caller intends.
   */
  private resolvePermissiveMethod(
    instance: Record<string, unknown>,
    methodName: string,
  ): DirectRunMethodResult {
    if (methodName === 'constructor') {
      return {
        ok: false,
        response: this.badRequest(
          `Method ${methodName} is unavailable for direct run.`,
        ),
      };
    }

    const ownValue = Object.hasOwn(instance, methodName)
      ? instance[methodName]
      : undefined;
    const prototype = Object.getPrototypeOf(instance) as
      | Record<string, unknown>
      | null;
    const method =
      typeof ownValue === 'function' ? ownValue : prototype?.[methodName];
    if (typeof method !== 'function') {
      return {
        ok: false,
        response: this.badRequest(
          `Method ${methodName} is unavailable for direct run.`,
        ),
      };
    }

    return { ok: true, method: method as (...args: unknown[]) => unknown };
  }

  /**
   * `target` is optional and defaults to `"provider"` so every request built
   * before this field existed (`{ module, provider, method, args }`) keeps
   * resolving exactly as it did. A present-but-unrecognised value is a
   * deterministic rejection rather than a silent fallback to either target.
   * The name is read only from the field matching the resolved target — a
   * `controller` value is never read from `body.provider` or vice versa —
   * so a request can never be ambiguous about which instance table it means.
   */
  private resolveTarget(body: Record<string, unknown>): DirectRunTargetResult {
    const rawTarget = body.target;
    const target = rawTarget === undefined ? 'provider' : rawTarget;

    if (target !== 'provider' && target !== 'controller') {
      return {
        ok: false,
        response: this.badRequest(
          `Unknown direct run target ${JSON.stringify(rawTarget)}.`,
        ),
      };
    }

    const nameField = target === 'controller' ? body.controller : body.provider;

    return {
      ok: true,
      target,
      name: typeof nameField === 'string' ? nameField : '',
    };
  }

  /**
   * Controller permissive mode resolves only a direct controller method: a
   * function-valued own property of the instance or, when the instance has
   * no own property of that name, a method declared on the controller's own
   * class — its immediate prototype, unless that is a shared built-in
   * (`BUILTIN_PROTOTYPES`). The constructor and Nest lifecycle hooks are
   * refused by name, and anything inherited — from a base class, or from
   * `Object.prototype` (`toString`, `valueOf`, …) — never resolves at all.
   * This is a deliberate divergence from provider permissive mode, which
   * searches the whole prototype chain and refuses only `constructor` (see
   * `docs/architecture.md`): controllers are a new invocation surface with
   * no existing DX contract to preserve.
   *
   * Both lookups read a property descriptor, never the property itself: a
   * read would run an accessor's getter — controller code — while deciding
   * whether anything may run at all. An accessor has no `value`, so it is
   * refused like any other non-function property, without being called.
   */
  private resolvePermissiveControllerMethod(
    instance: Record<string, unknown>,
    methodName: string,
  ): DirectRunMethodResult {
    const prototype = Object.getPrototypeOf(instance) as object | null;
    const descriptor =
      Object.getOwnPropertyDescriptor(instance, methodName) ??
      (prototype && !BUILTIN_PROTOTYPES.has(prototype)
        ? Object.getOwnPropertyDescriptor(prototype, methodName)
        : undefined);
    const method: unknown = descriptor?.value;

    if (
      DIRECT_RUN_EXCLUDED_METHODS.has(methodName) ||
      typeof method !== 'function'
    ) {
      return {
        ok: false,
        response: this.badRequest(
          `Method ${methodName} is unavailable for direct run.`,
        ),
      };
    }

    return { ok: true, method: method as (...args: unknown[]) => unknown };
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

  private payloadTooLarge(): HttpServeResponse {
    return {
      statusCode: 413,
      body: {
        ok: false,
        error: 'Request body is too large.',
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
