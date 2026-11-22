import type { Locator, Page } from '@playwright/test';
import type { GraphOutput } from 'nest-graph-inspector';
import {
  type DependencySide,
  dependencyLevels,
  dependencyStubCounts,
  listEndpointOf,
  moduleOnCycle,
  moduleWithDeepDependencies,
  moduleWithLinks,
} from '../support/graph-facts';
import type { InspectorInformation } from '../support/inspector-api';
import type { BrowserState } from './browser-state';
import {
  expect,
  expectGraphLayoutsReady,
  graphNode,
  openPrintedLink,
  passVersionGate,
  test,
} from './viewer.fixtures';

/**
 * A module's page in Chromium, against the demo running as a process of its
 * own: what it needs to its left, what needs it to its right, each side's
 * depth stepped on its own and kept in the address, Direct Run docked beside
 * the module's own graph. As in the other suites, nothing here names a module
 * of the demo: every module, level and count is read from the graph it serves.
 */

/**
 * How many levels each side of the page shows when its address does not say:
 * a fact of the site (`DEFAULT_BRACKET_DEPTH` in
 * `site/app/utils/module-dependency-bracket.ts`), not of the demo.
 */
const DEFAULT_DEPTH = 3;

/** A module on a cycle draws every level of both sides in well under this. */
const CYCLE_LAYOUT_BOUND_MS = 15_000;

/** The smallest size, in CSS pixels, a name on the canvas is drawn at when the page opens. */
const READABLE_PX = 12;

/**
 * The same on a phone, where the page draws its compact bracket so the first
 * level of each side fits beside the module.
 */
const READABLE_PHONE_PX = 11;

const SIDE_LABELS: Record<DependencySide, string> = {
  left: 'Needs',
  right: 'Needed by',
};

function modulePageUrl(
  state: BrowserState,
  moduleName: string,
  query = '',
): string {
  // Module names are class names, which `encodeModuleId` leaves as
  // `encodeURIComponent` does.
  return new URL(
    `view/navigator/modules/${encodeURIComponent(moduleName)}${query}`,
    state.siteBaseUrl,
  ).href;
}

function center(page: Page): Locator {
  return page.locator('.vue-flow__node[data-bracket-node="center"]');
}

function depthGroup(page: Page, side: DependencySide): Locator {
  return page.getByRole('group', { name: SIDE_LABELS[side], exact: true });
}

async function expectDepth(
  page: Page,
  side: DependencySide,
  depth: number,
): Promise<void> {
  await expect(depthGroup(page, side).locator('output')).toHaveText(
    new RegExp(`^${depth} levels?$`),
  );
}

/** A module card the page draws, by side and name. */
function bracketModule(
  page: Page,
  side: DependencySide,
  moduleName: string,
): Locator {
  return graphNode(page, `${side}:${encodeURIComponent(moduleName)}`);
}

/**
 * Frames the whole bracket, however small that draws it. The page opens on
 * its module at a size to read, and the canvas draws only the cards in view,
 * so what a side holds is counted from this overview.
 */
async function showWholeBracket(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Show the whole bracket', exact: true })
    .click();
}

/**
 * Waits until a piece of text on the canvas is drawn at a size to read —
 * once any pan the canvas is making has come to rest.
 */
async function expectReadable(
  text: Locator,
  smallest = READABLE_PX,
): Promise<void> {
  await expect(text).toBeInViewport();
  await expect
    .poll(() => renderedFontSize(text), {
      message: 'The text is drawn at a size to read',
    })
    .toBeGreaterThanOrEqual(smallest);
}

/** The size a piece of text on the canvas is drawn at: its font size, scaled by the zoom. */
async function renderedFontSize(text: Locator): Promise<number> {
  return text.evaluate((element) => {
    const card = element.closest('.vue-flow__node');
    if (!(card instanceof HTMLElement) || card.offsetWidth === 0) {
      throw new Error('The text is not on a card of the canvas');
    }

    const zoom = card.getBoundingClientRect().width / card.offsetWidth;
    return Number.parseFloat(getComputedStyle(element).fontSize) * zoom;
  });
}

/**
 * The chip at a side's edge of the canvas that brings that side's hidden
 * levels into view, naming them and counting their modules.
 */
function levelsChip(
  page: Page,
  side: DependencySide,
  moduleName: string,
): Locator {
  const count = ': \\d+ more modules?';
  return page.getByRole('button', {
    name:
      side === 'left'
        ? new RegExp(
            `^Show levels? [\\d–]+ of what ${moduleName} needs${count}$`,
          )
        : new RegExp(
            `^Show levels? [\\d–]+ of what needs ${moduleName}${count}$`,
          ),
  });
}

/**
 * How many of a side's modules at one level are drawn wholly inside the
 * canvas, below its pinned headings, at `smallest` pixels or more — the
 * canvas draws only the cards in view, so a card it skipped counts as none.
 */
async function readableAtLevel(
  page: Page,
  graph: GraphOutput,
  {
    moduleName,
    side,
    level,
    smallest,
  }: {
    moduleName: string;
    side: DependencySide;
    level: number;
    smallest: number;
  },
): Promise<number> {
  const canvas = await page.locator('.module-bracket__canvas').boundingBox();
  const headings = await page
    .locator('.module-bracket__headings')
    .boundingBox();
  if (!canvas) {
    return 0;
  }
  const top = headings ? headings.y + headings.height : canvas.y;

  let readable = 0;
  for (const name of dependencyLevels(graph, moduleName, side)[level - 1] ??
    []) {
    const text = bracketModule(page, side, name).locator(
      '.module-bracket-module__name',
    );
    if ((await text.count()) === 0) {
      continue;
    }
    const box = await text.boundingBox();
    const isInside =
      box !== null &&
      box.x >= canvas.x - 1 &&
      box.x + box.width <= canvas.x + canvas.width + 1 &&
      box.y >= top - 1 &&
      box.y + box.height <= canvas.y + canvas.height + 1;
    if (isInside && (await renderedFontSize(text)) >= smallest) {
      readable += 1;
    }
  }
  return readable;
}

/** The modules drawn on a side, level by level, each level's names sorted. */
async function drawnLevels(
  page: Page,
  side: DependencySide,
): Promise<string[][]> {
  await showWholeBracket(page);
  const cards = await page
    .locator(`.vue-flow__node[data-bracket-node="module"][data-side="${side}"]`)
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        level: Number(node.getAttribute('data-level')),
        name:
          node
            .querySelector('.module-bracket-module__name')
            ?.textContent?.trim() ?? '',
      })),
    );
  const levels: string[][] = [];

  for (const { level, name } of cards) {
    const names = levels[level - 1] ?? [];
    names.push(name);
    levels[level - 1] = names;
  }

  return Array.from(levels, (names = []) => [...names].sort());
}

/** Waits until a side draws exactly the levels the graph says it has, up to `depth`. */
async function expectLevels({
  page,
  graph,
  moduleName,
  side,
  depth,
}: {
  page: Page;
  graph: GraphOutput;
  moduleName: string;
  side: DependencySide;
  depth: number;
}): Promise<void> {
  const expected = dependencyLevels(graph, moduleName, side).slice(0, depth);

  await expect
    .poll(() => drawnLevels(page, side), {
      message: `The ${side} side of ${moduleName} draws its first ${depth} levels`,
    })
    .toEqual(expected);
}

/** The "+N modules" counts on a side's stubs, sorted. */
async function drawnStubCounts(
  page: Page,
  side: DependencySide,
): Promise<number[]> {
  await showWholeBracket(page);
  const labels = await page
    .locator(`.vue-flow__node[data-bracket-node="stub"][data-side="${side}"]`)
    .allTextContents();

  return labels
    .map((label) => Number(/\+(\d+)/.exec(label)?.[1]))
    .sort((left, right) => left - right);
}

/** Opens a module's page from the navigator, by clicking its module there. */
async function openFromNavigator({
  page,
  state,
  information,
  moduleName,
}: {
  page: Page;
  state: BrowserState;
  information: InspectorInformation;
  moduleName: string;
}): Promise<void> {
  await openPrintedLink({ page, state, information });
  await expectGraphLayoutsReady(page);
  await graphNode(page, `module-${moduleName}`)
    .locator('.module-subgraph__label')
    .click();
  await expect(page).toHaveURL(modulePageUrl(state, moduleName));
  await expect(center(page)).toContainText(moduleName);
}

test('clicking a module in the navigator opens its page: three levels each side, and a stub where a side goes on', async ({
  page,
  state,
  graph,
  information,
}) => {
  const moduleName = moduleWithDeepDependencies(graph, DEFAULT_DEPTH);

  await openFromNavigator({ page, state, information, moduleName });
  await expect(page).toHaveTitle(/Module Deep Dive/);
  await expect(
    page.getByRole('heading', { level: 1, name: moduleName }),
  ).toBeVisible();

  for (const side of ['left', 'right'] as const) {
    await expectDepth(page, side, DEFAULT_DEPTH);
    await expectLevels({ page, graph, moduleName, side, depth: DEFAULT_DEPTH });
    await expect
      .poll(() => drawnStubCounts(page, side))
      .toEqual(dependencyStubCounts(graph, moduleName, side, DEFAULT_DEPTH));
  }

  // A stub shows one more level of its own side, and only of its side.
  await page
    .locator('.vue-flow__node[data-bracket-node="stub"][data-side="left"]')
    .first()
    .getByRole('button')
    .click();
  await expect(page).toHaveURL(
    modulePageUrl(state, moduleName, `?left=${DEFAULT_DEPTH + 1}`),
  );
  await expectDepth(page, 'left', DEFAULT_DEPTH + 1);
  await expectDepth(page, 'right', DEFAULT_DEPTH);
  await expectLevels({
    page,
    graph,
    moduleName,
    side: 'left',
    depth: DEFAULT_DEPTH + 1,
  });
});

test('the page opens on its module at a size its names read at, the rest a chip away', async ({
  page,
  state,
  graph,
  information,
}) => {
  const moduleName = moduleWithDeepDependencies(graph, DEFAULT_DEPTH);
  const levels = dependencyLevels(graph, moduleName, 'left');
  const [first] = levels[0] ?? [];
  const [deepest] = levels[DEFAULT_DEPTH - 1] ?? [];
  if (!first || !deepest) {
    throw new Error(`${moduleName} has no ${DEFAULT_DEPTH} levels on the left`);
  }

  await openFromNavigator({ page, state, information, moduleName });

  // The module, and the first level beside it, at a size to read.
  await expectReadable(center(page).locator('.module-bracket-center__name'));
  await expectReadable(
    bracketModule(page, 'left', first).locator('.module-bracket-module__name'),
  );

  // What the canvas cannot hold at that size is named at its edge, and the
  // chip goes there, at the same size.
  await expect(bracketModule(page, 'left', deepest)).not.toBeInViewport();
  await levelsChip(page, 'left', moduleName).click();
  await expectReadable(
    bracketModule(page, 'left', deepest).locator(
      '.module-bracket-module__name',
    ),
  );
});

test("imports besides the bracket's own show for the module pointed at, or all at once", async ({
  page,
  state,
  graph,
  information,
}) => {
  const moduleName = moduleWithLinks(graph, DEFAULT_DEPTH);
  const links = page.locator('.vue-flow__edge.bracket-edge--link');

  await openFromNavigator({ page, state, information, moduleName });
  await showWholeBracket(page);

  // The bracket reads first: no link is drawn until one is asked for.
  await expect(links).toHaveCount(0);
  const showAll = page.getByRole('switch', { name: 'Show all imports' });
  await showAll.click();
  await expect(links.first()).toBeVisible();

  const linkId = (await links.first().getAttribute('data-id')) ?? '';
  const ends: unknown = JSON.parse(linkId.slice(linkId.indexOf(':') + 1));
  const source: unknown = Array.isArray(ends) ? ends[0] : undefined;
  if (typeof source !== 'string') {
    throw new Error(`The link ${linkId} names no module it starts at`);
  }

  await showAll.click();
  await expect(links).toHaveCount(0);

  // Pointing at a module draws its own links, and only while it is pointed at.
  await graphNode(page, source).getByRole('link').hover();
  // An edge id is JSON, in double quotes; module names hold no single quote.
  await expect(
    page.locator(`.vue-flow__edge[data-id='${linkId}']`),
  ).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(links).toHaveCount(0);
});

test("each side's depth changes on its own, and the address keeps it", async ({
  page,
  state,
  graph,
  information,
}) => {
  const moduleName = moduleWithDeepDependencies(graph, DEFAULT_DEPTH);
  const deeper = DEFAULT_DEPTH + 1;

  await openFromNavigator({ page, state, information, moduleName });

  await depthGroup(page, 'left')
    .getByRole('button', { name: 'Show one more level' })
    .click();
  await expect(page).toHaveURL(
    modulePageUrl(state, moduleName, `?left=${deeper}`),
  );
  await expectDepth(page, 'left', deeper);
  await expectDepth(page, 'right', DEFAULT_DEPTH);
  await expectLevels({ page, graph, moduleName, side: 'left', depth: deeper });
  await expectLevels({
    page,
    graph,
    moduleName,
    side: 'right',
    depth: DEFAULT_DEPTH,
  });

  await depthGroup(page, 'right')
    .getByRole('button', { name: 'Show one more level' })
    .click();
  await expect(page).toHaveURL(
    modulePageUrl(state, moduleName, `?left=${deeper}&right=${deeper}`),
  );
  await expectDepth(page, 'left', deeper);
  await expectDepth(page, 'right', deeper);
  await expectLevels({ page, graph, moduleName, side: 'right', depth: deeper });

  await depthGroup(page, 'left')
    .getByRole('button', { name: 'Show one level fewer' })
    .click();
  await expect(page).toHaveURL(
    modulePageUrl(state, moduleName, `?right=${deeper}`),
  );
  await expectDepth(page, 'left', DEFAULT_DEPTH);

  // One level is the fewest a side shows.
  for (let depth = DEFAULT_DEPTH; depth > 1; depth -= 1) {
    await depthGroup(page, 'left')
      .getByRole('button', { name: 'Show one level fewer' })
      .click();
  }
  await expectDepth(page, 'left', 1);
  await expect(
    depthGroup(page, 'left').getByRole('button', {
      name: 'Show one level fewer',
    }),
  ).toBeDisabled();
  await expectLevels({ page, graph, moduleName, side: 'left', depth: 1 });

  // Each step was an address of its own.
  await page.goBack();
  await expectDepth(page, 'left', 2);
  await expectDepth(page, 'right', deeper);
});

test('clicking another module re-centres on it, and Back steps back through the modules to the navigator', async ({
  page,
  state,
  graph,
  information,
}) => {
  const moduleName = moduleWithDeepDependencies(graph, DEFAULT_DEPTH);
  const [neighbour] = dependencyLevels(graph, moduleName, 'right')[0] ?? [];

  if (!neighbour) {
    throw new Error(
      `Nothing imports ${moduleName}, so there is no module to move to`,
    );
  }

  await openFromNavigator({ page, state, information, moduleName });

  await bracketModule(page, 'right', neighbour).getByRole('link').click();
  await expect(page).toHaveURL(modulePageUrl(state, neighbour));
  await expect(center(page)).toContainText(neighbour);
  await expect(
    page.getByRole('heading', { level: 1, name: neighbour }),
  ).toBeVisible();
  await expectLevels({
    page,
    graph,
    moduleName: neighbour,
    side: 'left',
    depth: DEFAULT_DEPTH,
  });

  await page.goBack();
  await expect(page).toHaveURL(modulePageUrl(state, moduleName));
  await expect(center(page)).toContainText(moduleName);

  await page.goBack();
  await expect(page).toHaveURL(
    new URL('view/navigator', state.siteBaseUrl).href,
  );
  await expectGraphLayoutsReady(page);
  await expect(graphNode(page, `module-${moduleName}`)).toBeVisible();
});

test('Direct Run opens beside the module, from its card, and runs a method', async ({
  page,
  state,
  graph,
  information,
}) => {
  const handler = listEndpointOf(graph);
  const controllerNodeId = `controller-${handler.moduleName}-${handler.controllerName}`;

  await openFromNavigator({
    page,
    state,
    information,
    moduleName: handler.moduleName,
  });

  // The card says how many of the module's targets Direct Run can call, and
  // opens the inside view on the first.
  await center(page)
    .getByRole('link', { name: /Direct Run/ })
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `/view/navigator/modules/${handler.moduleName}\\?view=inside&direct-run-on=`,
    ),
  );

  const panel = page.getByRole('region', { name: 'Direct Run' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Another target of the module takes the panel over.
  await graphNode(page, controllerNodeId).click();
  await expect(page).toHaveURL(
    modulePageUrl(
      state,
      handler.moduleName,
      `?view=inside&direct-run-on=${controllerNodeId}`,
    ),
  );
  await expect(panel).toContainText(handler.controllerName);
  await panel
    .getByRole('tab', { name: handler.methodName, exact: true })
    .click();
  await panel.getByRole('button', { name: 'Run', exact: true }).click();

  const result = panel.getByRole('region', { name: 'Last run' });
  await expect(result).toContainText(`Last run · ${handler.methodName}()`);
  await expect(result).toContainText('Success');

  // Closing it takes it out of the address.
  await panel.getByRole('button', { name: 'Close Direct Run' }).click();
  await expect(page).toHaveURL(
    modulePageUrl(state, handler.moduleName, '?view=inside'),
  );
  await expect(panel).toHaveCount(0);
});

test('a module on a cycle draws every level of both sides, quickly, and says it is on a cycle', async ({
  page,
  state,
  graph,
  information,
}) => {
  const moduleName = moduleOnCycle(graph);
  const levels = {
    left: dependencyLevels(graph, moduleName, 'left').length,
    right: dependencyLevels(graph, moduleName, 'right').length,
  };

  await openPrintedLink({ page, state, information });
  // Asked for far more than either side has: each shows all it has.
  const asked = Object.keys(graph.modules).length * 4;
  const started = Date.now();
  await page.goto(
    modulePageUrl(state, moduleName, `?left=${asked}&right=${asked}`),
  );
  await passVersionGate({ page, information });

  for (const side of ['left', 'right'] as const) {
    await expectDepth(page, side, levels[side]);
    await expect(
      depthGroup(page, side).getByRole('button', {
        name: 'Show one more level',
      }),
    ).toBeDisabled();
    await expectLevels({ page, graph, moduleName, side, depth: levels[side] });
  }
  expect(Date.now() - started).toBeLessThan(CYCLE_LAYOUT_BOUND_MS);

  await expect(
    center(page).getByText('On a cycle', { exact: true }),
  ).toBeVisible();
  // Every module on the reported cycles through it carries the mark, on each
  // side it is drawn.
  const cycles = graph.cycles.modules.filter((cycle) =>
    cycle.path.includes(moduleName),
  );
  const onCycle = new Set(
    cycles.flatMap((cycle) => cycle.path).filter((name) => name !== moduleName),
  );
  for (const name of onCycle) {
    for (const side of ['left', 'right'] as const) {
      await expect(
        bracketModule(page, side, name).locator('[data-cycle-badge]'),
      ).toBeVisible();
    }
  }

  // Pressing a cycle's number traces it — its connectors lit, the rest kept
  // back — until it is pressed again.
  const [cycle] = cycles;
  if (!cycle) {
    throw new Error(`No reported cycle runs through ${moduleName}`);
  }
  const label = page
    .getByRole('button', {
      name: new RegExp(`^Trace cycle (#\\d+ )*#${cycle.id}( #\\d+)*$`),
    })
    .first();
  await label.click();
  await expect(label).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(1, 1);
  await expect(
    page.locator('.vue-flow__edge.bracket-edge--lit').first(),
  ).toBeVisible();
  await expect(
    page.locator('.vue-flow__edge.bracket-edge--dimmed').first(),
  ).toBeVisible();
  await label.click();
  await expect(label).toHaveAttribute('aria-pressed', 'false');
  // Pointed at, a number traces its cycle too: away from it, nothing is lit.
  await page.mouse.move(1, 1);
  await expect(page.locator('.vue-flow__edge.bracket-edge--lit')).toHaveCount(
    0,
  );
});

test("the landing page's graph opens a module's page on the example, and Back returns to the landing page", async ({
  page,
  state,
  graph,
}) => {
  // The example the landing page draws is exported from the same build as
  // the demo these tests run, so it holds the same modules.
  const moduleName = moduleWithDeepDependencies(graph, DEFAULT_DEPTH);

  await page.goto(state.siteBaseUrl);
  await expectGraphLayoutsReady(page);
  // The hero preview is the first graph on the page.
  await graphNode(page, `module-${moduleName}`)
    .first()
    .locator('.module-subgraph__label')
    .click();

  await expect(page).toHaveURL(modulePageUrl(state, moduleName));
  await expect(center(page)).toContainText(moduleName);
  await expectDepth(page, 'left', DEFAULT_DEPTH);

  await page.goBack();
  await expect(page).toHaveURL(state.siteBaseUrl);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the module page fits the screen, with its controls in reach', async ({
    page,
    state,
    graph,
    information,
  }) => {
    const moduleName = moduleWithDeepDependencies(graph, DEFAULT_DEPTH);

    await openPrintedLink({ page, state, information });
    await page.goto(modulePageUrl(state, moduleName));
    await passVersionGate({ page, information });
    await expect(center(page)).toBeVisible();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, 'The page scrolls sideways').toBeLessThanOrEqual(0);

    const canvasControls = page.locator('.vue-flow__controls');
    const controls = [
      ...(['left', 'right'] as const).flatMap((side) => [
        depthGroup(page, side).getByRole('button', {
          name: 'Show one more level',
        }),
        depthGroup(page, side).getByRole('button', {
          name: 'Show one level fewer',
        }),
        levelsChip(page, side, moduleName),
      ]),
      page
        .getByRole('navigation', { name: 'Module views' })
        .getByRole('link', { name: 'Inside Module' }),
      page.getByRole('link', { name: 'Back to Application Graph' }),
      canvasControls.getByRole('button', { name: 'Zoom in' }),
      canvasControls.getByRole('button', { name: 'Zoom out' }),
      canvasControls.getByRole('button', { name: 'Show the whole bracket' }),
      canvasControls.getByRole('button', { name: `Back to ${moduleName}` }),
    ];
    for (const control of controls) {
      await expect(control).toBeInViewport();
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
    }

    // The page opens on the module with its neighbours: the first level of
    // each side inside the canvas beside it, every name at a size to read.
    await expectReadable(center(page).locator('.module-bracket-center__name'));
    for (const side of ['left', 'right'] as const) {
      await expectDepth(page, side, DEFAULT_DEPTH);
      await expect
        .poll(
          () =>
            readableAtLevel(page, graph, {
              moduleName,
              side,
              level: 1,
              smallest: READABLE_PHONE_PX,
            }),
          {
            message: `A first-level module on the ${side} is drawn inside the canvas at ${READABLE_PHONE_PX}px or more`,
          },
        )
        .toBeGreaterThanOrEqual(1);
    }

    // The levels further out are a chip away, and it brings the next one in
    // at that size.
    await levelsChip(page, 'left', moduleName).tap();
    await expect
      .poll(
        () =>
          readableAtLevel(page, graph, {
            moduleName,
            side: 'left',
            level: 2,
            smallest: READABLE_PHONE_PX,
          }),
        {
          message: `A second-level module on the left is drawn inside the canvas at ${READABLE_PHONE_PX}px or more`,
        },
      )
      .toBeGreaterThanOrEqual(1);

    await depthGroup(page, 'right')
      .getByRole('button', { name: 'Show one more level' })
      .tap();
    await expect(page).toHaveURL(
      modulePageUrl(state, moduleName, `?right=${DEFAULT_DEPTH + 1}`),
    );
  });
});
