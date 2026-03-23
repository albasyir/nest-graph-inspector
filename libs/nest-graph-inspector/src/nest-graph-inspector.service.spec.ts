import { Test, TestingModule } from '@nestjs/testing';
import { NestJSDevtoolService } from './nest-graph-inspector.service';

describe(NestJSDevtoolService.name, () => {
  let service: NestJSDevtoolService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NestJSDevtoolService],
    }).compile();

    service = module.get<NestJSDevtoolService>(NestJSDevtoolService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
