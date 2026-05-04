import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Test, TestingModule } from '@nestjs/testing';

import { JsonOutputDriver } from './json-output.driver';
import { ModuleMap } from '../types/module-map.type';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  writeFile: jest.fn(),
}));

describe(JsonOutputDriver.name, () => {
  let moduleRef: TestingModule;
  let driver: JsonOutputDriver;
  const mockedMkdir = jest.mocked(mkdir);
  const mockedWriteFile = jest.mocked(writeFile);

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [JsonOutputDriver],
    }).compile();

    driver = moduleRef.get(JsonOutputDriver);
  });

  afterEach(() => {
    mockedMkdir.mockReset();
    mockedWriteFile.mockReset();
    return moduleRef?.close();
  });

  it('should enrich dependencies with providedBy and token', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const moduleMap: ModuleMap = {
      version: '1',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: ['UserModule'],
          exports: [],
          providers: [
            {
              name: 'AppService',
              dependencies: ['UserModule:UserService'],
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
              dependencies: ['UserService'],
            },
          ],
        },
      },
    };

    const expectedOutput = {
      version: '1',
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

    const result = await driver.execute(moduleMap, config);

    expect(mockedMkdir).toHaveBeenCalledWith(
      dirname(join(process.cwd(), 'artifacts/module-map.json')),
      { recursive: true },
    );
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      join(process.cwd(), 'artifacts/module-map.json'),
      JSON.stringify(expectedOutput, null, 2),
    );
    expect(result).toEqual({
      message: `Graph inspector JSON output was written to ${join(process.cwd(), 'artifacts/module-map.json')}`,
    });
  });

  it('should pass the exact config path to writeFile', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const moduleMap: ModuleMap = {
      version: '1',
      root: 'App',
      modules: {},
    };
    const config = {
      type: 'json' as const,
      path: './relative/path/output.json',
    };

    const result = await driver.execute(moduleMap, config);

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      join(process.cwd(), './relative/path/output.json'),
      JSON.stringify(moduleMap, null, 2),
    );
    expect(result).toEqual({
      message: `Graph inspector JSON output was written to ${join(process.cwd(), './relative/path/output.json')}`,
    });
  });
});
