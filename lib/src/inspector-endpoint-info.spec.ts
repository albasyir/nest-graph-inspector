const { version } = require('../package.json') as { version: string };

describe('createInspectorEndpointInfo', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('uses exact version equality and caches the npm lookup', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version })));
    const { createInspectorEndpointInfo } =
      await import('./inspector-endpoint-info');

    await expect(createInspectorEndpointInfo(true)).resolves.toEqual({
      for: 'nest-graph-inspector',
      'is-static': true,
      version,
      latestVersion: version,
      isLatestVersion: true,
    });
    await expect(createInspectorEndpointInfo(false)).resolves.toEqual({
      for: 'nest-graph-inspector',
      'is-static': false,
      version,
      latestVersion: version,
      isLatestVersion: true,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/nest-graph-inspector/latest',
    );
  });

  it('returns the registry version and false when it differs', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: `${version}.0` })),
    );
    const { createInspectorEndpointInfo } =
      await import('./inspector-endpoint-info');

    await expect(createInspectorEndpointInfo(true)).resolves.toMatchObject({
      latestVersion: `${version}.0`,
      isLatestVersion: false,
    });
  });

  it('returns null and false when the npm lookup is unavailable or invalid', async () => {
    const fetch = jest.spyOn(global, 'fetch');

    jest.resetModules();
    fetch.mockRejectedValueOnce(new Error('npm unavailable'));
    let { createInspectorEndpointInfo } = await import('./inspector-endpoint-info');

    await expect(createInspectorEndpointInfo(true)).resolves.toMatchObject({
      latestVersion: null,
      isLatestVersion: false,
    });

    jest.resetModules();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: null })));
    ({ createInspectorEndpointInfo } = await import('./inspector-endpoint-info'));

    await expect(createInspectorEndpointInfo(true)).resolves.toMatchObject({
      latestVersion: null,
      isLatestVersion: false,
    });

    jest.resetModules();
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    ({ createInspectorEndpointInfo } = await import('./inspector-endpoint-info'));

    await expect(createInspectorEndpointInfo(true)).resolves.toMatchObject({
      latestVersion: null,
      isLatestVersion: false,
    });
  });
});
