import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { isFile, pathInside, samePath } from "./files";
import {
  DEFAULT_OUT_DIR,
  type ApplicationBuild,
  type ApplicationLayout,
  type NestApplication,
  type SwcOptions,
} from "./nest-cli-config";

/**
 * Where `nest build` writes an application's files. A compiled build writes
 * one file per source; where the export cannot be sure which root directory
 * the build laid it out from, it probes candidates rather than assume one. A
 * webpack or rspack build writes one bundle, which starts the application.
 */

const ENTRY_FILE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];

const COMPILED_EXTENSIONS = new Map([
  [".ts", ".js"],
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".js", ".js"],
  [".jsx", ".js"],
  [".mjs", ".mjs"],
  [".cjs", ".cjs"],
]);

const SOURCE_EXTENSIONS = [...COMPILED_EXTENSIONS.keys()];

const CONVENTIONAL_ROOT_MODULE = "app.module.ts";

export type CompiledFile =
  | { kind: "found"; path: string }
  /** All but one are left from older builds, and which is current cannot be told. */
  | { kind: "several"; paths: readonly string[] }
  | { kind: "missing" };

export function outDirOf(projectDir: string, tsconfig: ApplicationLayout["tsconfig"]): string {
  return tsconfig?.options.outDir ?? join(projectDir, DEFAULT_OUT_DIR);
}

function swcOutDir({ projectDir, tsconfig }: ApplicationLayout, options: SwcOptions | undefined): string {
  return options?.outDir === undefined ? outDirOf(projectDir, tsconfig) : resolve(projectDir, options.outDir);
}

/**
 * tsc writes where its tsconfig says, and only there is looked: beside the
 * source without an `outDir`, under an explicit `rootDir` alone — anywhere
 * else could only hold a stale file. Otherwise — tsc inferring its root
 * directory, a builder the export does not know — the root directories
 * `compilerRoots` lists are probed.
 */
export function compiledCandidates(source: string, layout: ApplicationLayout): string[] {
  const extension = COMPILED_EXTENSIONS.get(extname(source));
  if (extension === undefined) {
    return [];
  }

  const { projectDir, tsconfig } = layout;
  const { build } = layout.application;
  const withExtension = (path: string, newExtension: string) =>
    path.slice(0, path.length - extname(path).length) + newExtension;
  if (build.kind === "swc") {
    // @swc/cli names its output `.${outFileExtension}` when that is set.
    const swcPaths = build.options.flatMap((options) =>
      swcCandidates(source, layout, options).map((path) =>
        withExtension(path, options?.outFileExtension === undefined ? extension : `.${options.outFileExtension}`),
      ),
    );
    return [...new Set(swcPaths)];
  }

  if (build.kind === "tsc" && tsconfig !== undefined && tsconfig.options.outDir === undefined) {
    return [withExtension(source, extension)];
  }

  const outDir = outDirOf(projectDir, tsconfig);
  const candidates = compilerRoots(layout).flatMap((root) => {
    const path = pathInside(root, source);
    return path === undefined ? [] : [join(outDir, withExtension(path, extension))];
  });

  return [...new Set(candidates)];
}

/**
 * An explicit `rootDir` alone, for tsc. Otherwise, probed in this order: an
 * explicit `rootDir`, the tsconfig's directory (TypeScript 6's default), the
 * project, the application's `root`, then its `sourceRoot` (where TypeScript
 * 5's default, the sources' common directory, usually is).
 */
function compilerRoots(layout: ApplicationLayout): string[] {
  const { application, projectDir, tsconfig } = layout;
  const rootDir = tsconfig?.options.rootDir;
  if (application.build.kind === "tsc" && rootDir !== undefined) {
    return [rootDir];
  }

  return [
    rootDir,
    tsconfig ? dirname(tsconfig.path) : undefined,
    projectDir,
    resolve(projectDir, application.root),
    resolve(projectDir, application.sourceRoot),
  ].filter((root): root is string => root !== undefined);
}

/**
 * Where `@swc/cli` writes `source` when the Nest CLI runs it, before the
 * extension changes. Its `getDest` takes the source's path from the project,
 * strips its first directory under `stripLeadingPaths`, and joins it to the
 * outDir — the builder's `options.outDir`, else the tsconfig's, else `dist`
 * (`swc-defaults.ts`). The builder's own `stripLeadingPaths` decides when it
 * sets one. Otherwise Nest CLI 12 strips only a source root of one directory,
 * and only when the tsconfig's `rootDir` is unset or is that source root,
 * while Nest CLI 11 always strips: both layouts are candidates, 12's first.
 */
function swcCandidates(
  source: string,
  layout: ApplicationLayout,
  options: SwcOptions | undefined,
): string[] {
  const { application, projectDir, tsconfig } = layout;
  const fromProject = pathInside(projectDir, source);
  if (fromProject === undefined) {
    return [];
  }

  const outDir = swcOutDir(layout, options);
  const whole = join(outDir, fromProject);
  // @swc/cli's stripComponents: every directory but the first, or the path
  // itself when it has no directory.
  const [, ...rest] = fromProject.split(sep);
  const stripped = rest.length ? join(outDir, ...rest) : whole;

  if (options?.stripLeadingPaths !== undefined) {
    return [options.stripLeadingPaths ? stripped : whole];
  }

  return nestCli12StripsLeadingPaths(tsconfig?.options.rootDir, application.sourceRoot)
    ? [stripped]
    : [...new Set([whole, stripped])];
}

/** Nest CLI 12's `shouldStripLeadingPaths`: a nested source root cannot be flattened by stripping. */
function nestCli12StripsLeadingPaths(rootDir: string | undefined, sourceRoot: string): boolean {
  const posix = (path: string) =>
    path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/\/+/g, "/");
  const root = posix(sourceRoot).replace(/^\.\//, "").replace(/\/+$/, "");
  if (root.includes("/")) {
    return false;
  }

  if (rootDir === undefined) {
    return true;
  }

  const directory = posix(rootDir).replace(/\/+$/, "");
  return directory === root || directory.endsWith(`/${root}`);
}

/** One existing candidate is the file; more than one cannot be told apart. */
export function pickCompiled(candidates: readonly string[]): CompiledFile {
  const existing = candidates
    .filter(isFile)
    .filter((path, index, files) => files.findIndex((other) => samePath(other, path)) === index);
  const [first, ...rest] = existing;
  if (first === undefined) {
    return { kind: "missing" };
  }

  return rest.length ? { kind: "several", paths: existing } : { kind: "found", path: first };
}

/** Why a file built to more than one of its candidates is loaded from none. */
export function staleBuildsReason(build: ApplicationBuild): string {
  return build.kind === "swc"
    ? "Nest CLI 12 and Nest CLI 11 lay out its output differently, so one of them is left from an older build"
    : "each is where a build from a different root directory writes it, so all but one of them are left from older builds";
}

/** Only `nest build <name>` builds an application other than the default project. */
export function buildAdvice(app: string | undefined): string {
  return app === undefined ? "Build your project first (nest build)" : `Build ${app} first (nest build ${app})`;
}

/**
 * A source of another application's that its build also writes to
 * `compiled`: then whose the file is cannot be told. Each other build is read
 * backwards, through its own outDir and root directories, so a source at
 * another path counts too; a bundle writes no such file, and a file both
 * applications reach — a library's — is no other's.
 */
export function sharedWith(
  compiled: string,
  source: string,
  others: readonly ApplicationLayout[],
): string | undefined {
  for (const other of others) {
    if (other.application.build.kind === "bundled") {
      continue;
    }

    const otherSource = sourcesBuiltTo(compiled, other).find(
      (candidate) =>
        !samePath(candidate, source) &&
        !samePath(candidate, compiled) &&
        isFile(candidate) &&
        compiledCandidates(candidate, other).some((path) => samePath(path, compiled)),
    );
    if (otherSource !== undefined) {
      return otherSource;
    }
  }

  return undefined;
}

/** `compiledCandidates` read backwards, as candidates `sharedWith` confirms forwards. */
function sourcesBuiltTo(compiled: string, layout: ApplicationLayout): string[] {
  const { application, projectDir, tsconfig } = layout;
  const { build } = application;
  const stem = compiled.slice(0, compiled.length - extname(compiled).length);
  const asSources = (base: string) => SOURCE_EXTENSIONS.map((extension) => base + extension);
  if (build.kind === "tsc" && tsconfig !== undefined && tsconfig.options.outDir === undefined) {
    return asSources(stem);
  }

  const outDirs =
    build.kind === "swc"
      ? build.options.map((options) => swcOutDir(layout, options))
      : [outDirOf(projectDir, tsconfig)];
  const fromOutDirs = outDirs.flatMap((outDir) => pathInside(outDir, stem) ?? []);

  // SWC writes from the project, whole or with its first directory stripped.
  const [firstDirectory] = application.sourceRoot
    .split(/[\\/]/)
    .filter((segment) => segment !== "" && segment !== ".");
  const roots =
    build.kind === "swc"
      ? [projectDir, ...(firstDirectory === undefined ? [] : [join(projectDir, firstDirectory)])]
      : compilerRoots(layout);
  return [...new Set(roots.flatMap((root) => fromOutDirs.flatMap((path) => asSources(join(root, path)))))];
}

export function conventionalEntrySource({ application, projectDir }: ApplicationLayout): string {
  return resolve(projectDir, application.sourceRoot, CONVENTIONAL_ROOT_MODULE);
}

/** Where an application's own build writes `<sourceRoot>/app.module.ts`; a bundle writes none. */
export function conventionalEntryCandidates(layout: ApplicationLayout): string[] {
  return layout.application.build.kind === "bundled"
    ? []
    : compiledCandidates(conventionalEntrySource(layout), layout);
}

export function entryFileSources({ application, projectDir }: ApplicationLayout): string[] {
  const stem = resolve(projectDir, application.sourceRoot, application.entryFile);
  return ENTRY_FILE_EXTENSIONS.map((extension) => stem + extension);
}

export function bundleFileName(application: NestApplication): string {
  return `${basename(application.entryFile)}.js`;
}

/** Every path an application's entry file has: its source, and what it compiles or bundles to. */
export function applicationEntryFiles(layout: ApplicationLayout): string[] {
  const { application, projectDir, tsconfig } = layout;
  const sources = entryFileSources(layout);
  // Where webpack and rspack write the bundle: dist/<root>/<entryFile>.js, as
  // Nest's webpack defaults name it, and flattened into the outDir. Only a
  // bundled build has one; in a compiled build those paths can be ordinary
  // module files.
  const bundles =
    application.build.kind === "bundled"
      ? [
          join(projectDir, DEFAULT_OUT_DIR, application.root, `${application.entryFile}.js`),
          join(outDirOf(projectDir, tsconfig), bundleFileName(application)),
        ]
      : [];

  return [...sources, ...sources.flatMap((source) => compiledCandidates(source, layout)), ...bundles];
}
