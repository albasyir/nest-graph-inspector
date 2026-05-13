import { Module } from '@nestjs/common';
import {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
} from './nest-graph-inspector.config';
import { NestGraphInspectorSetup } from './nest-graph-inspector.setup';
import { JsonOutputAdapter } from './adapters/json-output.adapter';
import { FileOutputAdapter } from './adapters/file-output.adapter';
import {
  defaultHttpOutputHost,
  defaultHttpOutputPort,
  HttpOutputAdapter,
} from './adapters/http-output.adapter';
import { ViewerOutputAdapter } from './adapters/viewer-output.adapter';
import { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';
import { ProxyAdapter } from './adapters/proxy.adapter';
import type { ProxyGatewayOptions } from './ports/proxy.gateway';

export const defaultProxyGatewayOptions: ProxyGatewayOptions = {
  from: 'localhost:3999',
  to: 'localhost:11434',
  cors: {
    origins: [
      'https://albasyir.github.io',
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    ],
  },
};

export const defaultOptions: NestGraphInspectorModuleOptions = {
  outputs: [
    {
      type: 'viewer',
      host: defaultHttpOutputHost,
      port: defaultHttpOutputPort,
      proxy: defaultProxyGatewayOptions,
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
    HttpOutputAdapter,
    ProxyAdapter,
    ViewerOutputAdapter,
  ],
})
export class NestGraphInspectorModule extends ConfigurableModuleClass {}
