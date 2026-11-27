import { readFile } from 'node:fs/promises';
import type { GraphOutput } from 'nest-graph-inspector';
import { z } from 'zod';
import { cycleCount, listEndpointOf } from '../support/graph-facts';
import {
  directRunUrl,
  endpointFile,
  inspectorRequest,
  parseGraphOutput,
  parseJson,
  type RecordedTrace,
  traceHistorySchema,
} from '../support/inspector-api';
import {
  expect,
  expectGraphLayoutsReady,
  graphNode,
  openPrintedLink,
  test,
} from './viewer.fixtures';

/**
 * The viewer in Chromium, against the demo running as a process of its own:
 * reached through the link the demo printed, as a developer reaches it. Like
 * the process suite, nothing here names a module, a route or a provider of
 * the demo — every expectation is read from the graph it serves.
 */

/**
 * Where the site's `/view` landing card looks for an inspector on its own: a
 * fact of the site (`DEFAULT_ORIGIN` in `site/app/pages/view/index.vue`, with
 * the library's default viewer port and path), not of the demo. Whether the
 * demo happens to serve its graph there is read from the link it printed.
 */
const SITE_DEFAULT_INSPECTOR_ENDPOINT =
  'http://localhost:53371/__graph-inspector';

/** Whether two graph endpoints are one address, a trailing slash aside. */
function sameEndpoint(left: URL, right: URL): boolean {
  const path = (url: URL): string => url.pathname.replace(/\/+$/, '');

  return left.origin === right.origin && path(left) === path(right);
}

/** The in-browser demo boots in seconds; a CI runner can take far longer. */
const IN_BROWSER_DEMO_TIMEOUT_MS = 150_000;

const exampleGraphSchema = z.object({
  root: z.string(),
  modules: z.record(z.string(), z.unknown()),
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** How many times each value occurs in `values`. */
function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return counts;
}

/**
 * The title the issues page gives each cycle of the graph: its kind, and the
 * first two steps of its path as the page writes them — a module by name, a
 * provider or a controller as `<name> from <module>`.
 */
function cycleTitles(graph: GraphOutput): string[] {
  const titled = (kind: string, steps: readonly string[]) =>
    `${kind} cycle: ${steps[0] ?? 'Unknown'} → ${steps[1] ?? steps[0] ?? 'Unknown'}`;
  const fromModule = (key: string) => {
    const separator = key.indexOf(':');

    return separator === -1
      ? key
      : `${key.slice(separator + 1)} from ${key.slice(0, separator)}`;
  };

  return [
    ...graph.cycles.modules.map((cycle) => titled('Module', cycle.path)),
    ...graph.cycles.providers.map((cycle) =>
      titled(
        'Provider',
        cycle.path.map(
          (step) => `${step.provider.name} from ${step.module.name}`,
        ),
      ),
    ),
    ...graph.cycles.controllers.map((cycle) =>
      titled('Controller', cycle.path.map(fromModule)),
    ),
  ];
}

/** How the trace page labels a span (`spanLabel` in `site/app/utils/trace-waterfall.ts`). */
function spanLabel(span: RecordedTrace['spans'][number]): string {
  return span.methodName
    ? `${span.className ?? span.name}.${span.methodName}()`
    : span.name;
}

test('opening the printed link draws every module of the graph on the navigator', async ({
  page,
  state,
  graph,
  information,
}) => {
  await openPrintedLink({ page, state, information });
  await expectGraphLayoutsReady(page);

  for (const moduleName of Object.keys(graph.modules)) {
    await expect(graphNode(page, `module-${moduleName}`)).toBeVisible();
  }
});

test('the issues page lists every cycle of the graph', async ({
  page,
  state,
  graph,
  information,
}) => {
  await openPrintedLink({ page, state, information });
  await page
    .getByRole('navigation', { name: 'Viewer pages' })
    .getByRole('link', { name: 'Issues' })
    .click();
  await expect(page).toHaveURL(new URL('view/issues', state.siteBaseUrl).href);
  await expect(
    page.getByRole('heading', { name: 'Architecture Health & Diagnostics' }),
  ).toBeVisible();

  const cycles = cycleCount(graph);
  const circularTab = page.getByRole('tab', {
    name: new RegExp(`^Circular Cycles\\s*${cycles}$`),
  });

  await circularTab.click();
  await expect(circularTab).toHaveAttribute('aria-selected', 'true');
  // One card per cycle, each with its way back to the graph.
  await expect(page.getByRole('link', { name: 'Focus in Graph' })).toHaveCount(
    cycles,
  );

  for (const [title, count] of tally(cycleTitles(graph))) {
    await expect(page.getByText(title, { exact: true })).toHaveCount(count);
  }
});

test('running a list endpoint from its node in the navigator, on its module page, shows the trace it recorded', async ({
  page,
  state,
  graph,
  information,
}) => {
  const handler = listEndpointOf(graph);

  const controllerNodeId = `controller-${handler.moduleName}-${handler.controllerName}`;

  await openPrintedLink({ page, state, information });
  // The navigator draws modules closed; a module's items are drawn once it
  // is opened.
  await page
    .getByRole('button', { name: `Open ${handler.moduleName}`, exact: true })
    .click();
  await graphNode(page, controllerNodeId).click();

  // The click opens the controller's module's page, Direct Run docked beside
  // the module's own graph: a region of the page, not a dialog over it.
  await expect(page).toHaveURL(
    new URL(
      `view/navigator/modules/${encodeURIComponent(handler.moduleName)}?view=inside&direct-run-on=${controllerNodeId}`,
      state.siteBaseUrl,
    ).href,
  );

  const panel = page
    .getByRole('region', { name: 'Direct Run' })
    .filter({ hasText: handler.controllerName });

  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await panel
    .getByRole('tab', { name: handler.methodName, exact: true })
    .click();
  await panel.getByRole('button', { name: 'Inspect' }).click();

  await expect(page).toHaveURL(new URL('view/trace', state.siteBaseUrl).href);
  await expect(
    page.getByRole('heading', {
      level: 2,
      name: `${handler.controllerName}.${handler.methodName}()`,
      exact: true,
    }),
  ).toBeVisible();

  // The trace on screen is the one the demo recorded: every span it holds
  // has its row in the waterfall.
  const history = await inspectorRequest({
    url: directRunUrl(new URL(state.endpoint), '/histories'),
    token: state.token,
  });

  expect(history.status).toBe(200);

  const trace = parseJson(history.text, traceHistorySchema).findLast(
    (candidate) =>
      candidate.entrypoint.module === handler.moduleName &&
      candidate.entrypoint.className === handler.controllerName &&
      candidate.entrypoint.methodName === handler.methodName,
  );

  if (!trace) {
    throw new Error('The demo recorded no trace of the run');
  }

  expect(trace.status).toBe('success');

  for (const [label, count] of tally(trace.spans.map(spanLabel))) {
    await expect(
      page.getByRole('button', {
        name: new RegExp(`^${escapeRegExp(label)}, `),
      }),
    ).toHaveCount(count);
  }
});

test('/view opens an exported graph file and draws every module in it', async ({
  page,
  state,
}) => {
  const schema = await inspectorRequest({
    url: endpointFile(new URL(state.endpoint), 'output.schema.json'),
    token: state.token,
  });

  expect(schema.status).toBe(200);

  const fileGraph = parseGraphOutput({
    graphText: await readFile(state.graphFile, 'utf8'),
    schemaText: schema.text,
  });

  await page.goto(new URL('view', state.siteBaseUrl).href);
  await expect(page.getByTestId('graph-file-drop-zone')).toBeVisible();

  // The landing card looks for an inspector at the default address; when the
  // demo serves its graph there, it finds it, and asks for the printed link.
  // When it does not, the report says this went unchecked.
  const servedAtSiteDefault = sameEndpoint(
    new URL(state.endpoint),
    new URL(SITE_DEFAULT_INSPECTOR_ENDPOINT),
  );

  if (servedAtSiteDefault) {
    await expect(page.getByText('Nest Graph Inspector detected')).toBeVisible();
  } else {
    test.info().annotations.push({
      type: 'unchecked',
      description: `the landing card's inspector detection: the demo serves its graph at ${state.endpoint}, not at the site's default ${SITE_DEFAULT_INSPECTOR_ENDPOINT}`,
    });
  }

  await page.getByTestId('graph-file-input').setInputFiles(state.graphFile);
  await expect(page).toHaveURL(
    new URL('view/navigator', state.siteBaseUrl).href,
  );
  await expectGraphLayoutsReady(page);

  for (const moduleName of Object.keys(fileGraph.modules)) {
    await expect(graphNode(page, `module-${moduleName}`)).toBeVisible();
  }

  // A file has no application behind it, so there is no trace to show.
  await page
    .getByRole('navigation', { name: 'Viewer pages' })
    .getByRole('link', { name: 'Trace' })
    .click();
  await expect(page.getByText('No trace for a graph file')).toBeVisible();
});

test('the landing page draws the static demo graph, and Load Example runs the demo in the browser', async ({
  page,
  state,
}) => {
  test.setTimeout(IN_BROWSER_DEMO_TIMEOUT_MS + 60_000);

  const example = await inspectorRequest({
    url: new URL('nodepod-demo/graph.json', state.siteBaseUrl),
  });

  expect(example.status).toBe(200);

  const { root } = parseJson(example.text, exampleGraphSchema);

  await page.goto(state.siteBaseUrl);
  await expect(
    page.getByText('Static graph of the demo project').first(),
  ).toBeVisible();
  // Every preview draws the same static graph, so every one of them is on
  // the page by now, and each is waited for.
  await expectGraphLayoutsReady(page);
  await expect(graphNode(page, `module-${root}`).first()).toBeVisible();

  await page.getByRole('button', { name: 'Load Example' }).first().click();
  await expect(
    page
      .getByText('Live graph of the demo application running in your browser.')
      .first(),
  ).toBeVisible({ timeout: IN_BROWSER_DEMO_TIMEOUT_MS });
  // Each preview draws the live graph in a viewer of its own, mounted in
  // place of the static one, so these are new layouts to wait for.
  await expectGraphLayoutsReady(page);
  await expect(graphNode(page, `module-${root}`).first()).toBeVisible();
});
