import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './nest-graph-inspector.config';
import { NestGraphInspectorService } from './nest-graph-inspector.service';

@Module({
  providers: [NestGraphInspectorService],
  exports: [NestGraphInspectorService],
})
export class NestGraphInspectorModule extends ConfigurableModuleClass {}
