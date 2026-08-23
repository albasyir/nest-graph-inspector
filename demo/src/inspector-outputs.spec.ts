import {
  INSPECTOR_TARGET_ENV,
  NODEPOD_TARGET,
  NODEPOD_TOKEN_TTL_MS,
  VIEWER_PORT,
  resolveInspectorAccessToken,
  resolveInspectorOutputs,
  resolveInspectorTarget,
} from './inspector-outputs';

describe('resolveInspectorTarget', () => {
  it('reads the target from the environment', () => {
    expect(resolveInspectorTarget(NODEPOD_TARGET)).toBe('nodepod');
  });

  it('falls back to the local target for anything else', () => {
    expect(resolveInspectorTarget(undefined)).toBe('local');
    expect(resolveInspectorTarget('')).toBe('local');
    expect(resolveInspectorTarget('production')).toBe('local');
  });

  it('defaults to the environment variable the payload manifest sets', () => {
    const previous = process.env[INSPECTOR_TARGET_ENV];
    process.env[INSPECTOR_TARGET_ENV] = NODEPOD_TARGET;

    try {
      expect(resolveInspectorTarget()).toBe('nodepod');
    } finally {
      if (previous === undefined) {
        delete process.env[INSPECTOR_TARGET_ENV];
      } else {
        process.env[INSPECTOR_TARGET_ENV] = previous;
      }
    }
  });
});

describe('resolveInspectorAccessToken', () => {
  it('leaves the library default in place on a developer machine', () => {
    expect(resolveInspectorAccessToken('local')).toBeUndefined();
  });

  it('gives the browser demo a token that outlives a working day', () => {
    expect(resolveInspectorAccessToken('nodepod')).toEqual({
      ttlMs: NODEPOD_TOKEN_TTL_MS,
    });
    expect(NODEPOD_TOKEN_TTL_MS).toBeGreaterThan(3 * 60 * 60 * 1000);
  });
});

describe('resolveInspectorOutputs', () => {
  it('serves the viewer on the library default port for both targets', () => {
    for (const target of ['local', 'nodepod'] as const) {
      const viewer = resolveInspectorOutputs(target).find(
        (output) => output.type === 'viewer',
      );

      expect(viewer).toEqual({
        type: 'viewer',
        host: 'localhost',
        port: VIEWER_PORT,
      });
    }
  });

  it('writes no files in the browser, where the viewer serves everything from the running application', () => {
    expect(resolveInspectorOutputs('nodepod')).toEqual([
      { type: 'viewer', host: 'localhost', port: VIEWER_PORT },
    ]);
  });

  it('writes graph files inside the demo directory only', () => {
    const filePaths = (['local', 'nodepod'] as const).flatMap((target) =>
      resolveInspectorOutputs(target)
        .filter(
          (output) => output.type === 'json' || output.type === 'markdown',
        )
        .map((output) => output.path),
    );

    expect(filePaths.length).toBeGreaterThan(0);
    for (const path of filePaths) {
      expect(path.startsWith('tmp/')).toBe(true);
    }
  });

  it('only adds the file and second-port outputs a developer machine can use', () => {
    const localTypes = resolveInspectorOutputs('local').map(
      (output) => output.type,
    );
    const nodepodTypes = resolveInspectorOutputs('nodepod').map(
      (output) => output.type,
    );

    expect(localTypes).toEqual(['viewer', 'markdown', 'json', 'http']);
    expect(nodepodTypes).toEqual(['viewer']);
  });
});
