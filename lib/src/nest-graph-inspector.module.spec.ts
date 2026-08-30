import { Test } from '@nestjs/testing';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import { HttpOutputAdapter } from './adapters/http-output.adapter';
import {
  defaultOptions,
  NestGraphInspectorModule,
} from './nest-graph-inspector.module';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';

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
      ignoreProvider: ['ModuleRef', 'ApplicationConfig'],
      ignoreImport: ['InternalCoreModule', 'NestGraphInspectorModule'],
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
