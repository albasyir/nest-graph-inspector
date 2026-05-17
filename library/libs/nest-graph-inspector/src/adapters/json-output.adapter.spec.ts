import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Test, TestingModule } from '@nestjs/testing';

import { JsonOutputAdapter } from './json-output.adapter';
import type { GraphOutput } from '../types/graph-output.type';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  writeFile: jest.fn(),
}));

describe(JsonOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: JsonOutputAdapter;
  const mockedMkdir = jest.mocked(mkdir);
  const mockedWriteFile = jest.mocked(writeFile);

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [JsonOutputAdapter],
    }).compile();

    adapter = moduleRef.get(JsonOutputAdapter);
  });

  afterEach(() => {
    mockedMkdir.mockReset();
    mockedWriteFile.mockReset();
    return moduleRef?.close();
  });

  it('should write enriched GraphOutput as JSON', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const graphOutput: GraphOutput = {
      version: '2',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: ['UserModule'],
          exports: [],
          providers: [
            {
              name: 'AppService',
              dependencies: [
                {
                  providedBy: { type: 'module', name: 'UserModule' },
                  token: 'UserService',
                },
              ],
            },
          ],
          controllers: [],
        },
        UserModule: {
          imports: [],
          exports: ['UserService'],
          providers: [
            { name: 'UserService', dependencies: [] },
            { name: 'UserRepository', dependencies: [] },
          ],
          controllers: [
            {
              name: 'UserController',
              dependencies: [
                {
                  providedBy: { type: 'module', name: 'UserModule' },
                  token: 'UserService',
                },
              ],
            },
          ],
        },
      },
    };

    const config = { type: 'json' as const, path: 'artifacts/module-map.json' };
    const expectedJsonOutput = graphOutput;

    const result = await adapter.execute(graphOutput, config);

    expect(mockedMkdir).toHaveBeenCalledWith(
      dirname(join(process.cwd(), 'artifacts/module-map.json')),
      { recursive: true },
    );
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      join(process.cwd(), 'artifacts/module-map.json'),
      JSON.stringify(expectedJsonOutput, null, 2),
    );
    expect(graphOutput.modules.AppModule.providers[0].dependencies[0]).toEqual({
      providedBy: { type: 'module', name: 'UserModule' },
      token: 'UserService',
    });
    expect(result).toEqual({
      message: `Graph inspector JSON output was written to ${join(process.cwd(), 'artifacts/module-map.json')}`,
    });
  });

  it('should pass the exact config path to writeFile', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const graphOutput: GraphOutput = {
      version: '2',
      root: 'App',
      modules: {},
    };
    const config = {
      type: 'json' as const,
      path: './relative/path/output.json',
    };

    const result = await adapter.execute(graphOutput, config);

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      join(process.cwd(), './relative/path/output.json'),
      JSON.stringify(graphOutput, null, 2),
    );
    expect(result).toEqual({
      message: `Graph inspector JSON output was written to ${join(process.cwd(), './relative/path/output.json')}`,
    });
  });
});
