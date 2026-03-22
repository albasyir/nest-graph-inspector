import 'reflect-metadata';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { AppModule } from './app.module';

type Modules = {
  providers: string[];
  controllers: string[];
  imports: string[];
  exports: string[];
};

type ModuleMapNode = {
  id: string;
  name: string;
  providers: string[];
  controllers: string[];
  imports: string[];
  exports: string[];
};

type ModuleMap = {
  root: string;
  modules: Record<string, Modules>;
};

@Injectable()
export class ModuleGraphService implements OnModuleInit {
  constructor(private readonly modulesContainer: ModulesContainer) {}

  private ignoreProvider = ['ModuleRef', 'ApplicationConfig'];
  private ignoreImport = ['InternalCoreModule'];

  onModuleInit() {
    const moduleMap = this.buildModuleMap(AppModule);
    console.log(JSON.stringify(moduleMap, null, 2));
  }

  buildModuleMap(rootModuleClass: Function): ModuleMap {
    const root = [...this.modulesContainer.values()].find(
      (m) => m.metatype === rootModuleClass,
    );

    if (!root) {
      throw new Error(`Root module not found: ${rootModuleClass.name}`);
    }

    const reachable = this.collectReachableModules(root, new Set<string>());

    const modules: Record<string, Modules> = {};

    for (const moduleRef of reachable) {
      const moduleName = this.moduleName(moduleRef);
      if (this.ignoreImport.includes(moduleName)) {
        continue;
      }

      modules[moduleName] = {
        imports: [...moduleRef.imports.values()]
          .map((m: any) => this.moduleName(m))
          .filter((importName) => !this.ignoreImport.includes(importName)),
        exports: [...moduleRef.exports.values()]
          .map((exportedItem: any) =>
            this.wrapperName(exportedItem) || this.tokenName(exportedItem?.token || exportedItem),
          )
          .filter(
            (exportName): exportName is string =>
              !!exportName && !this.ignoreProvider.includes(exportName),
          ),
        providers: [...moduleRef.providers.values()]
          .map((wrapper: any) => this.wrapperName(wrapper))
          .filter(
            (providerName): providerName is string =>
              !!providerName &&
              !this.ignoreProvider.includes(providerName) &&
              providerName !== moduleName,
          ),
        controllers: [...moduleRef.controllers.values()]
          .map((w: any) => this.wrapperName(w))
          .filter((controllerName): controllerName is string => !!controllerName),
      };
    }

    return {
      root: this.moduleName(root),
      modules,
    };
  }

  private collectReachableModules(root: any, visited: Set<string>): any[] {
    const id = this.moduleId(root);
    if (visited.has(id)) return [];

    visited.add(id);

    const result = [root];
    for (const imported of root.imports.values()) {
      result.push(...this.collectReachableModules(imported, visited));
    }

    return result;
  }

  private moduleName(moduleRef: any): string {
    return moduleRef.metatype?.name || this.tokenName(moduleRef.token) || 'AnonymousModule';
  }

  private moduleId(moduleRef: any): string {
    return this.moduleName(moduleRef).replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private wrapperName(wrapper: any): string | null {
    return (
      wrapper?.metatype?.name ||
      wrapper?.instance?.constructor?.name ||
      this.tokenName(wrapper?.token) ||
      null
    );
  }

  private tokenName(token: any): string | null {
    if (!token) return null;
    if (typeof token === 'string') return token;
    if (typeof token === 'symbol') return token.toString();
    if (typeof token === 'function') return token.name;
    return String(token);
  }
}