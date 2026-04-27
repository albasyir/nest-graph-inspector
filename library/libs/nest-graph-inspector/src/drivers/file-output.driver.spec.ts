import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';

import { FileOutputDriver } from './file-output.driver';
import { ModuleMap } from '../types/module-map.type';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  writeFile: jest.fn(),
}));

describe(FileOutputDriver.name, () => {
  let moduleRef: TestingModule;
  let driver: FileOutputDriver;
  const mockedMkdir = jest.mocked(mkdir);
  const mockedWriteFile = jest.mocked(writeFile);

  beforeEach(async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    moduleRef = await Test.createTestingModule({
      providers: [FileOutputDriver],
    }).compile();

    driver = moduleRef.get(FileOutputDriver);
  });

  afterEach(() => {
    mockedMkdir.mockReset();
    mockedWriteFile.mockReset();
    return moduleRef.close();
  });

  it('creates the target directory before writing markdown', async () => {
    const moduleMap: ModuleMap = {
      version: '1',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [],
          controllers: [],
        },
      },
    };
    const filePath = join(process.cwd(), 'tmp/graph.md');

    const result = await driver.execute(moduleMap, {
      type: 'markdown',
      path: 'tmp/graph.md',
    });

    expect(mockedMkdir).toHaveBeenCalledWith(dirname(filePath), {
      recursive: true,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      filePath,
      expect.stringContaining('# NestJS Dependency Graph'),
      'utf8',
    );
    expect(result).toEqual({
      message: `Graph inspector markdown output was written to ${filePath}`,
    });
  });
});
