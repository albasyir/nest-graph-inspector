import { Module } from '@nestjs/common';
import {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
} from './nest-graph-inspector.config';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';
import { DiscoveryAdapter } from './adapters/discovery';
import { JsonOutputAdapter } from './adapters/json-output.adapter';
import { FileOutputAdapter } from './adapters/file-output.adapter';
import { HttpOutputAdapter } from './adapters/http-output.adapter';
import { ViewerOutputAdapter } from './adapters/viewer-output.adapter';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';
import { ProxyAdapter } from './adapters/proxy.adapter';
import { HttpServeAdapter } from './adapters/http-serve.adapter';
import { DirectRunOutputAdapter } from './adapters/direct-run-output.adapter';
import { RuntimeTraceRecorder } from './runtime-trace.recorder';
import { SourceMetadataService } from './source-metadata.service';
import { AccessTokenService } from './access-token.service';

export const defaultOptions: NestGraphInspectorModuleOptions = {
  outputs: [
    {
      type: 'viewer',
      ...HttpOutputAdapter.defaultConfig,
      ollama: {
        origin: 'http://127.0.0.1:11434',
        path: '/ollama',
      },
      directRun: {
        path: '/direct-run',
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
    DiscoveryAdapter,
    SourceMetadataService,
    AccessTokenService,
    JsonOutputAdapter,
    FileOutputAdapter,
    HttpServeAdapter,
    HttpOutputAdapter,
    ProxyAdapter,
    RuntimeTraceRecorder,
    DirectRunOutputAdapter,
    ViewerOutputAdapter,
  ],
  // Applications need this to mint their own token when logToken is off.
  exports: [AccessTokenService],
})
export class NestGraphInspectorModule extends ConfigurableModuleClass {}
