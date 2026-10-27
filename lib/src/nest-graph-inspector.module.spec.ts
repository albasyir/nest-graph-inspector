import { Test } from '@nestjs/testing';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import { HttpOutputAdapter } from './adapters/http-output.adapter';
import {
  DEFAULT_IGNORE_OPTIONS,
  DEFAULT_IGNORE_PATHS,
  defaultOptions,
  NestGraphInspectorModule,
} from './nest-graph-inspector.module';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';
import * as publicApi from './index';

describe(NestGraphInspectorModule.name, () => {
  it('uses viewer output by default when imported without forRoot', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestGraphInspectorModule],
    }).compile();

    expect(
      moduleRef.get<NestGraphInspectorModuleOptions>(MODULE_OPTIONS_TOKEN),
    ).toEqual({
      outputs: [
        {
          type: 'viewer',
          ...HttpOutputAdapter.defaultConfig,
          directRun: {
            path: '/direct-run',
          },
        },
      ],
      ignore: { paths: ['**/node_modules/**'] },
      nestCoreModuleName: 'NestJSCoreModule',
      nestCoreProviders: [
        'ModuleRef',
        'ApplicationConfig',
        'Reflector',
        'REQUEST',
        'INQUIRER',
      ],
    });
  });

  it('ignores only node_modules paths by default', () => {
    expect(DEFAULT_IGNORE_PATHS).toEqual(['**/node_modules/**']);
    expect(DEFAULT_IGNORE_OPTIONS).toEqual({ paths: ['**/node_modules/**'] });
    expect(defaultOptions.ignore).toBe(DEFAULT_IGNORE_OPTIONS);
  });

  it('exports the default ignore constants from the package entry point', () => {
    // Consumers spread these to extend the defaults rather than replace them.
    expect(publicApi.DEFAULT_IGNORE_PATHS).toBe(DEFAULT_IGNORE_PATHS);
    expect(publicApi.DEFAULT_IGNORE_OPTIONS).toBe(DEFAULT_IGNORE_OPTIONS);
    expect(publicApi.DEFAULT_IGNORE_PATHS).toEqual(['**/node_modules/**']);
    expect(publicApi.DEFAULT_IGNORE_OPTIONS).toEqual({
      paths: ['**/node_modules/**'],
    });
  });

  it('keeps the default viewer output to its graph and direct-run keys', () => {
    // The default viewer output used to carry the origin and path of a local
    // LLM daemon it relayed browser requests to. Inference now runs in the
    // browser, so any key beyond these is a re-introduction to be caught here
    // rather than shipped.
    const viewerOutput = defaultOptions.outputs?.find(
      (output) => output.type === 'viewer',
    );

    expect(viewerOutput).toBeDefined();
    expect(Object.keys(viewerOutput ?? {})).toEqual([
      'type',
      ...Object.keys(HttpOutputAdapter.defaultConfig),
      'directRun',
    ]);
  });

  it('uses configured options when imported with forRoot', async () => {
    const options: NestGraphInspectorModuleOptions = {
      outputs: [{ type: 'json', path: 'graph.json' }],
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NestGraphInspectorModule.forRoot(options)],
    }).compile();

    expect(
      moduleRef.get<NestGraphInspectorModuleOptions>(MODULE_OPTIONS_TOKEN),
    ).toEqual(options);
  });
});
