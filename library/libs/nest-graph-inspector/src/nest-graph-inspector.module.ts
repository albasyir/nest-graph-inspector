import { Module } from '@nestjs/common';
import {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
} from './nest-graph-inspector.config';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';
import { JsonOutputDriver } from './drivers/json-output.driver';
import { FileOutputDriver } from './drivers/file-output.driver';
import { HttpOutputDriver } from './drivers/http-output.driver';
import { ViewerOutputDriver } from './drivers/viewer-output.driver';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';

const defaultOptions: NestGraphInspectorModuleOptions = {
  outputs: [{ type: 'viewer' }],
};

@Module({
  providers: [
    {
      provide: MODULE_OPTIONS_TOKEN,
      useValue: defaultOptions,
    },
    NestGraphInspectorSetup,
    JsonOutputDriver,
    FileOutputDriver,
    HttpOutputDriver,
    ViewerOutputDriver,
  ],
})
export class NestGraphInspectorModule extends ConfigurableModuleClass { }
