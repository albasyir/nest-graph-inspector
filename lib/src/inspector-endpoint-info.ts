const { version } = require('../package.json') as { version: string };

/**
 * How long the npm lookup behind `latestVersion` may take.
 *
 * The lookup happens while the inspector installs its outputs, which happens
 * while the host application is starting. Somewhere that cannot reach the
 * registry but does not refuse either — an offline network, a proxy that
 * blackholes — an unbounded request would hold up the application's own
 * startup, so this reports no version instead of waiting.
 */
const LATEST_VERSION_TIMEOUT_MS = 2000;

let latestVersionPromise: Promise<string | null> | undefined;

export const createInspectorEndpointInfo = async (isStatic: boolean) => {
  const latestVersion = await getLatestVersion();

  return {
    for: 'nest-graph-inspector',
    'is-static': isStatic,
    version,
    latestVersion,
    isLatestVersion: latestVersion === version,
  };
};

const getLatestVersion = (): Promise<string | null> =>
  (latestVersionPromise ??= fetch(
    'https://registry.npmjs.org/nest-graph-inspector/latest',
    { signal: AbortSignal.timeout(LATEST_VERSION_TIMEOUT_MS) },
  )
    .then(async (response) => {
      if (!response.ok) {
        return null;
      }

      const metadata: unknown = await response.json();
      return (
        typeof metadata === 'object' &&
        metadata !== null &&
        'version' in metadata &&
        typeof metadata.version === 'string' &&
        metadata.version
          ? metadata.version
          : null
      );
    })
    .catch(() => null));
