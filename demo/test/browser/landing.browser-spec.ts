import type { Locator, Page } from '@playwright/test';
import type { GraphOutput } from 'nest-graph-inspector';
import {
  type DependencySide,
  dependencyLevels,
  dependencyStubCounts,
} from '../support/graph-facts';
import type { BrowserState } from './browser-state';
import {
  DEFAULT_DEPTH,
  bracketModule,
  center,
  depthGroup,
  drawnStubCounts,
  expectDepth,
  expectLevels,
  modulePageUrl,
  showWholeBracket,
} from './module-bracket';
import {
  expect,
  expectGraphLayoutsReady,
  graphNode,
  test,
} from './viewer.fixtures';

/**
 * The landing page's hero in Chromium: the blast effect of one module of the
 * demo — its dependency bracket, kept in place on the page — and the two ways
 * out of it. The landing page draws the demo's static graph, exported from
 * the same build as the demo these tests run, so every module, level and
 * count expected here is read from the graph that demo serves.
 */

/**
 * The module the demo opens on: a fact of the site (`BLAST_DEMO_MODULE` in
 * `site/app/utils/landing-blast-demo.ts`), not of the demo.
 */
const LANDING_MODULE = 'CustomerModule';

/** Bright Line, however it is written: gone from the site, and to stay gone. */
const BRIGHT_LINE = /bright[\s-]*line/i;

function blastDemo(page: Page): Locator {
  return page.getByRole('region', { name: 'Blast effect', exact: true });
}

/**
 * Waits for the demo's own word that it is ready: a graph drawn, and the
 * bracket framed where it opens — the root's `data-ready`, never a timer.
 */
async function expectDemoReady(page: Page): Promise<void> {
  await expect(blastDemo(page)).toHaveAttribute('data-ready', 'true');
}

async function openLanding(page: Page, state: BrowserState): Promise<void> {
  await page.goto(state.siteBaseUrl);
  await expectDemoReady(page);
  await expect(center(page)).toContainText(LANDING_MODULE);
}

function stepper(
  page: Page,
  side: DependencySide,
  step: 'more' | 'fewer',
): Locator {
  return depthGroup(page, side).getByRole('button', {
    name: step === 'more' ? 'Show one more level' : 'Show one level fewer',
  });
}

function resetButton(page: Page): Locator {
  return blastDemo(page).getByRole('button', {
    name: `Reset to ${LANDING_MODULE}`,
  });
}

/** How far a change to a module reaches, as the line beside the demo says it. */
function describeReach(graph: GraphOutput, moduleName: string): string {
  const levels = dependencyLevels(graph, moduleName, 'right');
  const modules = levels.flat().length;
  const count = `${modules} ${modules === 1 ? 'module' : 'modules'}`;
  const distance =
    levels.length > 1
      ? `up to ${levels.length} levels away`
      : modules === 1
        ? 'directly'
        : 'all directly';

  return `A change to ${moduleName} reaches ${count}, ${distance}.`;
}

/** Text anywhere on the page that offers Bright Line, or a control named for it. */
async function expectNoBrightLine(page: Page): Promise<void> {
  await expect(page.getByText(BRIGHT_LINE)).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: BRIGHT_LINE })).toHaveCount(
    0,
  );
  await expect(page.getByRole('switch', { name: BRIGHT_LINE })).toHaveCount(0);
}

test('the landing page opens on the blast effect of its module: both sides as the graph has them, and how far a change reaches', async ({
  page,
  state,
  graph,
}) => {
  expect(
    Object.keys(graph.modules),
    `The demo has ${LANDING_MODULE}, the module the landing page opens on`,
  ).toContain(LANDING_MODULE);
  expect(
    dependencyLevels(graph, LANDING_MODULE, 'right').length,
    `Modules depend on ${LANDING_MODULE} more than ${DEFAULT_DEPTH} levels deep, so the demo has a stub to show`,
  ).toBeGreaterThan(DEFAULT_DEPTH);

  await openLanding(page, state);
  await expectNoBrightLine(page);
  await expect(blastDemo(page)).toContainText(
    describeReach(graph, LANDING_MODULE),
  );

  for (const side of ['left', 'right'] as const) {
    const levels = dependencyLevels(graph, LANDING_MODULE, side);
    await expectDepth(page, side, Math.min(DEFAULT_DEPTH, levels.length));
    await expectLevels({
      page,
      graph,
      moduleName: LANDING_MODULE,
      side,
      depth: DEFAULT_DEPTH,
    });
    await expect
      .poll(() => drawnStubCounts(page, side))
      .toEqual(
        dependencyStubCounts(graph, LANDING_MODULE, side, DEFAULT_DEPTH),
      );
  }

  // None of it was a navigation.
  await expect(page).toHaveURL(state.siteBaseUrl);
});

test("each side's depth steps down and up, and a stub shows the next level, all on the landing page", async ({
  page,
  state,
  graph,
}) => {
  await openLanding(page, state);

  await stepper(page, 'right', 'fewer').click();
  await expectDepth(page, 'right', DEFAULT_DEPTH - 1);
  await expectLevels({
    page,
    graph,
    moduleName: LANDING_MODULE,
    side: 'right',
    depth: DEFAULT_DEPTH - 1,
  });
  await expectDemoReady(page);

  await stepper(page, 'right', 'more').click();
  await expectDepth(page, 'right', DEFAULT_DEPTH);
  await expectLevels({
    page,
    graph,
    moduleName: LANDING_MODULE,
    side: 'right',
    depth: DEFAULT_DEPTH,
  });

  // A stub sits past the last level drawn, off the frame the demo opens at:
  // the whole bracket brings it into view, and it shows one more level.
  await showWholeBracket(page);
  await page
    .locator('.vue-flow__node[data-bracket-node="stub"][data-side="right"]')
    .first()
    .getByRole('button')
    .click();
  await expectDepth(page, 'right', DEFAULT_DEPTH + 1);
  await expectLevels({
    page,
    graph,
    moduleName: LANDING_MODULE,
    side: 'right',
    depth: DEFAULT_DEPTH + 1,
  });
  await expectDemoReady(page);
  await expect(resetButton(page)).toBeVisible();
  await expect(page).toHaveURL(state.siteBaseUrl);
});

test('clicking another module puts it in the middle of the demo, on the landing page, and Reset goes back', async ({
  page,
  state,
  graph,
}) => {
  // A module a change to the landing module hits, drawn within the depth
  // the demo opens at, that needs modules more than one level deep — so its
  // own left side has a depth to step.
  const right = dependencyLevels(graph, LANDING_MODULE, 'right');
  const target = right
    .slice(0, DEFAULT_DEPTH)
    .flat()
    .sort()
    .find((name) => dependencyLevels(graph, name, 'left').length > 1);
  if (!target) {
    throw new Error(
      `No module within ${DEFAULT_DEPTH} levels of what depends on ${LANDING_MODULE} needs modules more than one level deep.`,
    );
  }

  await openLanding(page, state);
  await showWholeBracket(page);
  await bracketModule(page, 'right', target).getByRole('button').click();

  await expect(center(page)).toContainText(target);
  await expectDemoReady(page);
  await expect(page).toHaveURL(state.siteBaseUrl);
  await expect(blastDemo(page)).toContainText(describeReach(graph, target));

  const leftDepth = Math.min(
    DEFAULT_DEPTH,
    dependencyLevels(graph, target, 'left').length,
  );
  await expectDepth(page, 'left', leftDepth);
  await stepper(page, 'left', 'fewer').click();
  await expectDepth(page, 'left', leftDepth - 1);
  await expectLevels({
    page,
    graph,
    moduleName: target,
    side: 'left',
    depth: leftDepth - 1,
  });
  await stepper(page, 'left', 'more').click();
  await expectDepth(page, 'left', leftDepth);
  await expectLevels({
    page,
    graph,
    moduleName: target,
    side: 'left',
    depth: leftDepth,
  });
  await expect(page).toHaveURL(state.siteBaseUrl);

  await resetButton(page).click();
  await expect(center(page)).toContainText(LANDING_MODULE);
  await expectDepth(
    page,
    'left',
    Math.min(
      DEFAULT_DEPTH,
      dependencyLevels(graph, LANDING_MODULE, 'left').length,
    ),
  );
  await expectDemoReady(page);
  await expect(resetButton(page)).toHaveCount(0);
  await expect(page).toHaveURL(state.siteBaseUrl);
});

test('"Open full graph" opens the navigator on the example, and its Graph settings offer no Bright Line', async ({
  page,
  state,
  graph,
}) => {
  await openLanding(page, state);
  await blastDemo(page).getByRole('link', { name: 'Open full graph' }).click();

  await expect(page).toHaveURL(
    new URL('view/navigator', state.siteBaseUrl).href,
  );
  await expectGraphLayoutsReady(page);
  await expect(graphNode(page, `module-${graph.root}`)).toBeVisible();
  await expectNoBrightLine(page);

  await page.getByRole('button', { name: 'Graph settings' }).click();
  const settings = page.locator('.graph-viewer-settings__content');
  await expect(settings).toContainText('Show module to module line');
  await expect(settings).not.toContainText(BRIGHT_LINE);
  await expectNoBrightLine(page);
});

test('"Open this module in the viewer" opens its page, with no Bright Line, and Back returns to the demo', async ({
  page,
  state,
}) => {
  await openLanding(page, state);
  await blastDemo(page)
    .getByRole('link', { name: 'Open this module in the viewer' })
    .click();

  await expect(page).toHaveURL(modulePageUrl(state, LANDING_MODULE));
  await expect(
    page.getByRole('heading', { level: 1, name: LANDING_MODULE }),
  ).toBeVisible();
  await expectDepth(page, 'right', DEFAULT_DEPTH);
  await expectNoBrightLine(page);

  await page.goBack();
  await expect(page).toHaveURL(state.siteBaseUrl);
  await expectDemoReady(page);
  await expect(center(page)).toContainText(LANDING_MODULE);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the demo fits the screen: the module and both first levels, its controls in reach', async ({
    page,
    state,
    graph,
  }) => {
    await openLanding(page, state);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, 'The page scrolls sideways').toBeLessThanOrEqual(0);

    await blastDemo(page).scrollIntoViewIfNeeded();
    await expect(center(page)).toBeInViewport();
    for (const side of ['left', 'right'] as const) {
      const [first = []] = dependencyLevels(graph, LANDING_MODULE, side);
      const cards = first.map((name) => bracketModule(page, side, name));
      await expect
        .poll(
          async () => {
            let inView = 0;
            for (const card of cards) {
              const box = await card.boundingBox();
              if (box && box.x >= 0 && box.x + box.width <= 390) {
                inView += 1;
              }
            }
            return inView;
          },
          {
            message: `A first-level module on the ${side} is drawn beside ${LANDING_MODULE}, inside the screen`,
          },
        )
        .toBeGreaterThanOrEqual(1);
    }

    const canvasControls = blastDemo(page).locator('.vue-flow__controls');
    const controls = [
      ...(['left', 'right'] as const).flatMap((side) => [
        stepper(page, side, 'more'),
        stepper(page, side, 'fewer'),
      ]),
      canvasControls.getByRole('button', { name: 'Zoom in' }),
      canvasControls.getByRole('button', { name: 'Zoom out' }),
      canvasControls.getByRole('button', { name: 'Show the whole bracket' }),
      canvasControls.getByRole('button', {
        name: `Back to ${LANDING_MODULE}`,
      }),
      blastDemo(page).getByRole('link', {
        name: 'Open this module in the viewer',
      }),
      blastDemo(page).getByRole('link', { name: 'Open full graph' }),
    ];
    for (const control of controls) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
    }

    // A tap on a module re-centres the demo there, on the landing page.
    const [target] = dependencyLevels(graph, LANDING_MODULE, 'right')[0] ?? [];
    if (!target) {
      throw new Error(`No module depends on ${LANDING_MODULE}.`);
    }
    await blastDemo(page).scrollIntoViewIfNeeded();
    await showWholeBracket(page);
    await bracketModule(page, 'right', target).getByRole('button').tap();
    await expect(center(page)).toContainText(target);
    await expectDemoReady(page);
    await expect(page).toHaveURL(state.siteBaseUrl);
    await expectNoBrightLine(page);
  });
});
