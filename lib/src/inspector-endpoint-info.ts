const { version } = require('../package.json') as { version: string };

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
