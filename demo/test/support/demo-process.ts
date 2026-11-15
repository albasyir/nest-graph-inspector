import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as ts from 'typescript';
import { z } from 'zod';
import { DEMO, DEMO_PORTS } from './demo.fixture';
import {
  endpointFile,
  inspectorInformationSchema,
  inspectorRequest,
  parseJson,
} from './inspector-api';
import {
  acceptsConnection,
  busyPorts,
  listeningPortsOf,
  waitForPortsFree,
} from './ports';
import {
  type PrintedViewerLink,
  readHttpOutputEndpoints,
  readPrintedViewerLink,
  redactCredentials,
  stripAnsi,
} from './startup-log';

/**
 * The demo package: the project `nest build` compiles and the export reads.
 *
 * These helpers declare no class, and should not: the demo's own TypeScript
 * project, which the inspector reads for JSDoc and Direct Run methods, spans
 * `test/` too, and a class whose name is declared in two of its files loses
 * its Direct Run methods.
 */
export const DEMO_DIR = resolve(__dirname, '../..');

/**
 * The demo is up in a couple of seconds. The bound is for a slow CI runner
 * on a bad day, and expiring it is a failure, never a reason to carry on.
 */
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;
/** One readiness probe of an inspector endpoint. */
const PROBE_TIMEOUT_MS = 5_000;
/** One readiness probe of a port: a connection attempt. */
const CONNECT_PROBE_TIMEOUT_MS = 1_000;
const PORT_RELEASE_TIMEOUT_MS = 10_000;
const TERMINATE_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;
/** `nest build`, and an export of the built demo. */
const COMMAND_TIMEOUT_MS = 120_000;
/** Room for an export of a large graph on standard output. */
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURED_CHARACTERS = 1_000_000;

/**
 * The longest `buildDemo()` and then `startDemo()` can take before either has
 * settled — and, on a failure, stopped what it started. Every readiness probe
 * is cut to the time left before the readiness deadline, so the pass under
 * way when it passes ends within moments of it; one probe's worth is allowed
 * for that. A test framework's hook timeout around them has to be longer, or
 * the hook gives up while the demo is still running.
 */
export const BUILD_AND_START_TIMEOUT_MS =
  COMMAND_TIMEOUT_MS +
  READY_TIMEOUT_MS +
  PROBE_TIMEOUT_MS +
  TERMINATE_TIMEOUT_MS +
  KILL_TIMEOUT_MS +
  PORT_RELEASE_TIMEOUT_MS;

/** The demo, running as a process of its own. */
export type RunningDemo = {
  /**
   * The scratch directory the demo runs in, and writes its outputs, its
   * Direct Run history and its saved layout to.
   */
  readonly workingDir: string;
  /** The viewer link the demo printed as it started. */
  readonly link: PrintedViewerLink;
  /** The graph endpoints its plain `http` outputs announced. */
  readonly httpOutputEndpoints: readonly URL[];
  /** Where the application's own routes are served. */
  readonly appOrigin: URL;
  /** Throws, with everything the demo printed, if it is no longer running. */
  assertRunning(): void;
  /**
   * Stops the demo, waits until it has exited and its ports are free, and
   * removes its working directory. Safe to call more than once.
   */
  stop(): Promise<void>;
};

type ExitStatus = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: Error;
};

type Readiness =
  | {
      readonly kind: 'ready';
      readonly link: PrintedViewerLink;
      readonly httpOutputEndpoints: URL[];
    }
  | { readonly kind: 'waiting'; readonly waitingFor: string };

const nestCliSchema = z.object({
  sourceRoot: z.string().default('src'),
  entryFile: z.string().default('main'),
  compilerOptions: z.object({ tsConfigPath: z.string().optional() }).optional(),
});

const inspectorPackageSchema = z.object({
  version: z.string(),
  bin: z.record(z.string(), z.string()),
});

/** Compiles the demo the way its own `build` script does. */
export function buildDemo(): void {
  const nest = require.resolve('@nestjs/cli/bin/nest.js', {
    paths: [DEMO_DIR],
  });
  const build = spawnSync(process.execPath, [nest, 'build'], {
    cwd: DEMO_DIR,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });

  if (build.error) {
    throw new Error(`nest build failed: ${build.error.message}`, {
      cause: build.error,
    });
  }

  if (build.status !== 0) {
    throw new Error(
      `nest build failed (${build.signal ?? `exit code ${String(build.status)}`}):\n${build.stdout}${build.stderr}`,
    );
  }
}

/** The copy of `nest-graph-inspector` the demo resolves, and its version. */
export async function installedInspector(): Promise<{
  readonly version: string;
  readonly cli: string;
}> {
  const packageDir = join(DEMO_DIR, 'node_modules/nest-graph-inspector');
  const manifest = parseJson(
    await readFile(join(packageDir, 'package.json'), 'utf8'),
    inspectorPackageSchema,
  );
  const cli = manifest.bin['nest-graph-inspector'];

  if (!cli) {
    throw new Error(
      'nest-graph-inspector declares no nest-graph-inspector bin',
    );
  }

  return { version: manifest.version, cli: join(packageDir, cli) };
}

/**
 * `nest-graph-inspector export` over the built demo, run from the demo's own
 * directory as its `export:graph` script runs it.
 */
export async function exportGraph(args: readonly string[]): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const { cli } = await installedInspector();
  const result = spawnSync(process.execPath, [cli, 'export', ...args], {
    cwd: DEMO_DIR,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });

  if (result.error) {
    throw new Error(
      `nest-graph-inspector export failed: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseTsConfig(configPath: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));

  if (read.error) {
    throw new Error(
      `Cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );

  if (parsed.errors.length > 0) {
    throw new Error(
      `Cannot parse ${configPath}: ${parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, '\n'),
        )
        .join('; ')}`,
    );
  }

  return parsed;
}

/**
 * The compiled `main.js`, found the way `nest-graph-inspector export` finds a
 * compiled `app.module.js` (`lib/src/cli/project.ts`): under the `outDir` of
 * the tsconfig `nest build` compiles with, directly or below the source root.
 */
async function findBuiltEntry(): Promise<string> {
  const nestCli = parseJson(
    await readFile(join(DEMO_DIR, 'nest-cli.json'), 'utf8'),
    nestCliSchema,
  );
  const buildConfig = [
    nestCli.compilerOptions?.tsConfigPath,
    'tsconfig.build.json',
    'tsconfig.json',
  ]
    .filter((path): path is string => path !== undefined)
    .map((path) => resolve(DEMO_DIR, path))
    .find((path) => existsSync(path));
  const outDir =
    (buildConfig && parseTsConfig(buildConfig).options.outDir) ??
    join(DEMO_DIR, 'dist');
  const entryFile = `${nestCli.entryFile}.js`;
  const candidates = [
    ...new Set([
      join(outDir, entryFile),
      join(outDir, nestCli.sourceRoot, entryFile),
    ]),
  ];
  const entry = candidates.find((path) => existsSync(path));

  if (!entry) {
    throw new Error(
      `No compiled demo to run: looked for ${candidates
        .map((path) => relative(DEMO_DIR, path))
        .join(' and ')}. Run nest build first.`,
    );
  }

  return entry;
}

/**
 * The inspector reads JSDoc and Direct Run parameter types from the sources
 * of the project whose `tsconfig.json` is in its working directory. The demo
 * runs from a scratch directory here, so that its outputs and its saved
 * layout never land in the repository, and this writes the tsconfig.json it
 * finds there: the demo's own project — its compiler options through
 * `extends`, its exact file list, and the type roots the demo's own directory
 * resolves — so the graph is the one the demo serves from its own folder.
 * The suite holds it to that: `nest-graph-inspector export`, run from the
 * demo's folder, must produce the same document byte for byte.
 */
function sourceProjectConfig(): string {
  const configPath = join(DEMO_DIR, 'tsconfig.json');
  const project = parseTsConfig(configPath);
  const typeRoots =
    project.options.typeRoots ??
    ts.getEffectiveTypeRoots(project.options, {
      getCurrentDirectory: () => DEMO_DIR,
    }) ??
    [];

  return `${JSON.stringify(
    {
      extends: configPath,
      compilerOptions: { typeRoots },
      files: project.fileNames,
    },
    null,
    2,
  )}\n`;
}

/** A fresh scratch directory for the demo to run in. */
async function createWorkingDir(): Promise<string> {
  const tsconfig = sourceProjectConfig();
  const workingDir = await mkdtemp(join(os.tmpdir(), 'ngi-demo-e2e-'));

  try {
    await writeFile(join(workingDir, 'tsconfig.json'), tsconfig);
  } catch (error) {
    await rm(workingDir, { recursive: true, force: true });
    throw error;
  }

  return workingDir;
}

/**
 * Fails when another process already listens on a port the demo binds. Its
 * ports are fixed, so a second demo — another checkout's, say — would
 * otherwise leave this one half started, or leave a suite talking to the
 * wrong one. `startDemo` checks before it spawns the demo, and `test:e2e`
 * once before any of its suites boots it (`test/e2e-global-setup.ts`).
 */
export async function assertDemoPortsFree(): Promise<void> {
  const busy = await busyPorts(DEMO_PORTS);

  if (busy.length > 0) {
    throw new Error(
      `${busy
        .map((port) => `Cannot start the demo: port ${port} already in use.`)
        .join(
          '\n',
        )}\nSomething else is listening on it — another copy of the demo, perhaps. Stop it, or wait for it to finish, and run the suite again. The demo's ports are listed in test/support/demo.fixture.ts.`,
    );
  }
}

/**
 * The environment the demo is started with: this process's own, less what
 * would make the demo's credential or link something other than what a user
 * of a freshly installed inspector gets.
 */
function demoEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  // With a configured secret, another inspector sharing it would accept this
  // demo's token — and the token is what tells this demo's ports apart.
  delete env.NEST_GRAPH_INSPECTOR_TOKEN_SECRET;
  // The printed link has to point at the hosted viewer, as a user's does.
  delete env.____DEV_VIEWER_BASE_URL;
  // Jest sets it and Playwright does not; the demo starts the same either way.
  delete env.NODE_ENV;

  return env;
}

function describeExit(status: ExitStatus): string {
  if (status.spawnError) {
    return `could not be spawned: ${status.spawnError.message}`;
  }

  return status.signal
    ? `killed by ${status.signal}`
    : `exit code ${String(status.code)}`;
}

function keepTail(text: string): string {
  return text.length > MAX_CAPTURED_CHARACTERS
    ? text.slice(-MAX_CAPTURED_CHARACTERS)
    : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `promise` settles within `timeoutMs`. */
async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const timer = new AbortController();

  try {
    return await Promise.race([
      promise.then(() => true),
      delay(timeoutMs, false, { signal: timer.signal }),
    ]);
  } finally {
    timer.abort();
  }
}

/**
 * Starts the built demo the way a user starts it — `node` on the compiled
 * `main.js`, as a process of its own — in a fresh scratch directory, and
 * resolves once it is ready to serve.
 *
 * Ready means: this process printed its viewer link, its own sockets listen
 * on every port the demo binds (read from procfs where there is one), each of
 * those ports accepts connections, and every inspector endpoint it announced
 * accepts the access token its link carries — which only an inspector holding
 * this process's own secret does. Nothing else is taken for readiness, so a
 * server some other process runs on the same port is never mistaken for it.
 *
 * Fails, with everything the demo printed, when a port is taken before it
 * starts, when it exits first, or when it is not ready within
 * `READY_TIMEOUT_MS`; the demo is stopped before the error is thrown.
 */
export async function startDemo(): Promise<RunningDemo> {
  await assertDemoPortsFree();

  const entry = await findBuiltEntry();
  const workingDir = await createWorkingDir();

  const child = spawn(process.execPath, [entry], {
    cwd: workingDir,
    env: demoEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  let exitStatus: ExitStatus | undefined;

  const exited = new Promise<void>((resolveExit) => {
    // `close` rather than `exit`: it comes once the output pipes are drained
    // too, so a demo that crashes is reported with its last words.
    child.once('close', (code, signal) => {
      exitStatus = { code, signal };
      resolveExit();
    });
    // Kept for every error, not only the first: a child process emits one
    // when it cannot be spawned, and again whenever a signal cannot reach it,
    // and an error nothing listens for would take this whole process down.
    child.on('error', (error) => {
      // Only a process that never started fails to report its exit.
      if (child.pid === undefined) {
        exitStatus = { code: null, signal: null, spawnError: error };
        resolveExit();
      }
    });
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output.stdout = keepTail(output.stdout + chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    output.stderr = keepTail(output.stderr + chunk);
  });

  // Should this process end without stopping the demo, the demo goes too,
  // and its scratch directory with it — where `process` is the real one, as
  // in Playwright's runner. Jest hands a test file a `process` of its own
  // whose `exit` never fires; there, the suite's own teardown stops the demo,
  // and `startDemo` stops it on any failure within
  // `BUILD_AND_START_TIMEOUT_MS`.
  const killOrphan = () => {
    if (!exitStatus) {
      child.kill('SIGKILL');
    }

    // Best effort: an exit handler can only run synchronous code, and has
    // nowhere to report a directory it could not remove.
    rmSync(workingDir, { recursive: true, force: true, maxRetries: 3 });
  };
  process.once('exit', killOrphan);

  const describeOutput = (): string =>
    [
      '--- demo standard output (credentials redacted) ---',
      redactCredentials(stripAnsi(output.stdout)).trimEnd() || '(nothing)',
      '--- demo standard error (credentials redacted) ---',
      redactCredentials(stripAnsi(output.stderr)).trimEnd() || '(nothing)',
      '--- end of demo output ---',
    ].join('\n');

  const failure = (reason: string): Error =>
    new Error(
      [
        `The demo ${reason}.`,
        `  entry: ${relative(DEMO_DIR, entry)}`,
        `  working directory: ${workingDir}`,
        '',
        describeOutput(),
      ].join('\n'),
    );

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      process.removeListener('exit', killOrphan);

      try {
        if (!exitStatus) {
          child.kill('SIGTERM');

          if (!(await settlesWithin(exited, TERMINATE_TIMEOUT_MS))) {
            child.kill('SIGKILL');

            if (!(await settlesWithin(exited, KILL_TIMEOUT_MS))) {
              throw failure(
                `did not exit within ${TERMINATE_TIMEOUT_MS + KILL_TIMEOUT_MS} ms of SIGTERM and SIGKILL`,
              );
            }
          }
        }

        await waitForPortsFree({
          ports: DEMO_PORTS,
          timeoutMs: PORT_RELEASE_TIMEOUT_MS,
        });
      } finally {
        await rm(workingDir, { recursive: true, force: true });
      }
    })());

  const assertInspectorPort = (endpoint: URL, origin: string): void => {
    if (!DEMO.inspectorPorts.includes(Number(endpoint.port))) {
      throw failure(
        `printed ${origin} on port ${endpoint.port || '(none)'}, which test/support/demo.fixture.ts does not list among the demo's inspector ports (${DEMO.inspectorPorts.join(', ')})`,
      );
    }
  };

  const checkReadiness = async (deadline: number): Promise<Readiness> => {
    // Every probe is cut to the time left, so a pass begun just before the
    // deadline ends with it, not a probe timeout or two after it.
    const timeLeft = (atMostMs: number): number =>
      Math.max(1, Math.min(atMostMs, deadline - Date.now()));

    // Nothing listened on its ports when it was spawned; a port it still
    // cannot bind leaves an inspector output that logs the failure and stays
    // down, which no amount of waiting will change.
    if (/\bEADDRINUSE\b/.test(`${output.stdout}\n${output.stderr}`)) {
      throw failure(
        'could not bind one of its ports (EADDRINUSE below): something started listening on it after the ports were checked, or a connection on the same address holds it as its local port',
      );
    }

    let link: PrintedViewerLink | undefined;

    try {
      link = readPrintedViewerLink(output.stdout);
    } catch (error) {
      throw failure(
        `printed a viewer link these suites cannot use: ${messageOf(error)}`,
      );
    }

    if (!link) {
      return {
        kind: 'waiting',
        waitingFor: 'the viewer link on its standard output',
      };
    }

    const httpOutputEndpoints = readHttpOutputEndpoints(output.stdout);

    assertInspectorPort(link.endpoint, 'its viewer link');
    httpOutputEndpoints.forEach((endpoint) =>
      assertInspectorPort(endpoint, 'a plain http output'),
    );

    if (DEMO.outputs.http && httpOutputEndpoints.length === 0) {
      return {
        kind: 'waiting',
        waitingFor: 'its plain http output to announce its endpoints',
      };
    }

    const ownPorts =
      child.pid === undefined ? undefined : await listeningPortsOf(child.pid);

    for (const port of DEMO_PORTS) {
      if (ownPorts && !ownPorts.has(port)) {
        return {
          kind: 'waiting',
          waitingFor: `port ${port} to be bound by the demo itself`,
        };
      }

      if (
        !(await acceptsConnection({
          host: 'localhost',
          port,
          timeoutMs: timeLeft(CONNECT_PROBE_TIMEOUT_MS),
        }))
      ) {
        return {
          kind: 'waiting',
          waitingFor: `port ${port} to accept connections`,
        };
      }
    }

    for (const endpoint of [link.endpoint, ...httpOutputEndpoints]) {
      let handshake: Awaited<ReturnType<typeof inspectorRequest>>;

      try {
        handshake = await inspectorRequest({
          url: endpointFile(endpoint, 'information.json'),
          token: link.token,
          timeoutMs: timeLeft(PROBE_TIMEOUT_MS),
        });
      } catch (error) {
        return {
          kind: 'waiting',
          waitingFor: `${endpoint.href} to answer (${messageOf(error)})`,
        };
      }

      if (handshake.status !== 200) {
        throw failure(
          `announced ${endpoint.href}, but the inspector there answered ${handshake.status} to the token the demo printed: another process is serving that port`,
        );
      }

      parseJson(handshake.text, inspectorInformationSchema);
    }

    return { kind: 'ready', link, httpOutputEndpoints };
  };

  const waitUntilReady = async (): Promise<
    Extract<Readiness, { kind: 'ready' }>
  > => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let waitingFor = 'it to start';

    while (Date.now() < deadline) {
      if (exitStatus) {
        throw failure(
          `exited (${describeExit(exitStatus)}) before it was ready to serve`,
        );
      }

      const readiness = await checkReadiness(deadline);

      if (readiness.kind === 'ready' && !exitStatus) {
        return readiness;
      }

      if (readiness.kind === 'waiting') {
        waitingFor = readiness.waitingFor;
      }

      await delay(POLL_INTERVAL_MS);
    }

    throw failure(
      `was not ready to serve within ${READY_TIMEOUT_MS} ms; it was still waiting for ${waitingFor}`,
    );
  };

  let ready: Extract<Readiness, { kind: 'ready' }>;

  try {
    ready = await waitUntilReady();
  } catch (error) {
    const stopError = await stop().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    if (stopError !== undefined) {
      throw new Error(
        `${messageOf(error)}\n\nStopping it afterwards failed as well: ${messageOf(stopError)}`,
        { cause: error },
      );
    }

    throw error;
  }

  return {
    workingDir,
    link: ready.link,
    httpOutputEndpoints: ready.httpOutputEndpoints,
    appOrigin: new URL(`http://localhost:${DEMO.appPort}`),
    assertRunning: () => {
      if (exitStatus) {
        throw failure(
          `exited (${describeExit(exitStatus)}) while the suite was still using it`,
        );
      }
    },
    stop,
  };
}
