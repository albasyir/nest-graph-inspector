import type { ModuleController } from './module-controller.type';
import type { ModuleProvider } from './module-provider.type';

export type Modules = {
  jsdoc?: string;
  providers: ModuleProvider[];
  controllers: ModuleController[];
  imports: string[];
  exports: string[];
};
