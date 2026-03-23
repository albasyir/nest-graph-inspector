import { Test, TestingModule } from '@nestjs/testing';
import { NestGraphInspectorService } from './nest-graph-inspector.service';

describe(NestGraphInspectorService.name, () => {
  let service: NestGraphInspectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NestGraphInspectorService],
    }).compile();

    service = module.get<NestGraphInspectorService>(NestGraphInspectorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
