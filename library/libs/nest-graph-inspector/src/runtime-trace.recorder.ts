import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  DirectRunTraceRecorder,
  RuntimeTrace,
  RuntimeTraceHandle,
  RuntimeTraceSpan,
  RuntimeTraceSpanStatus,
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
  private readonly pendingSpans = new Map<string, Set<Promise<void>>>();

  start(context: RuntimeTraceStartContext): RuntimeTraceHandle {
    return {
      traceId: randomUUID(),
      runId: randomUUID(),
      rootSpanId: randomUUID(),
      startedAtMs: Date.now(),
      ...context,
    } as RuntimeTraceHandle;
  }

  async finishSuccess(
    handle: RuntimeTraceHandle,
    result: unknown,
  ): Promise<RuntimeTrace> {
    return await this.finishTrace(handle, { ok: true, result });
  }

  async finishError(
    handle: RuntimeTraceHandle,
    error: unknown,
  ): Promise<RuntimeTrace> {
    return await this.finishTrace(handle, { ok: false, error });
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
    this.pendingSpans.set(activeHandle.traceId, new Set());
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
    const parentStack = this.activeSpanStackStorage.getStore() ?? [
      context.rootSpanId,
    ];
    const stack = [...parentStack, spanId];
    const parentSpanId = parentStack.at(-1);

    return this.activeSpanStackStorage.run(stack, () => {
      try {
      const result = callback();
      if (this.isPromiseLike(result)) {
        this.pushSpan(
          context,
          span,
          spanId,
          parentSpanId,
          startedAtMs,
          'partial',
          undefined,
          undefined,
          { async: true },
        );
        const pendingSpan = result.then(
          (value) => {
            this.updateSpan(
              context,
              spanId,
              startedAtMs,
              'success',
              undefined,
              value,
              { async: true },
            );
            return value;
          },
          (error) => {
            this.updateSpan(
              context,
              spanId,
              startedAtMs,
              'error',
              error,
              undefined,
              { async: true },
            );
            throw error;
          },
        );
        const trackedPendingSpan = Promise.resolve(pendingSpan).then(
          () => undefined,
          () => undefined,
        );
        this.trackPendingSpan(context.traceId, trackedPendingSpan);
        return pendingSpan as T;
      }

      this.pushSpan(
        context,
        span,
        spanId,
        parentSpanId,
        startedAtMs,
        'success',
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
        'error',
        error,
      );
      throw error;
      }
    });
  }

  private async finishTrace(
    handle: RuntimeTraceHandle,
    param: {
      ok: boolean;
      result?: unknown;
      error?: unknown;
    },
  ): Promise<RuntimeTrace> {
    const context =
      (handle as ActiveRuntimeTraceHandle) ||
      this.activeContextStorage.getStore();
    if (!context) {
      return this.persistCompletedTrace(this.buildFallbackTrace());
    }

    const startedAt = new Date(context.startedAtMs).toISOString();
    const status = param.ok ? 'success' : 'error';
    this.markPendingSpansNotAwaited(context.traceId);
    await this.waitForPendingSpans(context.traceId);
    const endedAtMs = Date.now();
    const endedAt = new Date(endedAtMs).toISOString();
    const durationMs = Math.max(endedAtMs - context.startedAtMs, 0);
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
    this.pendingSpans.delete(context.traceId);

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
    status: RuntimeTraceSpanStatus,
    error?: unknown,
    result?: unknown,
    metadata?: Record<string, string | number | boolean | null>,
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
      status,
      errorName: status === 'error' ? this.resolveErrorName(error) : undefined,
      errorMessage:
        status === 'error' ? this.resolveErrorMessage(error) : undefined,
      args: input.args,
      result:
        status === 'error' ? this.errorResult(error) : this.previewValue(result),
      metadata: { ...input.metadata, ...metadata },
    });
    this.activeSpans.set(context.traceId, spans);
  }

  private updateSpan(
    context: RuntimeTraceHandle,
    spanId: string,
    startedAtMs: number,
    status: RuntimeTraceSpanStatus,
    error?: unknown,
    result?: unknown,
    metadata?: Record<string, string | number | boolean | null>,
  ) {
    const spans = this.activeSpans.get(context.traceId);
    const span = spans?.find((item) => item.spanId === spanId);
    if (!span) return;

    const endedAtMs = Date.now();
    span.endedAt = new Date(endedAtMs).toISOString();
    span.durationMs = Math.max(endedAtMs - startedAtMs, 0);
    span.status = status;
    span.errorName =
      status === 'error' ? this.resolveErrorName(error) : undefined;
    span.errorMessage =
      status === 'error' ? this.resolveErrorMessage(error) : undefined;
    span.result =
      status === 'error' ? this.errorResult(error) : this.previewValue(result);
    span.metadata = { ...span.metadata, ...metadata };
  }

  private trackPendingSpan(traceId: string, promise: Promise<void>) {
    const promises = this.pendingSpans.get(traceId);
    if (!promises) return;

    promises.add(promise);
    promise.finally(() => promises.delete(promise));
  }

  private async waitForPendingSpans(traceId: string) {
    const promises = this.pendingSpans.get(traceId);
    if (!promises?.size) return;

    await Promise.all([...promises]);
  }

  private markPendingSpansNotAwaited(traceId: string) {
    const spans = this.activeSpans.get(traceId) || [];
    for (const span of spans) {
      if (span.status === 'partial' && span.metadata?.async) {
        span.metadata = { ...span.metadata, awaited: false };
      }
    }
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
