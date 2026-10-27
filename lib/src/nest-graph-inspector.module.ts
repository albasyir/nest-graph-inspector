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
import {
  NestGraphInspectorIgnoreOptions,
  NestGraphInspectorModuleOptions,
} from './nest-graph-inspector.type';
import { HttpServeAdapter } from './adapters/http-serve.adapter';
import { DirectRunOutputAdapter } from './adapters/direct-run-output.adapter';
import { RuntimeTraceRecorder } from './runtime-trace.recorder';
import { SourceMetadataService } from './source-metadata.service';
import { AccessTokenService } from './access-token.service';

/**
 * The `ignore.paths` applied when neither `paths` nor its alias `path` is
 * configured. Setting either replaces this list, so spread it into the new
 * one to keep it: `paths: [...DEFAULT_IGNORE_PATHS, '/admin']`.
 */
export const DEFAULT_IGNORE_PATHS = ['**/node_modules/**'] as const;

/**
 * `NestGraphInspectorModuleOptions.ignore` when it is not configured. Each
 * category falls back to its own entry here only while none of its keys is
 * set.
 */
export const DEFAULT_IGNORE_OPTIONS: NestGraphInspectorIgnoreOptions = {
  paths: [...DEFAULT_IGNORE_PATHS],
};

export const defaultOptions: NestGraphInspectorModuleOptions = {
  outputs: [
    {
      type: 'viewer',
      ...HttpOutputAdapter.defaultConfig,
      directRun: {
        path: '/direct-run',
      },
    },
  ],
  ignore: DEFAULT_IGNORE_OPTIONS,
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
    RuntimeTraceRecorder,
    DirectRunOutputAdapter,
    ViewerOutputAdapter,
  ],
  // Applications need this to mint their own token when logToken is off.
  exports: [AccessTokenService],
})
export class NestGraphInspectorModule extends ConfigurableModuleClass {}
