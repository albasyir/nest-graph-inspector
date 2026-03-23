import { Test, TestingModule } from '@nestjs/testing';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';

describe(NestGraphInspectorSetup.name, () => {
  let service: NestGraphInspectorSetup;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NestGraphInspectorSetup],
    }).compile();

    service = module.get<NestGraphInspectorSetup>(NestGraphInspectorSetup);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
