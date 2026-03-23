import { ConfigurableModuleBuilder } from '@nestjs/common';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<NestGraphInspectorModuleOptions>()
    .setClassMethodName('forRoot')
    .build();
