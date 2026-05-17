import { Module } from '@nestjs/common';
import {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
} from './nest-graph-inspector.config';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';
import { JsonOutputAdapter } from './adapters/json-output.adapter';
import { FileOutputAdapter } from './adapters/file-output.adapter';
import { HttpOutputAdapter } from './adapters/http-output.adapter';
import { ViewerOutputAdapter } from './adapters/viewer-output.adapter';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';
import { ProxyAdapter } from './adapters/proxy.adapter';
import { HttpServeAdapter } from './adapters/http-serve.adapter';

export const defaultOptions: NestGraphInspectorModuleOptions = {
  outputs: [
    {
      type: 'viewer',
      ...HttpOutputAdapter.defaultConfig,
      ollama: {
        origin: 'http://localhost:11434',
        path: '/ollama',
      },
    },
  ],
  ignoreProvider: ['ModuleRef', 'ApplicationConfig'],
  ignoreImport: ['InternalCoreModule', 'NestGraphInspectorModule'],
  nestCoreModuleName: 'NestJSCoreModule',
  nestCoreProviders: [
    'ModuleRef',
    'ApplicationConfig',
    'Reflector',
    'REQUEST',
    'INQUIRER',
  ],
};

@Module({
  providers: [
    {
      provide: MODULE_OPTIONS_TOKEN,
      useValue: defaultOptions,
    },
    NestGraphInspectorSetup,
    JsonOutputAdapter,
    FileOutputAdapter,
    HttpServeAdapter,
    HttpOutputAdapter,
    ProxyAdapter,
    ViewerOutputAdapter,
  ],
})
export class NestGraphInspectorModule extends ConfigurableModuleClass {}
