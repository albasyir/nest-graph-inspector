import { ModuleMap } from '../types/module-map.type';

export interface OutputAdapter<Config = unknown> {
  execute(moduleMap: ModuleMap, config: Config): Promise<{
    message: string;
  }>;
}
