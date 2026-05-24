import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';

import { FileOutputAdapter } from './file-output.adapter';
import type { GraphOutput } from '../types/graph-output.type';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  writeFile: jest.fn(),
}));

describe(FileOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: FileOutputAdapter;
  const mockedMkdir = jest.mocked(mkdir);
  const mockedWriteFile = jest.mocked(writeFile);
  const emptyCycles = () => ({
    modules: [],
    providers: [],
    controllers: [],
  });

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
    const graphOutput: GraphOutput = {
      version: '2',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [],
          controllers: [],
        },
      },
      cycles: emptyCycles(),
    };
    const filePath = join(process.cwd(), 'tmp/graph.md');

    const result = await adapter.execute(graphOutput, {
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
      cycles: emptyCycles(),
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

  it('renders provider-level circular dependency warnings on providers', () => {
    const graphOutput: GraphOutput = {
      version: '2',
      root: 'AppModule',
      modules: {
        ProductModule: {
          imports: ['UserModule'],
          exports: [],
          providers: [
            {
              name: 'ProductService',
              dependencies: [
                {
                  providedBy: { type: 'module', name: 'MobileModule' },
                  token: 'MobileService',
                },
              ],
            },
          ],
          controllers: [],
        },
        UserModule: {
          imports: ['MobileModule'],
          exports: ['MobileModule'],
          providers: [],
          controllers: [],
        },
        MobileModule: {
          imports: ['ProductModule'],
          exports: ['MobileService'],
          providers: [
            {
              name: 'MobileService',
              dependencies: [
                {
                  providedBy: { type: 'module', name: 'ProductModule' },
                  token: 'ProductService',
                },
              ],
            },
          ],
          controllers: [],
        },
      },
      cycles: {
        modules: [
          {
            id: 3,
            from: 'ProductModule',
            to: 'UserModule',
            type: 'indirect',
            path: [
              'ProductModule',
              'UserModule',
              'MobileModule',
              'ProductModule',
            ],
          },
          {
            id: 1,
            from: 'UserModule',
            to: 'MobileModule',
            type: 'indirect',
            path: ['UserModule', 'MobileModule', 'ProductModule', 'UserModule'],
          },
          {
            id: 2,
            from: 'MobileModule',
            to: 'ProductModule',
            type: 'indirect',
            path: [
              'MobileModule',
              'ProductModule',
              'UserModule',
              'MobileModule',
            ],
          },
        ],
        providers: [
          {
            id: 1,
            from: 'ProductModule:ProductService',
            to: 'MobileModule:MobileService',
            type: 'direct',
            path: [
              {
                module: { name: 'ProductModule' },
                provider: { name: 'ProductService' },
              },
              {
                module: { name: 'MobileModule' },
                provider: { name: 'MobileService' },
              },
              {
                module: { name: 'ProductModule' },
                provider: { name: 'ProductService' },
              },
            ],
          },
          {
            id: 2,
            from: 'MobileModule:MobileService',
            to: 'ProductModule:ProductService',
            type: 'direct',
            path: [
              {
                module: { name: 'MobileModule' },
                provider: { name: 'MobileService' },
              },
              {
                module: { name: 'ProductModule' },
                provider: { name: 'ProductService' },
              },
              {
                module: { name: 'MobileModule' },
                provider: { name: 'MobileService' },
              },
            ],
          },
        ],
        controllers: [],
      },
    };

    const markdown = adapter.buildMarkdownText(graphOutput);

    expect(markdown).toContain(
      [
        '## ProductModule',
        '',
        '> warnings',
        '> - indirect circular dependency with UserModule',
        '',
        '### Imports',
        '- UserModule',
        '',
        '### Providers',
        '- ProductService',
        '  - Warning: direct circular dependency with MobileService from MobileModule',
        '  - depends on MobileService from MobileModule',
      ].join('\n'),
    );
    expect(markdown).toContain(
      [
        '## MobileModule',
        '',
        '> warnings',
        '> - indirect circular dependency with ProductModule',
        '',
        '### Imports',
        '- ProductModule',
        '',
        '### Exports',
        '- MobileService',
        '',
        '### Providers',
        '- MobileService',
        '  - Warning: direct circular dependency with ProductService from ProductModule',
        '  - depends on ProductService from ProductModule',
      ].join('\n'),
    );
  });

  it('renders module-level circular dependency warnings on modules', () => {
    const graphOutput: GraphOutput = {
      version: '2',
      root: 'AppModule',
      modules: {
        UserModule: {
          imports: ['MobileModule'],
          exports: [],
          providers: [],
          controllers: [],
        },
        MobileModule: {
          imports: ['ProductModule'],
          exports: [],
          providers: [],
          controllers: [],
        },
        ProductModule: {
          imports: ['UserModule'],
          exports: [],
          providers: [],
          controllers: [],
        },
      },
      cycles: {
        modules: [
          {
            id: 1,
            from: 'UserModule',
            to: 'MobileModule',
            type: 'indirect',
            path: ['UserModule', 'MobileModule', 'ProductModule', 'UserModule'],
          },
          {
            id: 2,
            from: 'MobileModule',
            to: 'ProductModule',
            type: 'indirect',
            path: [
              'MobileModule',
              'ProductModule',
              'UserModule',
              'MobileModule',
            ],
          },
          {
            id: 3,
            from: 'ProductModule',
            to: 'UserModule',
            type: 'indirect',
            path: [
              'ProductModule',
              'UserModule',
              'MobileModule',
              'ProductModule',
            ],
          },
        ],
        providers: [],
        controllers: [],
      },
    };

    const markdown = adapter.buildMarkdownText(graphOutput);

    expect(markdown).toContain(
      [
        '## UserModule',
        '',
        '> warnings',
        '> - indirect circular dependency with MobileModule',
        '',
        '### Imports',
        '- MobileModule',
      ].join('\n'),
    );
    expect(markdown).toContain(
      [
        '## MobileModule',
        '',
        '> warnings',
        '> - indirect circular dependency with ProductModule',
        '',
        '### Imports',
        '- ProductModule',
      ].join('\n'),
    );
    expect(markdown).toContain(
      [
        '## ProductModule',
        '',
        '> warnings',
        '> - indirect circular dependency with UserModule',
        '',
        '### Imports',
        '- UserModule',
      ].join('\n'),
    );
  });

  it('renders unused import warnings on import items', () => {
    const graphOutput: GraphOutput = {
      version: '2',
      root: 'AppModule',
      modules: {
        ProductModule: {
          imports: ['UserModule', 'MobileModule'],
          exports: [],
          providers: [
            {
              name: 'ProductService',
              dependencies: [
                {
                  providedBy: { type: 'module', name: 'MobileModule' },
                  token: 'MobileService',
                },
              ],
            },
          ],
          controllers: [],
        },
        UserModule: {
          imports: [],
          exports: ['UserService'],
          providers: [{ name: 'UserService', dependencies: [] }],
          controllers: [],
        },
        MobileModule: {
          imports: [],
          exports: ['MobileService'],
          providers: [{ name: 'MobileService', dependencies: [] }],
          controllers: [],
        },
      },
      cycles: emptyCycles(),
    };

    const markdown = adapter.buildMarkdownText(graphOutput);

    expect(markdown).toContain(
      [
        '## ProductModule',
        '',
        '### Imports',
        '- UserModule',
        '  - Warning: unused import module',
        '- MobileModule',
        '',
        '### Providers',
        '- ProductService',
        '  - depends on MobileService from MobileModule',
      ].join('\n'),
    );
  });

  it('omits empty markdown sections', () => {
    const graphOutput: GraphOutput = {
      version: '2',
      root: 'AppModule',
      modules: {
        AppModule: {
          imports: [],
          exports: [],
          providers: [],
          controllers: [],
        },
      },
      cycles: emptyCycles(),
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
