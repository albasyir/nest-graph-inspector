import { Type } from '@nestjs/common';

type MdFile = `${string}.md`;
type JsonFile = `${string}.json`;

export interface NestGraphInspectorOutput {
  /**
   * Absolute path to the output file.
   * Use `.md` extension to render markdown, or `.json` to render the module map as JSON.
   */
  file: MdFile | JsonFile;
}

export interface NestGraphInspectorModuleOptions {
  /**
   * Which "Root" of module that need to be inspect
   */
  rootModule: Type;

  /**
   * Output configuration. If omitted, no file is written.
   */
  output?: NestGraphInspectorOutput;
}
