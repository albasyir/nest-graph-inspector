import { Test } from '@nestjs/testing';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import { NestGraphInspectorModule } from './nest-graph-inspector.module';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';

describe(NestGraphInspectorModule.name, () => {
  it('uses viewer output by default when imported without forRoot', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NestGraphInspectorModule],
    }).compile();

    expect(
      moduleRef.get<NestGraphInspectorModuleOptions>(MODULE_OPTIONS_TOKEN),
    ).toEqual({
      outputs: [{ type: 'viewer' }],
    });
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
