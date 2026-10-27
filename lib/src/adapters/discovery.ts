import { Inject, Injectable, Type } from "@nestjs/common";
import { MODULE_PATH, PATH_METADATA } from "@nestjs/common/constants";
import type {
  InjectionToken,
  OptionalFactoryDependency,
} from "@nestjs/common/interfaces";
import { ModulesContainer } from "@nestjs/core";
import type { InstanceWrapper } from "@nestjs/core/injector/instance-wrapper";
import type { Module } from "@nestjs/core/injector/module";
import { MODULE_OPTIONS_TOKEN } from "../nest-graph-inspector.config";
import type {
  IgnorePattern,
  NestGraphInspectorIgnoreOptions,
  NestGraphInspectorModuleOptions,
} from "../nest-graph-inspector.type";
import {
  defaultOptions,
  NestGraphInspectorModule,
} from "../nest-graph-inspector.module";
import { ModuleController } from "../types/module-controller.type";
import { ModuleProvider } from "../types/module-provider.type";
import { RuntimeTraceSpanType } from "../types/direct-run.type";
import { RuntimeTraceRecorder } from "../runtime-trace.recorder";
import { SourceMetadataService } from "../source-metadata.service";
import { BUILTIN_PROTOTYPES } from "../direct-run.constants";

export type ModuleTree = {
  name: string;
  jsdoc?: string;
  moduleRef: Module | null;
  imports: string[];
  exports: string[];
  providers: ModuleProvider[];
  providerInstances: Map<string, unknown>;
  controllers: ModuleController[];
  controllerInstances: Map<string, unknown>;
  children: ModuleTree[];
};

type RuntimeTraceMetadata = {
  moduleName: string;
  className: string;
  type: RuntimeTraceSpanType;
};

type RuntimeTraceInstrumentation = RuntimeTraceMetadata & {
  recorder: RuntimeTraceRecorder;
};

const runtimeTraceInstrumentedPrototypes = new WeakSet<object>();
const runtimeTraceInstrumentationByInstance = new WeakMap<
  object,
  RuntimeTraceInstrumentation
>();

/**
 * The traced wrapper replaces the original method on the shared prototype,
 * so anything reading the wrapper's own source — parameter names via
 * `Function.prototype.toString`, for instance — sees the wrapper's signature
 * instead of the method it wraps. This recovers the original.
 */
export type AnyFunction = (...args: unknown[]) => unknown;

export const originalTracedMethods = new WeakMap<AnyFunction, AnyFunction>();

export function getOriginalTracedMethod(
  method: AnyFunction,
): AnyFunction | undefined {
  return originalTracedMethods.get(method);
}

type IgnoreMatcher = (value: string) => boolean;

type IgnoreCategory = "modules" | "providers" | "controllers" | "paths";

/** Every key that feeds a category; singular keys are aliases. */
const IGNORE_CATEGORY_KEYS: Record<
  IgnoreCategory,
  (keyof NestGraphInspectorIgnoreOptions)[]
> = {
  modules: ["modules", "module"],
  providers: ["providers", "provider", "inject"],
  controllers: ["controllers", "controller"],
  paths: ["paths", "path"],
};

/**
 * The patterns configured for one category, falling back to the default
 * for that category alone when none of its keys is set — so configuring
 * `controllers` does not discard the default module and provider lists.
 */
function resolveIgnorePatterns(
  category: IgnoreCategory,
  configured: NestGraphInspectorIgnoreOptions | undefined,
  fallback: NestGraphInspectorIgnoreOptions | undefined,
): IgnorePattern[] {
  const collect = (
    options: NestGraphInspectorIgnoreOptions | undefined,
  ): IgnorePattern[] | undefined => {
    const values = IGNORE_CATEGORY_KEYS[category].flatMap((key) => {
      const value = options?.[key];
      return value === undefined ? [] : [value];
    });

    return values.length ? values.flat() : undefined;
  };

  return collect(configured) ?? collect(fallback) ?? [];
}

/**
 * `*` matches within one path segment, `**` across segments, and `**\/`
 * also matches no segment at all, so `'**\/admin'` matches `'admin'`.
 */
function globToRegExp(glob: string): RegExp {
  let source = "";

  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char !== "*") {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }

    if (glob[index + 1] !== "*") {
      source += "[^/]*";
      continue;
    }

    index++;
    if (glob[index + 1] === "/") {
      index++;
      source += "(?:.*/)?";
    } else {
      source += ".*";
    }
  }

  return new RegExp(`^${source}$`);
}

/**
 * A copy without the `g` and `y` flags, whose `lastIndex` would otherwise
 * make `test()` alternate between results on repeated calls.
 */
function statelessRegExp(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

function createNameMatcher(pattern: IgnorePattern): IgnoreMatcher {
  if (pattern instanceof RegExp) {
    const regExp = statelessRegExp(pattern);
    return (value) => regExp.test(value);
  }

  const text = String(pattern);
  if (!text.includes("*")) {
    return (value) => value === text;
  }

  const regExp = globToRegExp(text);
  return (value) => regExp.test(value);
}

/** Expects values already passed through `normalizePath`. */
function createPathMatcher(pattern: IgnorePattern): IgnoreMatcher {
  if (pattern instanceof RegExp) {
    const regExp = statelessRegExp(pattern);
    return (value) => regExp.test(value);
  }

  const text = normalizePath(String(pattern));
  if (text.includes("*")) {
    const regExp = globToRegExp(text);
    return (value) => regExp.test(value);
  }

  return (value) => value === text || value.startsWith(`${text}/`);
}

/**
 * One leading slash, no trailing slash, no empty segments, and `/` as the
 * only separator, so `'admin/'`, `'/admin'`, and `'\\admin'` compare equal.
 */
function normalizePath(path: string): string {
  return `/${path.replace(/\\/g, "/").split("/").filter(Boolean).join("/")}`;
}

function matchesAny(
  matchers: IgnoreMatcher[],
  values: Iterable<string | null | undefined>,
): boolean {
  if (!matchers.length) {
    return false;
  }

  for (const value of values) {
    if (value && matchers.some((matcher) => matcher(value))) {
      return true;
    }
  }

  return false;
}

function stringMetadata(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

@Injectable()
export class DiscoveryAdapter {
  private readonly moduleIgnoreMatchers: IgnoreMatcher[];
  private readonly providerIgnoreMatchers: IgnoreMatcher[];
  private readonly controllerIgnoreMatchers: IgnoreMatcher[];
  private readonly pathIgnoreMatchers: IgnoreMatcher[];
  private readonly nestCoreModuleName: string;
  private readonly nestCoreProviders: string[];
  private cachedTree: ModuleTree | undefined;

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: NestGraphInspectorModuleOptions,
    private readonly modulesContainer: ModulesContainer,
    private readonly runtimeTraceRecorder: RuntimeTraceRecorder,
    private readonly sourceMetadata: SourceMetadataService,
  ) {
    const ignorePatterns = (category: IgnoreCategory) =>
      resolveIgnorePatterns(
        category,
        this.options.ignore,
        defaultOptions.ignore,
      );
    this.moduleIgnoreMatchers =
      ignorePatterns("modules").map(createNameMatcher);
    this.providerIgnoreMatchers =
      ignorePatterns("providers").map(createNameMatcher);
    this.controllerIgnoreMatchers =
      ignorePatterns("controllers").map(createNameMatcher);
    this.pathIgnoreMatchers = ignorePatterns("paths").map(createPathMatcher);
    this.nestCoreModuleName =
      this.options.nestCoreModuleName ??
      defaultOptions.nestCoreModuleName ??
      "NestJSCoreModule";
    this.nestCoreProviders = [
      ...(this.options.nestCoreProviders ??
        defaultOptions.nestCoreProviders ??
        []),
    ];
  }

  scan(): ModuleTree {
    if (!this.cachedTree) {
      this.cachedTree = this.getModuleTree(this.getRootModule());
    }

    return this.cachedTree;
  }

  get tree(): ModuleTree {
    if (!this.cachedTree) {
      throw new Error("Discovery tree is unavailable before scan() is called.");
    }

    return this.cachedTree;
  }

  private getRootModule(): Module {
    const rootModuleClass = this.options.rootModule;

    return rootModuleClass
      ? this.getRootModuleFromClass(rootModuleClass)
      : this.findRootModule();
  }

  private getRootModuleFromClass(rootModuleClass: Type<unknown>): Module {
    const root = [...this.modulesContainer.values()].find(
      (m) => m.metatype === rootModuleClass,
    );

    if (!root) {
      throw new Error(`Root module not found: ${rootModuleClass.name}`);
    }

    return root;
  }

  private getModuleTree(rootModule: Module): ModuleTree {
    const moduleTree = this.resolveModuleTree(rootModule);
    this.resolveModuleMembers(moduleTree);
    this.instrumentRuntimeTrace(moduleTree);
    this.appendNestCoreModule(moduleTree);

    return moduleTree;
  }

  /**
   * Auto-detect the root module by finding which module imports NestGraphInspectorModule.
   */
  private findRootModule(): Module {
    for (const moduleRef of this.modulesContainer.values()) {
      const moduleName = this.moduleName(moduleRef);

      if (
        moduleName === "InternalCoreModule" ||
        this.shouldIgnoreModule(moduleRef)
      ) {
        continue;
      }

      for (const importedModule of moduleRef.imports.values()) {
        if (importedModule.metatype === NestGraphInspectorModule) {
          return moduleRef;
        }
      }
    }

    throw new Error(
      "Could not auto-detect root module. No module imports NestGraphInspectorModule.",
    );
  }

  private resolveModuleTree(
    moduleRef: Module,
    visited = new Set<Module>(),
  ): ModuleTree {
    if (visited.has(moduleRef)) {
      return this.createModuleTreeReference(moduleRef);
    }

    visited.add(moduleRef);

    return {
      name: this.moduleName(moduleRef),
      jsdoc: this.extractModuleJsDoc(moduleRef),
      moduleRef,
      imports: [],
      exports: [],
      providers: [],
      providerInstances: new Map(),
      controllers: [],
      controllerInstances: new Map(),
      children: [...moduleRef.imports.values()]
        .filter((childModule) => !this.shouldIgnoreModule(childModule))
        .map((childModule) => this.resolveModuleTree(childModule, visited)),
    };
  }

  private createModuleTreeReference(moduleRef: Module): ModuleTree {
    return {
      name: this.moduleName(moduleRef),
      jsdoc: this.extractModuleJsDoc(moduleRef),
      moduleRef,
      imports: [],
      exports: [],
      providers: [],
      providerInstances: new Map(),
      controllers: [],
      controllerInstances: new Map(),
      children: [],
    };
  }

  private resolveModuleMembers(moduleTree: ModuleTree): void {
    this.walkModuleTree(moduleTree, (node) => {
      if (!node.moduleRef) {
        return;
      }

      node.imports = node.children.map((child) => child.name);
      node.exports = this.extractExports(node.moduleRef);
      node.providers = this.extractProviders(node.moduleRef, node.name);
      node.providerInstances = this.extractProviderInstances(
        node.moduleRef,
        node.providers,
      );
      node.controllers = this.extractControllers(node.moduleRef);
      node.controllerInstances = this.extractControllerInstances(
        node.moduleRef,
        node.controllers,
      );
    });
  }

  private instrumentRuntimeTrace(moduleTree: ModuleTree): void {
    this.walkModuleTree(moduleTree, (node) => {
      if (!node.moduleRef) {
        return;
      }

      this.instrumentRuntimeTraceWrappers({
        moduleName: node.name,
        type: "provider",
        wrappers: node.moduleRef.providers.values(),
        shouldIgnore: (name, wrapper) =>
          name === node.name || this.shouldIgnoreProvider(name, wrapper),
      });
      const moduleRef = node.moduleRef;
      this.instrumentRuntimeTraceWrappers({
        moduleName: node.name,
        type: "controller",
        wrappers: moduleRef.controllers.values(),
        shouldIgnore: (name, wrapper) =>
          this.shouldIgnoreController(name, wrapper, moduleRef),
      });
    });
  }

  private instrumentRuntimeTraceWrappers(param: {
    moduleName: string;
    type: RuntimeTraceSpanType;
    wrappers: Iterable<InstanceWrapper<unknown>>;
    shouldIgnore?: (name: string, wrapper: InstanceWrapper<unknown>) => boolean;
  }): void {
    for (const wrapper of param.wrappers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") {
        continue;
      }

      const className = this.wrapperClassName(wrapper);
      if (!className || param.shouldIgnore?.(className, wrapper)) {
        continue;
      }

      this.instrumentRuntimeTraceInstance({
        instance,
        moduleName: param.moduleName,
        className,
        type: param.type,
      });
    }
  }

  private instrumentRuntimeTraceInstance(param: {
    instance: object;
    moduleName: string;
    className: string;
    type: RuntimeTraceSpanType;
  }): void {
    const instrumentation = {
      moduleName: param.moduleName,
      className: param.className,
      type: param.type,
      recorder: this.runtimeTraceRecorder,
    };
    runtimeTraceInstrumentationByInstance.set(param.instance, instrumentation);

    const prototype = Object.getPrototypeOf(param.instance) as object | null;
    if (
      !prototype ||
      BUILTIN_PROTOTYPES.has(prototype) ||
      runtimeTraceInstrumentedPrototypes.has(prototype)
    ) {
      return;
    }

    runtimeTraceInstrumentedPrototypes.add(prototype);

    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      if (methodName === "constructor") {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
      const method = descriptor?.value;
      if (typeof method !== "function") {
        continue;
      }

      const tracedMethod = function (this: object, ...args: unknown[]) {
        const currentInstrumentation =
          runtimeTraceInstrumentationByInstance.get(this) ?? instrumentation;
        const { recorder, ...metadata } = currentInstrumentation;

        return recorder.recordSpan(
          {
            name: `${metadata.className}.${methodName}`,
            type: metadata.type,
            moduleName: metadata.moduleName,
            className: metadata.className,
            methodName,
            args: recorder.previewValue(args),
          },
          () => method.apply(this, args),
        );
      };
      Object.defineProperty(tracedMethod, "length", { value: method.length });
      originalTracedMethods.set(tracedMethod, method);

      Object.defineProperty(prototype, methodName, {
        configurable: true,
        writable: true,
        value: tracedMethod,
      });
    }
  }

  private appendNestCoreModule(moduleTree: ModuleTree): void {
    const usedProviders = this.findUsedNestCoreProvidersFromTree(moduleTree);

    if (!usedProviders.length) {
      return;
    }

    moduleTree.children.push({
      name: this.nestCoreModuleName,
      moduleRef: null,
      imports: [],
      exports: [...usedProviders],
      providers: usedProviders.map((name) => ({
        name,
        dependencies: [],
      })),
      providerInstances: new Map(),
      controllers: [],
      controllerInstances: new Map(),
      children: [],
    });
  }

  private findUsedNestCoreProvidersFromTree(moduleTree: ModuleTree): string[] {
    const usedProviders = new Set<string>();

    this.walkModuleTree(moduleTree, (node) => {
      for (const provider of node.providers) {
        for (const dependencyName of provider.dependencies) {
          const nestCoreProviderName =
            this.extractNestCoreProviderName(dependencyName);

          if (nestCoreProviderName) {
            usedProviders.add(nestCoreProviderName);
          }
        }
      }

      for (const controller of node.controllers) {
        for (const dependencyName of controller.dependencies) {
          const nestCoreProviderName =
            this.extractNestCoreProviderName(dependencyName);

          if (nestCoreProviderName) {
            usedProviders.add(nestCoreProviderName);
          }
        }
      }
    });

    return this.nestCoreProviders.filter((providerName) =>
      usedProviders.has(providerName),
    );
  }

  private walkModuleTree(
    moduleTree: ModuleTree,
    visit: (node: ModuleTree) => void,
  ): void {
    visit(moduleTree);

    for (const child of moduleTree.children) {
      this.walkModuleTree(child, visit);
    }
  }

  private shouldIgnoreModule(moduleRef: Module): boolean {
    // Never the inspector itself, whatever `ignore` says: instrumenting its
    // own RuntimeTraceRecorder makes every traced call recurse into itself,
    // and its adapters would become Direct Run targets.
    if (moduleRef.metatype === NestGraphInspectorModule) {
      return true;
    }

    if (matchesAny(this.moduleIgnoreMatchers, [this.moduleName(moduleRef)])) {
      return true;
    }

    if (!this.pathIgnoreMatchers.length) {
      return false;
    }

    return (
      matchesAny(this.pathIgnoreMatchers, this.moduleRoutePaths(moduleRef)) ||
      matchesAny(this.pathIgnoreMatchers, [
        this.classFilePath(moduleRef.metatype?.name),
      ])
    );
  }

  private shouldIgnoreProvider(
    name: string,
    wrapper?: InstanceWrapper<unknown>,
  ): boolean {
    if (
      matchesAny(this.providerIgnoreMatchers, [
        name,
        ...this.tokenNames(wrapper?.token),
      ])
    ) {
      return true;
    }

    if (!wrapper || !this.pathIgnoreMatchers.length) {
      return false;
    }

    return matchesAny(this.pathIgnoreMatchers, [
      this.classFilePath(this.wrapperClassName(wrapper)),
    ]);
  }

  private shouldIgnoreController(
    name: string,
    wrapper?: InstanceWrapper<unknown>,
    moduleRef?: Module,
  ): boolean {
    if (matchesAny(this.controllerIgnoreMatchers, [name])) {
      return true;
    }

    if (!wrapper || !this.pathIgnoreMatchers.length) {
      return false;
    }

    return (
      matchesAny(
        this.pathIgnoreMatchers,
        this.controllerRoutePaths(wrapper, moduleRef),
      ) ||
      matchesAny(this.pathIgnoreMatchers, [
        this.classFilePath(this.wrapperClassName(wrapper)),
      ])
    );
  }

  /**
   * Where `RouterModule` mounted a module. Nest stores it under
   * `MODULE_PATH` suffixed with the application id, so every key with that
   * prefix counts.
   */
  private moduleRoutePaths(moduleRef: Module | undefined): string[] {
    const metatype: unknown = moduleRef?.metatype;
    if (typeof metatype !== "function") {
      return [];
    }

    return Reflect.getMetadataKeys(metatype)
      .filter(
        (key): key is string =>
          typeof key === "string" && key.startsWith(MODULE_PATH),
      )
      .flatMap((key) => stringMetadata(Reflect.getMetadata(key, metatype)))
      .map(normalizePath);
  }

  /**
   * A controller's `@Controller()` paths, both alone and joined with each
   * path its module is mounted at.
   */
  private controllerRoutePaths(
    wrapper: InstanceWrapper<unknown>,
    moduleRef: Module | undefined,
  ): string[] {
    const metatype: unknown = wrapper.metatype;
    if (typeof metatype !== "function") {
      return [];
    }

    const controllerPaths = stringMetadata(
      Reflect.getMetadata(PATH_METADATA, metatype),
    ).map(normalizePath);
    const modulePaths = this.moduleRoutePaths(moduleRef);

    return [
      ...controllerPaths,
      ...modulePaths.flatMap((modulePath) =>
        controllerPaths.map((controllerPath) =>
          normalizePath(`${modulePath}/${controllerPath}`),
        ),
      ),
    ];
  }

  private classFilePath(
    className: string | null | undefined,
  ): string | undefined {
    const filePath = className
      ? this.sourceMetadata.getClassFilePath(className)
      : undefined;

    return filePath ? normalizePath(filePath) : undefined;
  }

  /** A symbol token answers to both `Symbol(NAME)` and `NAME`. */
  private tokenNames(token: InjectionToken | null | undefined): string[] {
    const name = this.tokenName(token);
    if (!name) {
      return [];
    }

    return typeof token === "symbol" && token.description
      ? [name, token.description]
      : [name];
  }

  private extractNestCoreProviderName(dependencyName: string): string | null {
    const prefix = `${this.nestCoreModuleName}:`;

    if (!dependencyName.startsWith(prefix)) {
      return null;
    }

    const providerName = dependencyName.slice(prefix.length);
    if (!providerName) {
      return null;
    }

    if (!this.nestCoreProviders.includes(providerName)) {
      return null;
    }

    return providerName;
  }

  private extractImports(moduleRef: Module): string[] {
    return [...moduleRef.imports.values()]
      .filter((importedModuleRef) => !this.shouldIgnoreModule(importedModuleRef))
      .map((importedModuleRef) => this.moduleName(importedModuleRef));
  }

  private extractExports(moduleRef: Module): string[] {
    return [...moduleRef.exports.values()].flatMap((exportedItem) => {
      const exportName = this.exportName(exportedItem);
      if (!exportName) {
        return [];
      }

      // Judged by the same name the provider list uses, so a `useClass`
      // provider ignored by its class name is not still exported by token.
      const wrapper = moduleRef.providers.get(exportedItem);
      if (wrapper) {
        const providerName = this.wrapperClassName(wrapper) || exportName;
        return this.shouldIgnoreProvider(providerName, wrapper)
          ? []
          : [exportName];
      }

      // Not one of this module's providers: a re-exported module, or a
      // token provided elsewhere.
      return exportedItem === NestGraphInspectorModule ||
        matchesAny(this.moduleIgnoreMatchers, [exportName]) ||
        matchesAny(this.providerIgnoreMatchers, this.tokenNames(exportedItem))
        ? []
        : [exportName];
    });
  }

  private extractProviders(
    moduleRef: Module,
    moduleName: string,
  ): ModuleProvider[] {
    return this.extractModuleMembers<ModuleProvider>({
      wrappers: moduleRef.providers.values(),
      moduleRef,
      extract: (wrapper) =>
        this.extractModuleMember({
          wrapper,
          moduleRef,
          shouldIgnore: (name, providerWrapper) =>
            this.shouldIgnoreProvider(name, providerWrapper),
        }),
      shouldSkip: (provider) => provider.name === moduleName,
    });
  }

  private extractProviderInstances(
    moduleRef: Module,
    providers: ModuleProvider[],
  ): Map<string, unknown> {
    const providerNames = new Set(providers.map((provider) => provider.name));
    const providerInstances = new Map<string, unknown>();

    for (const wrapper of moduleRef.providers.values()) {
      const name =
        this.wrapperClassName(wrapper) || this.tokenName(wrapper.token);
      if (name && providerNames.has(name)) {
        providerInstances.set(name, wrapper.instance);
      }
    }

    return providerInstances;
  }

  private extractControllers(moduleRef: Module): ModuleController[] {
    return this.extractModuleMembers<ModuleController>({
      wrappers: moduleRef.controllers.values(),
      moduleRef,
      extract: (wrapper) =>
        this.extractModuleMember({
          wrapper,
          moduleRef,
          shouldIgnore: (name, controllerWrapper) =>
            this.shouldIgnoreController(name, controllerWrapper, moduleRef),
        }),
    });
  }

  private extractControllerInstances(
    moduleRef: Module,
    controllers: ModuleController[],
  ): Map<string, unknown> {
    const controllerNames = new Set(
      controllers.map((controller) => controller.name),
    );
    const controllerInstances = new Map<string, unknown>();

    for (const wrapper of moduleRef.controllers.values()) {
      const name =
        this.wrapperClassName(wrapper) || this.tokenName(wrapper.token);
      if (name && controllerNames.has(name)) {
        controllerInstances.set(name, wrapper.instance);
      }
    }

    return controllerInstances;
  }

  private extractModuleMembers<T extends { name: string }>(param: {
    wrappers: Iterable<InstanceWrapper<unknown>>;
    moduleRef: Module;
    extract: (wrapper: InstanceWrapper<object>, moduleRef: Module) => T | null;
    shouldSkip?: (item: T) => boolean;
  }): T[] {
    return [...param.wrappers].reduce<T[]>((items, wrapper) => {
      const executableWrapper = wrapper as InstanceWrapper<object>;
      const item = param.extract(executableWrapper, param.moduleRef);
      if (item) {
        if (param.shouldSkip?.(item)) {
          return items;
        }

        items.push(item);
      }

      return items;
    }, []);
  }

  private extractModuleMember(param: {
    wrapper: InstanceWrapper<object>;
    moduleRef: Module;
    shouldIgnore?: (name: string, wrapper: InstanceWrapper<object>) => boolean;
  }): ModuleProvider | null {
    const { wrapper, moduleRef, shouldIgnore = () => false } = param;
    const name =
      this.wrapperClassName(wrapper) || this.tokenName(wrapper.token);

    if (!name || shouldIgnore(name, wrapper)) {
      return null;
    }

    const jsdoc = this.extractClassJsDoc(wrapper);

    return {
      name,
      ...(jsdoc ? { jsdoc } : {}),
      dependencies: this.extractDependencies(wrapper, moduleRef),
    };
  }

  private extractModuleJsDoc(moduleRef: Module): string | undefined {
    return moduleRef.metatype
      ? this.extractClassJsDocByName(moduleRef.metatype.name)
      : undefined;
  }

  private extractClassJsDoc(
    wrapper: InstanceWrapper<unknown>,
  ): string | undefined {
    const className = this.wrapperClassName(wrapper);

    return className ? this.extractClassJsDocByName(className) : undefined;
  }

  private extractClassJsDocByName(className: string): string | undefined {
    return this.sourceMetadata.getClassJsDoc(className);
  }

  private wrapperClassName(wrapper: InstanceWrapper<unknown>): string | null {
    if (wrapper.metatype?.name) {
      return wrapper.metatype.name;
    }

    const instance = wrapper.instance;
    if (
      instance &&
      (typeof instance === "object" || typeof instance === "function")
    ) {
      return instance.constructor?.name ?? null;
    }

    return null;
  }

  private extractDependencies(
    wrapper: InstanceWrapper<unknown>,
    moduleRef: Module,
  ): string[] {
    const dependencies = new Set<string>();

    // Factory providers (useFactory with inject array)
    if (Array.isArray(wrapper?.inject)) {
      for (const token of wrapper.inject) {
        const dependencyName = this.resolveDependencyName(
          this.resolveInjectionToken(token),
          moduleRef,
        );
        if (dependencyName) {
          dependencies.add(dependencyName);
        }
      }
    }

    // Constructor-injected dependencies (resolved by NestJS with @Inject() overrides)
    const ctorDeps = wrapper.getCtorMetadata?.() ?? [];
    for (const depWrapper of ctorDeps) {
      if (depWrapper) {
        const dependencyName = this.resolveDependencyName(
          depWrapper.token,
          moduleRef,
        );
        if (dependencyName && dependencyName !== "Object") {
          dependencies.add(dependencyName);
        }
      }
    }

    // Property-injected dependencies (@Inject() on class properties)
    const propertyDeps = wrapper.getPropertiesMetadata?.() ?? [];
    for (const propertyDep of propertyDeps) {
      const depWrapper = propertyDep?.wrapper;
      if (depWrapper) {
        const dependencyName = this.resolveDependencyName(
          depWrapper.token,
          moduleRef,
        );
        if (dependencyName && dependencyName !== "Object") {
          dependencies.add(dependencyName);
        }
      }
    }

    return [...dependencies];
  }

  private resolveInjectionToken(
    token: InjectionToken | OptionalFactoryDependency,
  ): InjectionToken {
    if (typeof token === "object" && token !== null && "token" in token) {
      return token.token;
    }

    return token;
  }

  private resolveDependencyName(
    token: InjectionToken,
    moduleRef: Module,
  ): string | null {
    const tokenName = this.tokenName(token);
    if (!tokenName) {
      return null;
    }

    if (this.nestCoreProviders.includes(tokenName)) {
      return `${this.nestCoreModuleName}:${tokenName}`;
    }

    const ownProviderDependencyName = this.findProviderDependencyNameByToken(
      moduleRef,
      token,
      false,
    );

    if (ownProviderDependencyName) {
      return ownProviderDependencyName;
    }

    for (const importedModuleRef of moduleRef.imports.values()) {
      if (!this.isExportedProviderToken(importedModuleRef, token)) {
        continue;
      }

      const importedProviderDependencyName =
        this.findProviderDependencyNameByToken(importedModuleRef, token, true);

      if (importedProviderDependencyName) {
        return importedProviderDependencyName;
      }
    }

    return this.formatDependencyName(tokenName, moduleRef);
  }

  private findProviderDependencyNameByToken(
    moduleRef: Module,
    token: InjectionToken,
    includeModulePrefix: boolean,
  ): string | null {
    const moduleName = this.moduleName(moduleRef);

    for (const wrapper of moduleRef.providers.values()) {
      if (!this.isSameProviderToken(wrapper, token)) {
        continue;
      }

      const providerInstance =
        wrapper.instance &&
        (typeof wrapper.instance === "object" ||
          typeof wrapper.instance === "function")
          ? (wrapper.instance as { constructor?: { name?: string } })
          : null;
      const providerName =
        wrapper.metatype?.name ||
        providerInstance?.constructor?.name ||
        this.tokenName(wrapper.token);

      if (!providerName) {
        return null;
      }

      if (includeModulePrefix) {
        return `${moduleName}:${providerName}`;
      }

      return providerName;
    }

    return null;
  }

  private isSameProviderToken(
    wrapper: InstanceWrapper<unknown>,
    token: InjectionToken,
  ): boolean {
    if (wrapper?.token === token) {
      return true;
    }

    if (wrapper?.metatype === token) {
      return true;
    }

    if (
      wrapper.instance &&
      typeof wrapper.instance === "object" &&
      wrapper.instance.constructor === token
    ) {
      return true;
    }

    return false;
  }

  private exportedNames(moduleRef: Module): Set<string> {
    return new Set(
      [...moduleRef.exports.values()]
        .map((exportedItem) => this.exportName(exportedItem))
        .filter((exportName): exportName is string => !!exportName),
    );
  }

  private exportName(exportedItem: InjectionToken): string | null {
    return this.tokenName(exportedItem);
  }

  private isExportedProviderToken(
    moduleRef: Module,
    token: InjectionToken,
  ): boolean {
    const tokenName = this.tokenName(token);

    for (const exportedItem of moduleRef.exports.values()) {
      if (exportedItem === token) {
        return true;
      }

      if (tokenName && this.exportName(exportedItem) === tokenName) {
        return true;
      }
    }

    return false;
  }

  private formatDependencyName(
    dependencyName: string,
    moduleRef: Module,
  ): string {
    if (this.nestCoreProviders.includes(dependencyName)) {
      return `${this.nestCoreModuleName}:${dependencyName}`;
    }

    for (const importedModuleRef of moduleRef.imports.values()) {
      const importedModuleName = this.moduleName(importedModuleRef);
      const exportedNames = this.exportedNames(importedModuleRef);

      if (exportedNames.has(dependencyName)) {
        return `${importedModuleName}:${dependencyName}`;
      }
    }

    return dependencyName;
  }

  private moduleName(moduleRef: Module): string {
    return (
      moduleRef.metatype?.name ||
      this.tokenName(moduleRef.token) ||
      "AnonymousModule"
    );
  }

  private tokenName(token: InjectionToken | null | undefined): string | null {
    if (!token) return null;
    if (typeof token === "string") return token;
    if (typeof token === "symbol") return token.toString();
    if (typeof token === "function") return token.name;
    return null;
  }
}
