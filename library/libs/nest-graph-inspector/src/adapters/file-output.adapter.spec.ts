import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';

import { FileOutputAdapter } from './file-output.adapter';
import type { GraphOutput } from '../types/graph-output.type';
import type { ModuleMap } from '../types/module-map.type';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  writeFile: jest.fn(),
}));

describe(FileOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: FileOutputAdapter;
  const mockedMkdir = jest.mocked(mkdir);
  const mockedWriteFile = jest.mocked(writeFile);

  beforeEach(async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    moduleRef = await Test.createTestingModule({
      providers: [FileOutputAdapter],
    }).compile();

    adapter = moduleRef.get(FileOutputAdapter);
  });

  afterEach(() => {
    mockedMkdir.mockReset();
    mockedWriteFile.mockReset();
    return moduleRef.close();
  });

  it('creates the target directory before writing markdown', async () => {
    const moduleMap: ModuleMap = {
      version: '0',
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

    const result = await adapter.execute(moduleMap, {
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

  it('renders Mermaid edges from consumer to dependency', () => {
    const graphOutput: GraphOutput = {
      version: '0',
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
                {
                  providedBy: { type: 'module', name: 'NestJSCoreModule' },
                  token: 'ModuleRef',
                },
              ],
            },
          ],
          controllers: [
            {
              name: 'AppController',
              dependencies: [
                {
                  providedBy: { type: 'module', name: 'AppModule' },
                  token: 'AppService',
                },
              ],
            },
          ],
        },
        UserModule: {
          imports: [],
          exports: ['UserService'],
          providers: [{ name: 'UserService', dependencies: [] }],
          controllers: [],
        },
      },
    };

    const markdown = adapter.buildMarkdownText(graphOutput);

    expect(markdown.startsWith('# NestJS Dependency Graph')).toBe(true);
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain(
      [
        '```',
        '',
        '> Arrow direction: `A --> B` means `A` depends on `B`.',
        '',
        '## AppModule',
      ].join('\n'),
    );
    expect(markdown).not.toContain('  subgraph legend["Legend"]');
    expect(markdown).toContain(
      '  module_group_AppModule --> module_group_UserModule',
    );
    expect(markdown).toContain(
      '  provider_AppModule_AppService --> provider_UserModule_UserService',
    );
    expect(markdown).toContain(
      '  provider_AppModule_AppService --> dependency_AppModule_AppService_NestJSCoreModule_ModuleRef',
    );
    expect(markdown).toContain(
      '  controller_AppModule_AppController --> provider_AppModule_AppService',
    );
    expect(markdown).not.toContain(
      '  module_group_UserModule --> module_group_AppModule',
    );
    expect(markdown).not.toContain(
      '  provider_UserModule_UserService --> provider_AppModule_AppService',
    );
    expect(markdown).not.toContain(
      '  dependency_AppModule_AppService_NestJSCoreModule_ModuleRef --> provider_AppModule_AppService',
    );
    expect(markdown).toContain('### Imports');
    expect(markdown).toContain('- UserModule');
    expect(markdown).toContain('### Exports');
    expect(markdown).toContain('### Providers');
    expect(markdown).toContain('  - depends on UserService from UserModule');
    expect(markdown).toContain('### Controllers');
    expect(markdown).not.toContain('- None');
  });

  it('omits empty markdown sections', () => {
    const graphOutput: GraphOutput = {
      version: '0',
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

    const markdown = adapter.buildMarkdownText(graphOutput);

    expect(markdown).toContain('## AppModule');
    expect(markdown).not.toContain('### Imports');
    expect(markdown).not.toContain('### Exports');
    expect(markdown).not.toContain('### Providers');
    expect(markdown).not.toContain('### Controllers');
    expect(markdown).not.toContain('- None');
  });
});
