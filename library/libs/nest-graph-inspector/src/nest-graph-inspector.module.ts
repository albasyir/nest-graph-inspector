import { Module } from '@nestjs/common';
import { ConfigurableModuleClass } from './nest-graph-inspector.config';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';
import { JsonOutputDriver } from './drivers/json-output.driver';
import { FileOutputDriver } from './drivers/file-output.driver';
import { HttpOutputDriver } from './drivers/http-output.driver';
import { ViewerOutputDriver } from './drivers/viewer-output.driver';

@Module({
  providers: [
    NestGraphInspectorSetup,
    JsonOutputDriver,
    FileOutputDriver,
    HttpOutputDriver,
    ViewerOutputDriver,
  ],
})
export class NestGraphInspectorModule extends ConfigurableModuleClass { }
