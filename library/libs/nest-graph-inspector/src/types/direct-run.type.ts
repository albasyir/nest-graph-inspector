export type RuntimeTraceStatus = 'success' | 'error' | 'partial';

export type RuntimeTraceSpanStatus =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'partial'
  | 'unknown';

export type RuntimeTraceSpanType =
  | 'controller'
  | 'provider'
  | 'repository'
  | 'database'
  | 'external-http'
  | 'external-queue'
  | 'framework'
  | 'unknown';

export type DirectRunProviderMethod = {
  name: string;
  parameterTypes: string;
};

export type DirectRunProviderMeta = {
  methods: DirectRunProviderMethod[];
};

export type RuntimeTraceEntrypoint = {
  module?: string;
  className?: string;
  methodName: string;
  signature?: string;
};

export type RuntimeTraceSpan = {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  runId: string;
  order: number;
  name: string;
  type: RuntimeTraceSpanType;
  moduleName?: string;
  className?: string;
  methodName?: string;
  resource?: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  status: RuntimeTraceSpanStatus;
  errorName?: string;
  errorMessage?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type RuntimeTrace = {
  traceId: string;
  runId: string;
  entrypoint: RuntimeTraceEntrypoint;
  startedAt: string;
  endedAt: string;
  totalDurationMs: number;
  status: RuntimeTraceStatus;
  totalSpans: number;
  failedSpanId?: string;
  slowestSpanId?: string;
  spans: RuntimeTraceSpan[];
};

export type DirectRunResult = {
  ok: boolean;
  method?: string;
  result?: unknown;
  error?: string;
  runId?: string;
  traceId?: string;
  runtimeTrace?: RuntimeTrace;
};

export type DirectRunTraceRecorder = {
  start(context: {
    moduleName: string;
    providerName: string;
    methodName: string;
    args: unknown[];
  }): { runId: string; traceId: string };
  finishSuccess(result: unknown): RuntimeTrace;
  finishError(error: unknown): RuntimeTrace;
};
