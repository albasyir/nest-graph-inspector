import { ModuleController } from './module-controller.type';
import { ModuleProvider } from './module-provider.type';

export type Modules = {
  providers: ModuleProvider[];
  controllers: ModuleController[];
  imports: string[];
  exports: string[];
};
