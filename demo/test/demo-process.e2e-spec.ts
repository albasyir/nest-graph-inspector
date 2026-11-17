import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ACCESS_TOKEN_HEADER,
  ACCESS_TOKEN_QUERY_PARAM,
  GRAPH_LAYOUT_SCHEMA_VERSION,
  GRAPH_OUTPUT_SCHEMA_VERSION,
  type GraphLayout,
  type GraphOutput,
  validateGraphLayout,
} from 'nest-graph-inspector';
import { z } from 'zod';
import { DEMO } from './support/demo.fixture';
import {
  BUILD_AND_START_TIMEOUT_MS,
  buildDemo,
  DEMO_DIR,
  exportGraph,
  installedInspector,
  type RunningDemo,
  startDemo,
} from './support/demo-process';
import {
  listEndpointOf,
  listEndpointsOf,
  providerMethodIn,
} from './support/graph-facts';
import { redactCredentials } from './support/startup-log';
import {
  directRunSuccessSchema,
  directRunUrl,
  endpointFile,
  inspectorInformationSchema,
  inspectorRequest,
  layoutSavedSchema,
  parseGraphOutput,
  parseJson,
  runtimeTraceSchema,
  traceHistorySchema,
  traceIndexSchema,
  VIEWER_MINIMUM_GRAPH_VERSION,
} from './support/inspector-api';

/**
 * The demo as a user runs it: compiled by `nest build`, started with `node`
 * as a process of its own, and reached only through the viewer link it prints
 * — never through its dependency-injection container. Nothing here names a
 * module, a route or a provider of the demo: every expectation is read from
 * the graph the process serves, and `support/demo.fixture.ts` holds the few
 * facts no running demo can tell.
 *
 * The demo binds fixed ports, so this suite runs in band with the others,
 * checks the ports are free before it starts the demo, and waits for them to
 * be released after it stops it.
 */

/** Where the printed viewer link points by default: the hosted viewer. */
const HOSTED_VIEWER = 'https://albasyir.github.io/nest-graph-inspector';

/**
 * Longer than building and starting the demo can take, so `beforeAll` never
 * gives up on a demo still starting — which would leave it running.
 */
const START_TIMEOUT_MS = BUILD_AND_START_TIMEOUT_MS + 60_000;
const STOP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 60_000;

const schemaIdSchema = z.object({ $id: z.string() });

function json(text: string): unknown {
  return JSON.parse(text);
}

/** The file's content, or `null` when there is no such file. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }

    throw error;
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('the demo, running as a process of its own (e2e)', () => {
  let demo: RunningDemo | undefined;
  let graphText = '';
  let schemaText = '';
  let graph: GraphOutput | undefined;

  /** The running demo; fails the test, with its output, if it has stopped. */
  function running(): RunningDemo {
    if (!demo) {
      throw new Error('The demo did not start: see the beforeAll failure.');
    }

    demo.assertRunning();

    return demo;
  }

  /** The graph the demo serves, once it has passed the schema it serves. */
  function servedGraph(): GraphOutput {
    return (graph ??= parseGraphOutput({ graphText, schemaText }));
  }

  /** A file under the graph endpoint, fetched the way the viewer fetches it. */
  async function getFromEndpoint(name: string) {
    const { link } = running();

    return inspectorRequest({
      url: endpointFile(link.endpoint, name),
      token: link.token,
    });
  }

  async function traceHistory() {
    const { link } = running();
    const response = await inspectorRequest({
      url: directRunUrl(link.endpoint, '/histories'),
      token: link.token,
    });

    expect(response.status).toBe(200);

    return parseJson(response.text, traceHistorySchema);
  }

  async function directRun(body: Record<string, string>) {
    const { link } = running();
    const response = await inspectorRequest({
      url: directRunUrl(link.endpoint),
      method: 'POST',
      token: link.token,
      json: body,
    });

    expect({ body, status: response.status }).toEqual({ body, status: 200 });

    return parseJson(response.text, directRunSuccessSchema);
  }

  /**
   * The list endpoints, in their order, run through Direct Run until one
   * calls a provider method Direct Run can call again with no arguments:
   * that run, and that method. Each of them must run cleanly on the way.
   */
  async function firstListRunReachingAProvider(graph: GraphOutput) {
    const reachedNone: string[] = [];

    for (const handler of listEndpointsOf(graph)) {
      const run = await directRun({
        module: handler.moduleName,
        target: 'controller',
        controller: handler.controllerName,
        method: handler.methodName,
      });

      expect(run.runtimeTrace.status).toBe('success');
      expect(run.runtimeTrace.entrypoint).toEqual({
        module: handler.moduleName,
        className: handler.controllerName,
        methodName: handler.methodName,
      });

      const providerMethod = providerMethodIn({
        graph,
        trace: run.runtimeTrace,
      });

      if (providerMethod) {
        return { run, providerMethod };
      }

      reachedNone.push(
        `${handler.controllerName}.${handler.methodName}() recorded ${run.runtimeTrace.spans
          .map((span) => span.name)
          .join(', ')}`,
      );
    }

    throw new Error(
      `No list endpoint called a provider method that takes no arguments:\n${reachedNone.join('\n')}`,
    );
  }

  /** The `json` output's files: those under the working directory holding the served graph. */
  async function jsonOutputFiles(): Promise<string[]> {
    const { workingDir } = running();
    const served = json(graphText);
    const candidates = (await filesUnder(workingDir)).filter((path) =>
      path.endsWith('.json'),
    );
    const matches = await Promise.all(
      candidates.map(async (path) =>
        isDeepStrictEqual(json(await readFile(path, 'utf8')), served),
      ),
    );

    return candidates.filter((_, index) => matches[index]);
  }

  beforeAll(async () => {
    buildDemo();
    demo = await startDemo();

    const [graphResponse, schemaResponse] = await Promise.all([
      getFromEndpoint('output.json'),
      getFromEndpoint('output.schema.json'),
    ]);

    expect(graphResponse.status).toBe(200);
    expect(schemaResponse.status).toBe(200);
    graphText = graphResponse.text;
    schemaText = schemaResponse.text;
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await demo?.stop();
  }, STOP_TIMEOUT_MS);

  it(
    'prints a viewer link that carries its graph endpoint and an access token',
    () => {
      const { link } = running();

      // Compared with the credential taken out, so that a failure prints none.
      expect(redactCredentials(link.href)).toBe(
        `${HOSTED_VIEWER}/view/<redacted>`,
      );
      expect(link.endpoint.protocol).toBe('http:');
      expect(DEMO.inspectorPorts).toContain(Number(link.endpoint.port));
      expect(link.endpoint.search).toBe('');
      expect(/^ngi1\.[\w-]+\.[\w-]+$/.test(link.token)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the viewer's handshake as a live inspector of the installed version",
    async () => {
      const response = await getFromEndpoint('information.json');

      expect(response.status).toBe(200);
      expect(response.contentType).toMatch(/^application\/json/);

      const information = parseJson(response.text, inspectorInformationSchema);

      expect(information['is-static']).toBe(false);
      expect(information.version).toBe((await installedInspector()).version);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serves a GraphOutput the viewer opens, valid against the schema it serves beside it',
    () => {
      const served = servedGraph();
      const schema = parseJson(schemaText, schemaIdSchema);

      expect(served.version).toBe(GRAPH_OUTPUT_SCHEMA_VERSION);
      expect(Number(served.version)).toBeGreaterThanOrEqual(
        VIEWER_MINIMUM_GRAPH_VERSION,
      );
      expect(schema.$id).toContain(`graph-output-v${served.version}`);
      expect(Object.keys(served.modules)).toContain(served.root);
      expect(Object.keys(served.modules).length).toBeGreaterThan(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serves its markdown report, naming every module of the graph',
    async () => {
      const response = await getFromEndpoint('output.md');

      expect(response.status).toBe(200);
      expect(response.contentType).toMatch(/^text\/markdown/);

      for (const moduleName of Object.keys(servedGraph().modules)) {
        expect(response.text).toContain(moduleName);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'takes its access token as the printed link carries it, as the viewer sends it, and as a bearer token',
    async () => {
      const { link } = running();
      const graphUrl = endpointFile(link.endpoint, 'output.json');
      const asPrinted = new URL(graphUrl);

      asPrinted.searchParams.set(ACCESS_TOKEN_QUERY_PARAM, link.token);

      const responses = await Promise.all([
        inspectorRequest({ url: asPrinted }),
        inspectorRequest({
          url: graphUrl,
          headers: { [ACCESS_TOKEN_HEADER]: link.token },
        }),
        inspectorRequest({
          url: graphUrl,
          headers: { authorization: `Bearer ${link.token}` },
        }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.text).toBe(graphText);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses its routes without the token, yet answers a CORS preflight',
    async () => {
      const { link } = running();
      const handler = listEndpointOf(servedGraph());

      for (const name of [
        'information.json',
        'output.json',
        'output.schema.json',
        'output.md',
        'layout.json',
      ]) {
        const response = await inspectorRequest({
          url: endpointFile(link.endpoint, name),
        });

        expect({ name, status: response.status }).toEqual({
          name,
          status: 401,
        });
      }

      const tracesBefore = (await traceHistory()).length;
      const refusedRun = await inspectorRequest({
        url: directRunUrl(link.endpoint),
        method: 'POST',
        json: {
          module: handler.moduleName,
          target: 'controller',
          controller: handler.controllerName,
          method: handler.methodName,
        },
      });

      expect(refusedRun.status).toBe(401);
      expect((await traceHistory()).length).toBe(tracesBefore);

      // A preflight carries no credential, so the viewer's cross-origin
      // requests depend on it being answered without one.
      const preflight = await inspectorRequest({
        url: directRunUrl(link.endpoint),
        method: 'OPTIONS',
        headers: {
          origin: new URL(HOSTED_VIEWER).origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': ACCESS_TOKEN_HEADER,
        },
      });

      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'saves a layout to .muse in its own working directory and serves it back',
    async () => {
      const { link, workingDir } = running();
      const repositoryLayout = join(DEMO_DIR, '.muse');
      const repositoryLayoutBefore = await readIfPresent(repositoryLayout);

      const before = await getFromEndpoint('layout.json');

      expect(before.status).toBe(200);
      expect(json(before.text)).toEqual({
        version: GRAPH_LAYOUT_SCHEMA_VERSION,
        modules: {},
      });

      const layout: GraphLayout = {
        version: GRAPH_LAYOUT_SCHEMA_VERSION,
        modules: Object.fromEntries(
          Object.keys(servedGraph().modules).map((moduleName, index) => [
            moduleName,
            {
              position: { x: index * 480, y: 120 },
              isCollapsed: index % 2 === 0,
            },
          ]),
        ),
      };

      expect(validateGraphLayout(layout).ok).toBe(true);

      const saved = await inspectorRequest({
        url: endpointFile(link.endpoint, 'layout'),
        method: 'POST',
        token: link.token,
        json: layout,
      });

      expect(saved.status).toBe(200);
      parseJson(saved.text, layoutSavedSchema);

      const after = await getFromEndpoint('layout.json');

      expect(after.status).toBe(200);
      expect(json(after.text)).toEqual(layout);
      await expect(readFile(join(workingDir, '.muse'), 'utf8')).resolves.toBe(
        `${JSON.stringify(layout, null, 2)}\n`,
      );
      await expect(readIfPresent(repositoryLayout)).resolves.toBe(
        repositoryLayoutBefore,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a list endpoint through Direct Run, then a provider method it called, and keeps both traces',
    async () => {
      const { link } = running();
      const { run: handlerRun, providerMethod } =
        await firstListRunReachingAProvider(servedGraph());
      const providerRun = await directRun({
        module: providerMethod.moduleName,
        target: 'provider',
        provider: providerMethod.providerName,
        method: providerMethod.methodName,
      });

      expect(providerRun.runtimeTrace.status).toBe('success');
      expect(providerRun.runtimeTrace.entrypoint).toEqual({
        module: providerMethod.moduleName,
        className: providerMethod.providerName,
        methodName: providerMethod.methodName,
      });

      const runs = [handlerRun, providerRun];
      const history = await traceHistory();

      for (const run of runs) {
        expect(history.find((trace) => trace.traceId === run.traceId)).toEqual(
          run.runtimeTrace,
        );

        const one = await inspectorRequest({
          url: directRunUrl(link.endpoint, `/history/${run.traceId}`),
          token: link.token,
        });

        expect(one.status).toBe(200);
        expect(parseJson(one.text, runtimeTraceSchema)).toEqual(
          run.runtimeTrace,
        );
      }

      const index = await inspectorRequest({
        url: directRunUrl(link.endpoint, '/history/index.json'),
        token: link.token,
      });

      expect(index.status).toBe(200);
      expect(
        parseJson(index.text, traceIndexSchema).map((item) => item.traceId),
      ).toEqual(expect.arrayContaining(runs.map((run) => run.traceId)));

      // With a `json` output, the history is written beside it as well.
      for (const jsonOutput of await jsonOutputFiles()) {
        const historyDir = join(dirname(jsonOutput), 'direct-run', 'history');

        for (const run of runs) {
          expect(
            parseJson(
              await readFile(join(historyDir, `${run.traceId}.json`), 'utf8'),
              runtimeTraceSchema,
            ),
          ).toEqual(run.runtimeTrace);
        }

        expect(
          parseJson(
            await readFile(join(historyDir, 'index.json'), 'utf8'),
            traceIndexSchema,
          ).map((item) => item.traceId),
        ).toEqual(expect.arrayContaining(runs.map((run) => run.traceId)));
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serves the same graph from its plain http output',
    async () => {
      const { httpOutputEndpoints, link } = running();

      expect(httpOutputEndpoints.length > 0).toBe(DEMO.outputs.http);

      for (const endpoint of httpOutputEndpoints) {
        const [information, served] = await Promise.all([
          inspectorRequest({
            url: endpointFile(endpoint, 'information.json'),
            token: link.token,
          }),
          inspectorRequest({
            url: endpointFile(endpoint, 'output.json'),
            token: link.token,
          }),
        ]);

        expect(information.status).toBe(200);
        expect(
          parseJson(information.text, inspectorInformationSchema)['is-static'],
        ).toBe(false);
        expect(served.status).toBe(200);
        expect(served.text).toBe(graphText);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes its json and markdown outputs into its own working directory',
    async () => {
      const { workingDir } = running();
      const markdown = (await getFromEndpoint('output.md')).text;
      const markdownCandidates = (await filesUnder(workingDir)).filter((path) =>
        path.endsWith('.md'),
      );
      const markdownMatches = await Promise.all(
        markdownCandidates.map(
          async (path) => (await readFile(path, 'utf8')) === markdown,
        ),
      );
      const markdownOutputs = markdownCandidates.filter(
        (_, index) => markdownMatches[index],
      );

      expect((await jsonOutputFiles()).length > 0).toBe(DEMO.outputs.json);
      expect(markdownOutputs.length > 0).toBe(DEMO.outputs.markdown);

      // The markdown output writes the handshake beside its file, marked as
      // static, so a graph read from disk is told apart from a live one.
      for (const markdownOutput of markdownOutputs) {
        const information = parseJson(
          await readFile(
            join(dirname(markdownOutput), 'information.json'),
            'utf8',
          ),
          inspectorInformationSchema,
        );

        expect(information['is-static']).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serves its own routes on its own port',
    async () => {
      const { appOrigin } = running();
      const answers: { url: string; status: number }[] = [];

      // Every list endpoint, one at a time and always in the same order —
      // nothing about any of them is known here but that it takes no input.
      for (const handler of listEndpointsOf(servedGraph())) {
        const url = new URL(
          `${DEMO.routePrefix}${handler.http.path}`,
          appOrigin,
        );
        const { status } = await inspectorRequest({ url });

        answers.push({ url: url.href, status });
      }

      // A guard may turn an anonymous caller away from a route (a 4xx), but
      // no route may fail (a 5xx), and at least one must answer. Compared
      // whole, so a failure prints every route's answer.
      expect({
        answers,
        failed: answers.filter(({ status }) => status >= 500),
        answered: answers.some(({ status }) => status >= 200 && status < 300),
      }).toEqual({ answers, failed: [], answered: true });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exports, without being run, exactly the graph it serves',
    async () => {
      running();

      const result = await exportGraph(['--compact', '--out', '-']);

      expect(result.stderr).toContain('nest-graph-inspector: exported');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(graphText);
    },
    TEST_TIMEOUT_MS,
  );
});
