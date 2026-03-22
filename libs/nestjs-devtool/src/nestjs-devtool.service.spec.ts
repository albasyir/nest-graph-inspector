import { Test, TestingModule } from '@nestjs/testing';
import { NestjsDevtoolService } from './nestjs-devtool.service';

describe('NestjsDevtoolService', () => {
  let service: NestjsDevtoolService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NestjsDevtoolService],
    }).compile();

    service = module.get<NestjsDevtoolService>(NestjsDevtoolService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
