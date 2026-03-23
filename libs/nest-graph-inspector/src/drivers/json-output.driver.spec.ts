import { writeFile } from 'node:fs/promises';

import { Test, TestingModule } from '@nestjs/testing';

import { JsonOutputDriver } from './json-output.driver';

jest.mock('node:fs/promises', () => ({
  writeFile: jest.fn(),
}));

describe(JsonOutputDriver.name, () => {
  let moduleRef: TestingModule;
  let driver: JsonOutputDriver;
  const mockedWriteFile = jest.mocked(writeFile);

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [JsonOutputDriver],
    }).compile();

    driver = moduleRef.get(JsonOutputDriver);
  });

  afterEach(() => {
    mockedWriteFile.mockReset();
    return moduleRef?.close();
  });

  it('should write moduleMap as pretty JSON to the configured path', async () => {
    mockedWriteFile.mockResolvedValue(undefined);

    const moduleMap = {
      AppModule: {
        imports: ['UserModule'],
        providers: ['AppService'],
      },
      UserModule: {
        imports: [],
        providers: ['UserService'],
      },
    };
    const config = {
      path: 'artifacts/module-map.json',
    };

    await driver.execute(moduleMap as never, config as never);

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      'artifacts/module-map.json',
      JSON.stringify(moduleMap, null, 2),
    );
  });

  it('should pass the exact config path to writeFile', async () => {
    mockedWriteFile.mockResolvedValue(undefined);

    const config = {
      path: './relative/path/output.json',
    };

    await driver.execute({} as never, config as never);

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      './relative/path/output.json',
      '{}',
    );
  });
});
