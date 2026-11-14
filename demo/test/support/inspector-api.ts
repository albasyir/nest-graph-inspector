import Ajv2020 from 'ajv/dist/2020';
import {
  ACCESS_TOKEN_HEADER,
  type GraphOutput,
  type RuntimeTraceEntrypoint,
  type RuntimeTraceSpan,
  type RuntimeTraceSpanStatus,
  type RuntimeTraceStatus,
} from 'nest-graph-inspector';
import { z } from 'zod';

/**
 * The oldest graph format the viewer opens:
 * `MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION` in
 * `site/app/utils/graph-output-support.ts`.
 */
export const VIEWER_MINIMUM_GRAPH_VERSION = 3;

/**
 * Where Direct Run is mounted: the library's default, at the root of the
 * viewer output's own server rather than under the graph endpoint's path —
 * where the viewer looks for it too (`site/app/utils/inspector-endpoint-url.ts`).
 */
const DIRECT_RUN_PATH = '/direct-run';

export type InspectorResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly contentType: string;
  readonly text: string;
};

/** Long enough for a demo whose repositories take their time to answer. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * One request to the inspector, or to the application beside it. The access
 * token, when there is one, travels in the header the viewer sends it in.
 * A server that accepts the connection and never answers fails it once
 * `timeoutMs` has passed, rather than holding the caller forever.
 */
export async function inspectorRequest({
  url,
  token,
  method = 'GET',
  json,
  headers = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: {
  url: URL;
  token?: string;
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<InspectorResponse> {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(token === undefined ? {} : { [ACCESS_TOKEN_HEADER]: token }),
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

  return {
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

/** A file served under a graph endpoint: `<endpoint>/<name>`. */
export function endpointFile(endpoint: URL, name: string): URL {
  return new URL(`${endpoint.pathname.replace(/\/+$/, '')}/${name}`, endpoint);
}

/** A Direct Run route on the server a graph endpoint is served from. */
export function directRunUrl(endpoint: URL, subpath = ''): URL {
  return new URL(`${DIRECT_RUN_PATH}${subpath}`, endpoint);
}

export function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(text);

  return schema.parse(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses `output.json` and checks it against `output.schema.json` — the
 * library's own statement of the contract, served by the same process — so
 * the document is a `GraphOutput` only once it has been shown to be one.
 */
export function parseGraphOutput({
  graphText,
  schemaText,
}: {
  graphText: string;
  schemaText: string;
}): GraphOutput {
  const schema: unknown = JSON.parse(schemaText);

  if (!isJsonObject(schema)) {
    throw new Error('output.schema.json is not a JSON object');
  }

  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile<GraphOutput>(schema);
  const graph: unknown = JSON.parse(graphText);

  if (!validate(graph)) {
    throw new Error(
      `output.json does not satisfy output.schema.json: ${ajv.errorsText(validate.errors)}`,
    );
  }

  return graph;
}

/** `information.json`: the handshake the viewer probes an endpoint with. */
export const inspectorInformationSchema = z.object({
  for: z.literal('nest-graph-inspector'),
  'is-static': z.boolean(),
  version: z.string().min(1),
  latestVersion: z.string().nullable(),
  isLatestVersion: z.boolean(),
});

export type InspectorInformation = z.infer<typeof inspectorInformationSchema>;

const traceStatusSchema = z.enum([
  'success',
  'error',
  'partial',
]) satisfies z.ZodType<RuntimeTraceStatus>;

const spanStatusSchema = z.enum([
  'success',
  'error',
  'cancelled',
  'partial',
  'unknown',
]) satisfies z.ZodType<RuntimeTraceSpanStatus>;

const entrypointSchema = z.object({
  module: z.string().optional(),
  className: z.string().optional(),
  methodName: z.string(),
}) satisfies z.ZodType<RuntimeTraceEntrypoint>;

const spanSchema = z.object({
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  moduleName: z.string().optional(),
  className: z.string().optional(),
  methodName: z.string().optional(),
  status: spanStatusSchema,
  durationMs: z.number(),
}) satisfies z.ZodType<
  Pick<
    RuntimeTraceSpan,
    | 'spanId'
    | 'parentSpanId'
    | 'name'
    | 'moduleName'
    | 'className'
    | 'methodName'
    | 'status'
    | 'durationMs'
  >
>;

/** A completed `RuntimeTrace`, as far as these suites read one. */
export const runtimeTraceSchema = z.object({
  traceId: z.string().min(1),
  runId: z.string().min(1),
  entrypoint: entrypointSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  totalDurationMs: z.number(),
  status: traceStatusSchema,
  totalSpans: z.number(),
  spans: z.array(spanSchema),
});

export type RecordedTrace = z.infer<typeof runtimeTraceSchema>;

/** `GET /direct-run/histories`: every completed trace. */
export const traceHistorySchema = z.array(runtimeTraceSchema);

/** `GET /direct-run/history/index.json`, and the index file beside the traces. */
export const traceIndexSchema = z.array(
  z.object({
    traceId: z.string().min(1),
    entrypoint: entrypointSchema,
    startedAt: z.string(),
    status: traceStatusSchema,
    totalDurationMs: z.number(),
  }),
);

/** `POST /direct-run` when the method ran and returned. */
export const directRunSuccessSchema = z.object({
  ok: z.literal(true),
  method: z.string(),
  runId: z.string().min(1),
  traceId: z.string().min(1),
  runtimeTrace: runtimeTraceSchema,
});

/** `POST {path}/layout` when the layout was saved. */
export const layoutSavedSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
});
