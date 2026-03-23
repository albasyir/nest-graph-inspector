import { Modules } from './module.type';

export type ModuleMap = {
  version: string;
  root: string;
  modules: Record<string, Modules>;
};
