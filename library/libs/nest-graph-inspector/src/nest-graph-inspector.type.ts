import { Type } from '@nestjs/common';

export type NestGraphInspectorOutput =
  | { type: 'viewer'; origin?: string; path?: string }
  | { type: 'markdown'; path: string }
  | { type: 'json'; path: string }
  | { type: 'http'; path?: string };

export interface NestGraphInspectorModuleOptions {
  /**
   * Which "Root" of module that need to be inspect
   */
  rootModule?: Type;

  /**
   * type definition of output
   *
   * - `type: 'markdown'` writes a markdown (.md) dependency graph
   * - `type: 'json'` writes the raw module map as JSON
   * - `type: 'http'` serves the module map as JSON on the given route path
   * - `type: 'viewer'` serves the graph for the visualizer. If origin is provided,
   *   it prints a direct viewer URL. Otherwise, it prints the viewer URL and the
   *   endpoint path to enter in the viewer.
   */
  outputs?: NestGraphInspectorOutput[];

  /**
   * Provider names that should be hidden from module exports, provider lists,
   * and dependency resolution.
   *
   * Defaults to `['ModuleRef', 'ApplicationConfig']`.
   */
  ignoreProvider?: string[];

  /**
   * Module names that should be hidden from imports and graph output.
   *
   * Defaults to `['InternalCoreModule', 'NestGraphInspectorModule']`.
   */
  ignoreImport?: string[];

  /**
   * Virtual module name used when NestJS core providers are referenced.
   *
   * Defaults to `'NestJSCoreModule'`.
   */
  nestCoreModuleName?: string;

  /**
   * Provider names that should be grouped under the virtual NestJS core module.
   *
   * Defaults to `['ModuleRef', 'ApplicationConfig', 'Reflector', 'REQUEST', 'INQUIRER']`.
   */
  nestCoreProviders?: string[];
}
