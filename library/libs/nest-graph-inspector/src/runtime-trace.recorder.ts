import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  DirectRunTraceRecorder,
  RuntimeTrace,
  RuntimeTraceHandle,
  RuntimeTraceSpan,
  RuntimeTraceSpanType,
  RuntimeTraceStartContext,
} from './types/direct-run.type';

type ActiveRuntimeTraceHandle = RuntimeTraceHandle & { rootSpanId: string };
type RuntimeTraceSpanInput = {
  name: string;
  type: RuntimeTraceSpanType;
  moduleName?: string;
  className?: string;
  methodName?: string;
  resource?: string;
  args?: unknown;
  metadata?: Record<string, string | number | boolean | null>;
};

@Injectable()
export class RuntimeTraceRecorder implements DirectRunTraceRecorder {
  private readonly activeContextStorage =
    new AsyncLocalStorage<ActiveRuntimeTraceHandle>();
  private readonly activeSpanStackStorage = new AsyncLocalStorage<string[]>();
  private readonly completedTraces = new Map<string, RuntimeTrace>();
  private readonly activeSpans = new Map<string, RuntimeTraceSpan[]>();

  start(context: RuntimeTraceStartContext): RuntimeTraceHandle {
    return {
      traceId: randomUUID(),
      runId: randomUUID(),
      rootSpanId: randomUUID(),
      startedAtMs: Date.now(),
      ...context,
    } as RuntimeTraceHandle;
  }

  finishSuccess(handle: RuntimeTraceHandle, result: unknown): RuntimeTrace {
    return this.finishTrace(handle, { ok: true, result });
  }

  finishError(handle: RuntimeTraceHandle, error: unknown): RuntimeTrace {
    return this.finishTrace(handle, { ok: false, error });
  }

  getCompletedTrace(traceId: string): RuntimeTrace | undefined {
    return this.completedTraces.get(traceId);
  }

  getCompletedTraces(): RuntimeTrace[] {
    return [...this.completedTraces.values()];
  }

  async runWithContext<T>(
    handle: RuntimeTraceHandle,
    callback: () => Promise<T>,
  ): Promise<T> {
    const activeHandle = handle as ActiveRuntimeTraceHandle;
    this.activeSpans.set(activeHandle.traceId, []);
    return await this.activeContextStorage.run(activeHandle, async () =>
      this.activeSpanStackStorage.run([activeHandle.rootSpanId], callback),
    );
  }

  recordSpan<T>(span: RuntimeTraceSpanInput, callback: () => T): T {
    const context = this.activeContextStorage.getStore();
    if (!context) {
      return callback();
    }

    if (this.isRootSpan(context, span)) {
      return callback();
    }

    const startedAtMs = Date.now();
    const spanId = randomUUID();
    const stack = this.activeSpanStackStorage.getStore() ?? [
      context.rootSpanId,
    ];
    stack.push(spanId);
    const parentSpanId = stack.at(-2);
    let isPendingPromise = false;

    try {
      const result = callback();
      if (this.isPromiseLike(result)) {
        isPendingPromise = true;
        return result.then(
          (value) => {
            this.pushSpan(
              context,
              span,
              spanId,
              parentSpanId,
              startedAtMs,
              true,
              undefined,
              value,
            );
            stack.pop();
            return value;
          },
          (error) => {
            this.pushSpan(
              context,
              span,
              spanId,
              parentSpanId,
              startedAtMs,
              false,
              error,
            );
            stack.pop();
            throw error;
          },
        ) as T;
      }

      this.pushSpan(
        context,
        span,
        spanId,
        parentSpanId,
        startedAtMs,
        true,
        undefined,
        result,
      );
      return result;
    } catch (error) {
      this.pushSpan(
        context,
        span,
        spanId,
        parentSpanId,
        startedAtMs,
        false,
        error,
      );
      throw error;
    } finally {
      if (!isPendingPromise && stack.at(-1) === spanId) {
        stack.pop();
      }
    }
  }

  private finishTrace(
    handle: RuntimeTraceHandle,
    param: {
      ok: boolean;
      result?: unknown;
      error?: unknown;
    },
  ): RuntimeTrace {
    const context =
      (handle as ActiveRuntimeTraceHandle) ||
      this.activeContextStorage.getStore();
    if (!context) {
      return this.persistCompletedTrace(this.buildFallbackTrace());
    }

    const endedAtMs = Date.now();
    const startedAt = new Date(context.startedAtMs).toISOString();
    const endedAt = new Date(endedAtMs).toISOString();
    const durationMs = Math.max(endedAtMs - context.startedAtMs, 0);
    const status = param.ok ? 'success' : 'error';
    const rootSpan: RuntimeTraceSpan = {
      spanId: context.rootSpanId,
      runId: context.runId,
      order: 0,
      name: `${context.providerName}.${context.methodName}`,
      moduleName: context.moduleName,
      className: context.providerName,
      methodName: context.methodName,
      startedAt,
      endedAt,
      durationMs,
      status,
      errorName: !param.ok ? this.resolveErrorName(param.error) : undefined,
      errorMessage: !param.ok
        ? this.resolveErrorMessage(param.error)
        : undefined,
      args: this.previewValue(context.args),
      result: param.ok
        ? this.previewValue(param.result)
        : this.errorResult(param.error),
    };

    const spans = [
      rootSpan,
      ...(this.activeSpans.get(context.traceId) || []),
    ].sort((left, right) => left.order - right.order);
    const failedSpan = spans.find((span) => span.status === 'error');

    this.activeSpans.delete(context.traceId);

    return this.persistCompletedTrace({
      traceId: context.traceId,
      runId: context.runId,
      entrypoint: {
        module: context.moduleName,
        className: context.providerName,
        methodName: context.methodName,
      },
      startedAt,
      endedAt,
      totalDurationMs: durationMs,
      status,
      totalSpans: spans.length,
      failedSpanId: failedSpan?.spanId,
      spans,
    });
  }

  private pushSpan(
    context: RuntimeTraceHandle,
    input: RuntimeTraceSpanInput,
    spanId: string,
    parentSpanId: string | undefined,
    startedAtMs: number,
    ok: boolean,
    error?: unknown,
    result?: unknown,
  ) {
    const endedAtMs = Date.now();
    const spans = this.activeSpans.get(context.traceId) || [];
    spans.push({
      spanId,
      parentSpanId,
      runId: context.runId,
      order: spans.length + 1,
      name: input.name,
      moduleName: input.moduleName,
      className: input.className,
      methodName: input.methodName,
      resource: input.resource,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(endedAtMs - startedAtMs, 0),
      status: ok ? 'success' : 'error',
      errorName: ok ? undefined : this.resolveErrorName(error),
      errorMessage: ok ? undefined : this.resolveErrorMessage(error),
      args: input.args,
      result: ok ? this.previewValue(result) : this.errorResult(error),
      metadata: input.metadata,
    });
    this.activeSpans.set(context.traceId, spans);
  }

  private isRootSpan(
    context: RuntimeTraceHandle,
    span: RuntimeTraceSpanInput,
  ): boolean {
    return (
      span.moduleName === context.moduleName &&
      span.className === context.providerName &&
      span.methodName === context.methodName
    );
  }

  private buildFallbackTrace(): RuntimeTrace {
    const now = new Date().toISOString();
    const traceId = randomUUID();
    const runId = randomUUID();

    return {
      traceId,
      runId,
      entrypoint: {
        methodName: 'unknown',
      },
      startedAt: now,
      endedAt: now,
      totalDurationMs: 0,
      status: 'partial',
      totalSpans: 0,
      spans: [],
    };
  }

  private persistCompletedTrace(trace: RuntimeTrace): RuntimeTrace {
    this.completedTraces.set(trace.traceId, trace);
    return trace;
  }

  private isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return Boolean(
      value &&
      (typeof value === 'object' || typeof value === 'function') &&
      'then' in value &&
      typeof (value as { then?: unknown }).then === 'function',
    );
  }

  private classifyProviderType(providerName: string): RuntimeTraceSpanType {
    const normalized = providerName.toLowerCase();
    if (normalized.endsWith('controller')) {
      return 'controller';
    }
    if (normalized.endsWith('repository')) {
      return 'repository';
    }
    if (normalized.endsWith('service') || normalized.endsWith('provider')) {
      return 'provider';
    }

    return 'unknown';
  }

  private resolveErrorName(error: unknown): string | undefined {
    return error instanceof Error ? error.name : undefined;
  }

  private resolveErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error) {
      return error.message;
    }

    return typeof error === 'string' ? error : undefined;
  }

  summarizeValue(value: unknown): string | null {
    if (value === undefined) {
      return null;
    }

    try {
      const json = JSON.stringify(value);
      if (json === undefined) {
        return null;
      }

      return json.length > 160 ? `${json.slice(0, 159)}…` : json;
    } catch {
      return '[unserializable]';
    }
  }

  previewValue(value: unknown): unknown {
    if (value === undefined) {
      return null;
    }

    try {
      JSON.stringify(value);
      return value;
    } catch {
      return '[unserializable]';
    }
  }

  private errorResult(error: unknown): { name?: string; message?: string } {
    return {
      name: this.resolveErrorName(error),
      message: this.resolveErrorMessage(error),
    };
  }
}
