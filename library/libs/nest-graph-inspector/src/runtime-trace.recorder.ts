import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  DirectRunTraceRecorder,
  RuntimeTrace,
  RuntimeTraceSpan,
  RuntimeTraceSpanType,
} from './types/direct-run.type';

type ActiveTraceContext = {
  traceId: string;
  runId: string;
  moduleName: string;
  providerName: string;
  methodName: string;
  startedAtMs: number;
};

@Injectable()
export class RuntimeTraceRecorder implements DirectRunTraceRecorder {
  private activeContext: ActiveTraceContext | null = null;

  start(context: {
    moduleName: string;
    providerName: string;
    methodName: string;
    args: unknown[];
  }): { runId: string; traceId: string } {
    const traceId = randomUUID();
    const runId = randomUUID();

    this.activeContext = {
      traceId,
      runId,
      moduleName: context.moduleName,
      providerName: context.providerName,
      methodName: context.methodName,
      startedAtMs: Date.now(),
    };

    return { runId, traceId };
  }

  finishSuccess(result: unknown): RuntimeTrace {
    return this.finishTrace({ ok: true, result });
  }

  finishError(error: unknown): RuntimeTrace {
    return this.finishTrace({ ok: false, error });
  }

  private finishTrace(param: {
    ok: boolean;
    result?: unknown;
    error?: unknown;
  }): RuntimeTrace {
    const context = this.activeContext;
    if (!context) {
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

    this.activeContext = null;

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
      errorMessage: !param.ok ? this.resolveErrorMessage(param.error) : undefined,
      metadata: {
        ponytail: 'MVP root-only runtime trace; upgrade by adding nested span instrumentation around provider/dependency boundaries.',
        resultPreview: param.ok ? this.summarizeValue(param.result) : null,
      },
    };

    return {
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
    };
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
        return String(value);
      }

      return json.length > 160 ? `${json.slice(0, 159)}…` : json;
    } catch {
      return String(value);
    }
  }
}
