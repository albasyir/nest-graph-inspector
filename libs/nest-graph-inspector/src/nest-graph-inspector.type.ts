import { Type } from '@nestjs/common';

export type NestGraphInspectorOutput =
  | { type: 'markdown'; path: string }
  | { type: 'json'; path: string }
  | { type: 'http'; path?: string };

export interface NestGraphInspectorModuleOptions {
  /**
   * Which "Root" of module that need to be inspect
   */
  rootModule: Type;

  /**
   * type definition of output
   * 
   * - `type: 'markdown'` writes a markdown (.md) dependency graph
   * - `type: 'json'` writes the raw module map as JSON
   * - `type: 'http'` serves the module map as JSON on the given route path
   */
  outputs?: NestGraphInspectorOutput[];
}