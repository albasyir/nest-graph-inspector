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

const COMPLETED_TRACE_TTL_MS = 10 * 1000;

@Injectable()
export class RuntimeTraceRecorder implements DirectRunTraceRecorder {
  private readonly activeContextStorage =
    new AsyncLocalStorage<RuntimeTraceHandle>();
  private readonly completedTraces = new Map<string, RuntimeTrace>();

  start(context: RuntimeTraceStartContext): RuntimeTraceHandle {
    return {
      traceId: randomUUID(),
      runId: randomUUID(),
      startedAtMs: Date.now(),
      ...context,
    };
  }

  finishSuccess(handle: RuntimeTraceHandle, result: unknown): RuntimeTrace {
    return this.finishTrace(handle, { ok: true, result });
  }

  finishError(handle: RuntimeTraceHandle, error: unknown): RuntimeTrace {
    return this.finishTrace(handle, { ok: false, error });
  }

  getCompletedTrace(traceId: string): RuntimeTrace | undefined {
    this.pruneCompletedTraces();
    return this.completedTraces.get(traceId);
  }

  async runWithContext<T>(
    handle: RuntimeTraceHandle,
    callback: () => Promise<T>,
  ): Promise<T> {
    return await this.activeContextStorage.run(handle, callback);
  }

  private finishTrace(
    handle: RuntimeTraceHandle,
    param: {
      ok: boolean;
      result?: unknown;
      error?: unknown;
    },
  ): RuntimeTrace {
    const context = handle || this.activeContextStorage.getStore();
    if (!context) {
      return this.persistCompletedTrace(this.buildFallbackTrace());
    }

    const endedAtMs = Date.now();
    const startedAt = new Date(context.startedAtMs).toISOString();
    const endedAt = new Date(endedAtMs).toISOString();
    const durationMs = Math.max(endedAtMs - context.startedAtMs, 0);
    const rootSpanId = randomUUID();
    const status = param.ok ? 'success' : 'error';
    const rootSpan: RuntimeTraceSpan = {
      spanId: rootSpanId,
      traceId: context.traceId,
      runId: context.runId,
      order: 0,
      name: `${context.providerName}.${context.methodName}`,
      type: this.classifyProviderType(context.providerName),
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
      metadata: {
        implementationNote:
          'MVP root-only runtime trace; upgrade by adding nested span instrumentation around provider/dependency boundaries.',
        resultPreview: param.ok ? this.summarizeValue(param.result) : null,
      },
    };

    return this.persistCompletedTrace({
      traceId: context.traceId,
      runId: context.runId,
      entrypoint: {
        module: context.moduleName,
        className: context.providerName,
        methodName: context.methodName,
        signature: `${context.providerName}.${context.methodName}()`,
      },
      startedAt,
      endedAt,
      totalDurationMs: durationMs,
      status,
      totalSpans: 1,
      failedSpanId: param.ok ? undefined : rootSpanId,
      slowestSpanId: rootSpanId,
      spans: [rootSpan],
    });
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
    this.pruneCompletedTraces();
    this.completedTraces.set(trace.traceId, trace);
    return trace;
  }

  private pruneCompletedTraces() {
    const cutoffMs = Date.now() - COMPLETED_TRACE_TTL_MS;
    for (const [traceId, trace] of this.completedTraces.entries()) {
      if (Date.parse(trace.endedAt) < cutoffMs) {
        this.completedTraces.delete(traceId);
      }
    }
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

  private summarizeValue(value: unknown): string | null {
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
}
