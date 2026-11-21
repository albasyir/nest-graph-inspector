import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  expect,
  type Locator,
  type Page,
  type Route,
  test as base,
} from '@playwright/test';
import type { GraphOutput } from 'nest-graph-inspector';
import { z } from 'zod';
import {
  endpointFile,
  type InspectorInformation,
  inspectorInformationSchema,
  inspectorRequest,
  parseGraphOutput,
  parseJson,
} from '../support/inspector-api';
import { redactCredentials } from '../support/startup-log';
import { type BrowserState, readBrowserState } from './browser-state';

/** Something the browser did during a test that fails it, unless expected. */
type BrowserProblem = {
  readonly kind:
    'console error' | 'uncaught exception' | 'request off the machine';
  readonly text: string;
  /** The resource the problem is about, when it is about one. */
  readonly url: string;
  /** Where the page was at the time. */
  readonly pageUrl: string;
};

type OffMachineAnswer = {
  readonly why: string;
  readonly matches: (url: URL) => boolean;
  readonly answer: (route: Route, url: URL) => Promise<void>;
};

/** The site package, whose build these tests run. */
const SITE_DIR = resolve(__dirname, '../../../site');

/** A file of a Monaco release on jsDelivr, as the site's JSON editor loads it. */
const MONACO_ON_JSDELIVR = /^\/npm\/monaco-editor@([^/]+)\/min\/(.+)$/;

const monacoPackageSchema = z.object({ version: z.string() });

/** The Monaco release the site depends on: its version and its `min/` build. */
function installedMonaco(): {
  readonly version: string;
  readonly minDir: string;
} {
  const manifest = require.resolve('monaco-editor/package.json', {
    paths: [SITE_DIR],
  });

  return {
    version: parseJson(readFileSync(manifest, 'utf8'), monacoPackageSchema)
      .version,
    minDir: join(dirname(manifest), 'min'),
  };
}

/**
 * Answers a request for a Monaco file from the release the site depends on,
 * which holds the same files as jsDelivr does for that version — or with a
 * 404 naming the mismatch, which the browser then logs as an error.
 */
async function answerFromInstalledMonaco(
  route: Route,
  url: URL,
): Promise<void> {
  const [, version = '', file = ''] =
    MONACO_ON_JSDELIVR.exec(url.pathname) ?? [];
  const monaco = installedMonaco();
  const path = resolve(monaco.minDir, file);

  if (
    version !== monaco.version ||
    !path.startsWith(`${monaco.minDir}${sep}`)
  ) {
    await route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: `The site asked jsDelivr for monaco-editor ${version}, and depends on ${monaco.version}.`,
    });
    return;
  }

  await route.fulfill({ path });
}

type ExpectedConsoleError = {
  readonly why: string;
  readonly matches: (problem: BrowserProblem, state: BrowserState) => boolean;
};

/**
 * Requests the site makes beyond this machine, answered here, so that a test
 * sends nothing out — no page view reaches the site's analytics — and
 * depends on nothing out there. Anything else off the machine is refused, and
 * fails the test that asked for it.
 */
const OFF_MACHINE_ANSWERS: readonly OffMachineAnswer[] = [
  {
    why: 'PostHog: the page views, exceptions and feature flags the site reports to its collection host. Answered empty, so a test run is never counted as a visit.',
    matches: (url) =>
      /^(integrity\.nest-graph-inspector\.albasyir\.net|([a-z0-9-]+\.)*posthog\.com)$/.test(
        url.hostname,
      ),
    answer: (route, url) =>
      route.fulfill(
        url.pathname.endsWith('.js')
          ? { status: 200, contentType: 'text/javascript', body: '' }
          : { status: 200, contentType: 'application/json', body: '{}' },
      ),
  },
  {
    why: 'Icons from the Iconify API, beyond those the site bundles. Answered with an empty set: each missing icon is a console warning, and no test finds anything by an icon.',
    matches: (url) =>
      /^api\.(iconify\.design|simplesvg\.com|unisvg\.com)$/.test(url.hostname),
    answer: (route, url) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prefix: basename(url.pathname, '.json'),
          icons: {},
        }),
      }),
  },
  {
    why: "The npm registry, which the in-browser demo's inspector asks for its latest version as it starts, as the library always does. Answered 404, which it reports as no version known.",
    matches: (url) => url.hostname === 'registry.npmjs.org',
    answer: (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{}',
      }),
  },
  {
    why: "Monaco, the editor of Direct Run's arguments, which the site loads from jsDelivr. Answered from the release the site depends on, which holds the same files.",
    matches: (url) =>
      url.hostname === 'cdn.jsdelivr.net' &&
      MONACO_ON_JSDELIVR.test(url.pathname),
    answer: answerFromInstalledMonaco,
  },
  {
    why: 'Optional WebAssembly modules the in-browser runtime loads from jsDelivr (SQLite, Brotli), which the demo never uses. Refused, as on a machine offline: the runtime warns and carries on.',
    matches: (url) =>
      url.hostname === 'cdn.jsdelivr.net' &&
      /^\/npm\/(wa-sqlite|brotli-wasm)@/.test(url.pathname),
    answer: (route) => route.abort('blockedbyclient'),
  },
];

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Console errors the site logs where nothing is wrong. Each one is matched
 * as narrowly as it can be; anything else the console says as an error
 * fails the test.
 */
const EXPECTED_CONSOLE_ERRORS: readonly ExpectedConsoleError[] = [
  {
    why: "The viewer's client-rendered routes — the printed link /view/<endpoint> among them — are files no static host has, so it serves them through its 404 page with status 404, as GitHub Pages does, and the browser logs the status of the page itself. The page is the site's own app shell, and renders the route.",
    matches: (problem, state) => {
      const path = pathOf(problem.url);

      return (
        problem.kind === 'console error' &&
        problem.text.includes('status of 404') &&
        path.startsWith(pathOf(new URL('view/', state.siteBaseUrl).href)) &&
        !/\.[a-z0-9]+$/i.test(path)
      );
    },
  },
  {
    why: "/view looks for an inspector at the default local address without a token — probeEndpoint never hands this tab's credential to a host it is only probing — and the demo these tests run there answers 401, which the browser logs. The landing card then says an inspector was found and asks for its printed link.",
    matches: (problem, state) =>
      problem.kind === 'console error' &&
      problem.text.includes('status of 401') &&
      problem.url ===
        endpointFile(new URL(state.endpoint), 'information.json').href &&
      pathOf(problem.pageUrl) ===
        pathOf(new URL('view', state.siteBaseUrl).href),
  },
  {
    why: '`nuxt generate` writes no payload for /view: the client-only route rule for /view/** takes /view/_payload.json as well, which comes out as a page (view/_payload.json.html). The site asks for that payload as /view loads, and when it prefetches a link to /view, and the static host answers 404 — as GitHub Pages does. /view renders on the client regardless.',
    matches: (problem, state) =>
      problem.kind === 'console error' &&
      problem.text.includes('status of 404') &&
      pathOf(problem.url) ===
        pathOf(new URL('view/_payload.json', state.siteBaseUrl).href),
  },
];

function isLocal(url: URL, state: BrowserState): boolean {
  return (
    url.host === new URL(state.siteBaseUrl).host ||
    url.hostname === new URL(state.endpoint).hostname
  );
}

/**
 * One problem, on one line, with the access token taken out: the printed
 * link carries it, the page sits on that link until the viewer spends it,
 * and a CI log is public.
 */
function describeProblem(problem: BrowserProblem): string {
  return redactCredentials(
    `${problem.kind} on ${problem.pageUrl}: ${problem.text}${problem.url ? ` (${problem.url})` : ''}`,
  );
}

type ViewerFixtures = {
  /**
   * Answers the requests that leave the machine and records every console
   * error and uncaught exception; once the test is done, fails it on any
   * that is not expected.
   */
  browserProblems: void;
};

type ViewerWorkerFixtures = {
  /** What the global setup started. */
  state: BrowserState;
  /** The graph the demo serves, checked against the schema it serves. */
  graph: GraphOutput;
  /** The demo's `information.json`. */
  information: InspectorInformation;
};

export const test = base.extend<ViewerFixtures, ViewerWorkerFixtures>({
  state: [
    // Playwright reads a fixture's dependencies from this pattern.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(readBrowserState());
    },
    { scope: 'worker' },
  ],

  graph: [
    async ({ state }, use) => {
      const endpoint = new URL(state.endpoint);
      const [graph, schema] = await Promise.all([
        inspectorRequest({
          url: endpointFile(endpoint, 'output.json'),
          token: state.token,
        }),
        inspectorRequest({
          url: endpointFile(endpoint, 'output.schema.json'),
          token: state.token,
        }),
      ]);

      expect(graph.status).toBe(200);
      expect(schema.status).toBe(200);
      await use(
        parseGraphOutput({ graphText: graph.text, schemaText: schema.text }),
      );
    },
    { scope: 'worker' },
  ],

  information: [
    async ({ state }, use) => {
      const response = await inspectorRequest({
        url: endpointFile(new URL(state.endpoint), 'information.json'),
        token: state.token,
      });

      expect(response.status).toBe(200);
      await use(parseJson(response.text, inspectorInformationSchema));
    },
    { scope: 'worker' },
  ],

  browserProblems: [
    async ({ context, page, state }, use) => {
      const problems: BrowserProblem[] = [];

      await context.route(
        (url) => !isLocal(url, state),
        async (route) => {
          const url = new URL(route.request().url());
          const known = OFF_MACHINE_ANSWERS.find(({ matches }) => matches(url));

          if (known) {
            await known.answer(route, url);
            return;
          }

          problems.push({
            kind: 'request off the machine',
            text: `${route.request().method()} refused: answer it in OFF_MACHINE_ANSWERS, with the reason, or keep the site from needing it`,
            url: url.href,
            pageUrl: page.url(),
          });
          await route.abort('blockedbyclient');
        },
      );

      page.on('console', (message) => {
        if (message.type() === 'error') {
          problems.push({
            kind: 'console error',
            text: message.text(),
            url: message.location().url,
            pageUrl: page.url(),
          });
        }
      });
      page.on('pageerror', (error) => {
        problems.push({
          kind: 'uncaught exception',
          text: `${error.name}: ${error.message}`,
          url: '',
          pageUrl: page.url(),
        });
      });

      await use();

      const unexpected = problems
        .filter(
          (problem) =>
            !EXPECTED_CONSOLE_ERRORS.some((expected) =>
              expected.matches(problem, state),
            ),
        )
        .map(describeProblem);

      expect(unexpected, 'The browser reported problems').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** A node of the navigator's graph, by the id the viewer gives it. */
export function graphNode(page: Page, nodeId: string): Locator {
  return page.locator(`.vue-flow__node[data-id=${JSON.stringify(nodeId)}]`);
}

/**
 * A graph viewer's root, which says where its automatic layout stands in
 * `data-layout-state` (`site/app/utils/module-layout-state.ts`).
 */
const GRAPH_VIEWER = '.graph-viewer[data-layout-state]';

/**
 * Where a viewer's layout comes to rest: an arrangement drawn (`ready`), or
 * ELK failed and the simple arrangement is drawn in its place (`failed`).
 */
const SETTLED_LAYOUT_STATES: ReadonlySet<string> = new Set(['ready', 'failed']);
const FAILED_LAYOUT_STATE = 'failed';

/** One viewer's layout as its root says it, and the notice a failed one shows. */
type ViewerLayout = {
  readonly state: string;
  readonly notice: string;
  /** The viewer as a failure message names it: its place on the page, its state. */
  readonly description: string;
};

/** Every graph viewer on the page, in document order, and where its layout stands. */
async function viewerLayouts(page: Page): Promise<ViewerLayout[]> {
  const viewers = await page.locator(GRAPH_VIEWER).evaluateAll((roots) =>
    roots.map((root) => ({
      state: root.getAttribute('data-layout-state') ?? '',
      notice:
        root
          .querySelector('.graph-viewer-layout-failure__text')
          ?.textContent?.trim() ?? '',
    })),
  );

  return viewers.map(({ state, notice }, index) => ({
    state,
    notice,
    description: `viewer ${index + 1} of ${viewers.length}: ${state}${notice ? ` (${notice})` : ''}`,
  }));
}

/**
 * Waits until every graph viewer on the page has settled its layout — on
 * `ready`, or on `failed` with the simple arrangement in its place — then
 * requires, of that settled snapshot, at least one viewer and none that
 * failed. The simple arrangement draws every node too, so a node on screen
 * cannot tell a laid-out graph from one whose layout broke; the viewer's own
 * `data-layout-state` can. Waits on that signal, never on time.
 */
export async function expectGraphLayoutsReady(page: Page): Promise<void> {
  // The poll's latest read. Once the poll passes, it is the snapshot found
  // settled, and both checks below judge that one: a fresh read could catch a
  // layout begun since, `arranging`, which is not `failed`.
  let snapshot: readonly ViewerLayout[] = [];

  await expect
    .poll(
      async () => {
        snapshot = await viewerLayouts(page);

        return snapshot.length === 0
          ? ['no graph viewer on the page yet']
          : snapshot
              .filter(({ state }) => !SETTLED_LAYOUT_STATES.has(state))
              .map(({ description }) => description);
      },
      {
        message:
          'Every graph viewer on the page settles its layout, on ready or failed',
      },
    )
    .toEqual([]);

  expect(snapshot.length, 'Graph viewers on the page').toBeGreaterThan(0);
  expect(
    snapshot
      .filter(({ state }) => state === FAILED_LAYOUT_STATE)
      .map(({ description }) => description),
    `Graph viewers whose layout failed and fell back to the simple arrangement, of: ${snapshot
      .map(({ description }) => description)
      .join('; ')}`,
  ).toEqual([]);
}

/**
 * The viewer's version gate. An endpoint that does not confirm it runs the
 * latest published inspector — the workspace build never does — is shown
 * only once the visitor acknowledges the difference, which this does, after
 * checking the gate names the version the demo reports.
 */
export async function passVersionGate({
  page,
  information,
}: {
  page: Page;
  information: InspectorInformation;
}): Promise<void> {
  if (information['is-static'] || information.isLatestVersion) {
    return;
  }

  const gate = page.getByRole('dialog', { name: 'Update available' });

  await expect(gate).toBeVisible();
  await expect(gate).toContainText(information.version);
  await gate.getByRole('button', { name: 'Continue' }).click();
  await expect(gate).toBeHidden();
}

/**
 * Opens the viewer link the demo printed, moved onto the site under test,
 * and checks it lands where a printed link lands: on the navigator, with
 * the access token out of the address bar.
 *
 * The link carries the token, and so does the address bar until the viewer
 * spends it, so nothing here lets a failure print either: navigation errors
 * and the address are reported with the credential taken out.
 */
export async function openPrintedLink({
  page,
  state,
  information,
}: {
  page: Page;
  state: BrowserState;
  information: InspectorInformation;
}): Promise<void> {
  try {
    await page.goto(state.viewerLink);
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- the caught error's message holds the access token, so it must not be attached as `cause`
    throw new Error(
      `Opening the printed link failed: ${redactCredentials(error instanceof Error ? error.message : String(error))}`,
    );
  }

  await expect
    .poll(() => redactCredentials(page.url()), {
      message: 'The printed link lands on the navigator',
    })
    .toBe(new URL('view/navigator', state.siteBaseUrl).href);
  expect(
    page.url().includes(state.token),
    'The access token is still in the address bar',
  ).toBe(false);
  await passVersionGate({ page, information });
}
