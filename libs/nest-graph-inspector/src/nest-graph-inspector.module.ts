import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './nest-graph-inspector.config';
import { NestJSDevtoolService } from './nest-graph-inspector.service';

@Module({
  providers: [NestJSDevtoolService],
  exports: [NestJSDevtoolService],
})
export class NestjsDevtoolModule extends ConfigurableModuleClass {}
