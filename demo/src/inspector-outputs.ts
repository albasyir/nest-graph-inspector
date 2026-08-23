import type {
  NestGraphInspectorAccessTokenOptions,
  NestGraphInspectorOutput,
} from 'nest-graph-inspector';

/**
 * Environment variable that tells the demo where it is running.
 */
export const INSPECTOR_TARGET_ENV = 'NEST_GRAPH_INSPECTOR_TARGET';

/**
 * Value of {@link INSPECTOR_TARGET_ENV} used by the documentation site, which
 * runs this very build inside the visitor's browser through nodepod.
 */
export const NODEPOD_TARGET = 'nodepod';

export type InspectorTarget = 'local' | 'nodepod';

/**
 * Port the viewer output listens on. It is the library default, so the demo
 * behaves the same as an application that passes no port at all.
 */
export const VIEWER_PORT = 53371;

/**
 * Lifetime of the browser demo's access token. Long enough that a tab left
 * open over a working day still answers.
 */
export const NODEPOD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Access token settings for a given target.
 *
 * The browser demo's server is reachable only from the tab that started it, so
 * rotating its token protects nothing and expiring one only breaks a tab that
 * was left open. A real deployment should keep the library default, which is
 * what the local target does.
 */
export function resolveInspectorAccessToken(
  target: InspectorTarget = resolveInspectorTarget(),
): NestGraphInspectorAccessTokenOptions | undefined {
  return target === 'nodepod' ? { ttlMs: NODEPOD_TOKEN_TTL_MS } : undefined;
}

export function resolveInspectorTarget(
  value: string | undefined = process.env[INSPECTOR_TARGET_ENV],
): InspectorTarget {
  return value === NODEPOD_TARGET ? 'nodepod' : 'local';
}

/**
 * Outputs the demo installs for a given target.
 *
 * A browser has no repository to write graph files into and no second port
 * worth spending, so the viewer endpoint carries the whole demo there on its
 * own. Nothing is lost by leaving the file outputs out: the viewer serves the
 * graph, the markdown and the direct-run history from the running application
 * rather than from disk.
 */
export function resolveInspectorOutputs(
  target: InspectorTarget = resolveInspectorTarget(),
): NestGraphInspectorOutput[] {
  if (target === 'nodepod') {
    return [{ type: 'viewer', host: 'localhost', port: VIEWER_PORT }];
  }

  return [
    { type: 'viewer', host: 'localhost', port: VIEWER_PORT },
    { type: 'markdown', path: 'tmp/graph/output.md' },
    { type: 'json', path: 'tmp/graph/output.json' },
    { type: 'http', host: 'localhost', port: 53372, path: 'graph' },
  ];
}
