import { ConfigurableModuleBuilder } from '@nestjs/common';

export type MdFile = `${string}.md`;
export type JsonFile = `${string}.json`;

export interface NestjsDevtoolOutput {
  /**
   * Absolute path to the output file.
   * Use `.md` extension to render markdown, or `.json` to render the module map as JSON.
   */
  file: MdFile | JsonFile;
}

export interface NestjsDevtoolModuleOptions {
  /**
   * Which "Root" of module that need to be inspect
   */
  rootModule: Function;

  /**
   * Output configuration. If omitted, no file is written.
   */
  output?: NestjsDevtoolOutput;
}

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<NestjsDevtoolModuleOptions>()
    .setClassMethodName('forRoot')
    .build();
