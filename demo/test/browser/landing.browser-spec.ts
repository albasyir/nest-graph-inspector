import type { Locator, Page } from '@playwright/test';
import type { GraphOutput } from 'nest-graph-inspector';
import {
  type DependencySide,
  dependencyLevels,
  dependencyStubCounts,
} from '../support/graph-facts';
import { type Box, isInside } from './box';
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

/**
 * Where the demo's canvas shows the bracket on screen: its box, below the
 * column headings pinned across its top when it has them. `null` while there
 * is no canvas to measure.
 */
async function visibleCanvas(page: Page): Promise<Box | null> {
  const canvas = await blastDemo(page)
    .locator('.module-bracket__canvas')
    .boundingBox();
  if (!canvas) {
    return null;
  }

  const headings = blastDemo(page).locator('.module-bracket__headings');
  const strip =
    (await headings.count()) > 0 ? await headings.boundingBox() : null;
  const top = strip ? strip.y + strip.height : canvas.y;
  return {
    x: canvas.x,
    y: top,
    width: canvas.width,
    height: canvas.y + canvas.height - top,
  };
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

/**
 * The smallest size, in CSS pixels, a module's name is drawn at when the
 * demo opens on its whole bracket: the site's `READABLE_ZOOM` for a compact
 * bracket, 0.96, times its 11.5px names (`site/app/utils/module-bracket-viewport.ts`).
 */
const WHOLE_READABLE_PX = 11;

type Depths = Record<DependencySide, number>;

/** How many modules the tallest column of a module's bracket holds, each side to its depth. */
function tallestColumn(
  graph: GraphOutput,
  moduleName: string,
  depth: Depths,
): number {
  return Math.max(
    1,
    ...(['left', 'right'] as const).flatMap((side) =>
      dependencyLevels(graph, moduleName, side)
        .slice(0, depth[side])
        .map((level) => level.length),
    ),
  );
}

/**
 * Waits for the demo to be ready, then requires it framed on its whole
 * bracket at `depth`: the module, every module the graph has on each side to
 * that depth, and every "+N more" stub past them, each wholly inside the
 * canvas, the panel and the first screen; no chip toward anything left out,
 * no card drawn back as cut off; every name at a size to read; and the panel
 * itself — steppers, canvas, zoom controls, key — on the first screen.
 */
async function expectWholeBracket(
  page: Page,
  graph: GraphOutput,
  moduleName: string,
  depth: Depths,
): Promise<void> {
  await expectDemoReady(page);
  await expect(center(page)).toContainText(moduleName);
  await page.evaluate(() => window.scrollTo(0, 0));

  const screen = page.viewportSize();
  const panel = await blastDemo(page).locator('.module-bracket').boundingBox();
  const canvas = await blastDemo(page)
    .locator('.module-bracket__canvas')
    .boundingBox();
  if (!screen || !panel || !canvas) {
    throw new Error('The demo has no panel or canvas on screen.');
  }
  expect(
    panel.y + panel.height,
    'The whole panel is on the first screen',
  ).toBeLessThanOrEqual(screen.height);

  const stubs = blastDemo(page).locator(
    '.vue-flow__node[data-bracket-node="stub"]',
  );
  const expectedStubs = (['left', 'right'] as const).reduce(
    (total, side) =>
      total + dependencyStubCounts(graph, moduleName, side, depth[side]).length,
    0,
  );
  await expect(stubs).toHaveCount(expectedStubs);

  const cards: { what: string; card: Locator }[] = [
    { what: moduleName, card: center(page) },
    ...(['left', 'right'] as const).flatMap((side) =>
      dependencyLevels(graph, moduleName, side)
        .slice(0, depth[side])
        .flat()
        .map((name) => ({
          what: `${name} (${side})`,
          card: bracketModule(page, side, name),
        })),
    ),
    ...Array.from({ length: expectedStubs }, (_, index) => ({
      what: `stub ${index + 1}`,
      card: stubs.nth(index),
    })),
  ];
  for (const { what, card } of cards) {
    const box = await card.boundingBox();
    expect(box, `${what} is drawn`).not.toBeNull();
    if (!box) {
      continue;
    }
    expect(isInside(box, canvas), `${what} is inside the canvas`).toBe(true);
    expect(isInside(box, panel), `${what} is inside the panel`).toBe(true);
    expect(
      isInside(box, { x: 0, y: 0, width: screen.width, height: screen.height }),
      `${what} is on the first screen`,
    ).toBe(true);
  }

  await expect(blastDemo(page).locator('[data-chip]')).toHaveCount(0);
  await expect(
    blastDemo(page).locator(
      '.module-bracket-module--cut, .module-bracket-stub--cut',
    ),
  ).toHaveCount(0);

  const smallestName = await blastDemo(page)
    .locator('.module-bracket-module__name')
    .evaluateAll((names) =>
      Math.min(
        ...names.map((name) => {
          const card = name.closest('.vue-flow__node');
          const zoom =
            card instanceof HTMLElement && card.offsetWidth > 0
              ? card.getBoundingClientRect().width / card.offsetWidth
              : 0;
          return Number.parseFloat(getComputedStyle(name).fontSize) * zoom;
        }),
      ),
    );
  expect(
    smallestName,
    'Every module name is drawn at a size to read',
  ).toBeGreaterThanOrEqual(WHOLE_READABLE_PX);
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

test('a move made from the keyboard keeps focus in the demo, even when the control it was made from is gone', async ({
  page,
  state,
}) => {
  await openLanding(page, state);

  // A card the demo draws on its right, put in the middle from the keyboard:
  // once there, its card is gone.
  const card = blastDemo(page)
    .locator('.vue-flow__node[data-bracket-node="module"][data-side="right"]')
    .first();
  const name = card.locator('.module-bracket-module__name');
  const target = (await name.textContent())?.trim();
  if (!target) {
    throw new Error('The first card the demo draws on its right has no name');
  }
  await card.getByRole('button').press('Enter');
  await expect(center(page)).toContainText(target);
  await expectDemoReady(page);
  await expect(blastDemo(page)).toBeFocused();

  // Reset, from the keyboard, is gone once the demo is back where it opened.
  await resetButton(page).press('Enter');
  await expect(center(page)).toContainText(LANDING_MODULE);
  await expectDemoReady(page);
  await expect(resetButton(page)).toHaveCount(0);
  await expect(blastDemo(page)).toBeFocused();

  // A stepper stays where it is, and so does focus.
  await stepper(page, 'right', 'fewer').press('Enter');
  await expectDemoReady(page);
  await expect(stepper(page, 'right', 'fewer')).toBeFocused();
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

test.describe('on a 1440×900 desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the demo opens on its whole bracket, on the first screen, and stays whole through every change', async ({
    page,
    state,
    graph,
  }) => {
    const opening: Depths = { left: DEFAULT_DEPTH, right: DEFAULT_DEPTH };
    const deeper: Depths = { left: DEFAULT_DEPTH, right: DEFAULT_DEPTH + 1 };

    await openLanding(page, state);
    await expectWholeBracket(page, graph, LANDING_MODULE, opening);

    await stepper(page, 'right', 'more').click();
    await expectDepth(page, 'right', DEFAULT_DEPTH + 1);
    await expectWholeBracket(page, graph, LANDING_MODULE, deeper);

    await stepper(page, 'right', 'fewer').click();
    await expectDepth(page, 'right', DEFAULT_DEPTH);
    await expectWholeBracket(page, graph, LANDING_MODULE, opening);

    // The "+N more" stub is on screen with the rest, and shows the next level.
    await blastDemo(page)
      .locator('.vue-flow__node[data-bracket-node="stub"][data-side="right"]')
      .first()
      .getByRole('button')
      .click();
    await expectDepth(page, 'right', DEFAULT_DEPTH + 1);
    await expectWholeBracket(page, graph, LANDING_MODULE, deeper);

    // Another module in the middle — of those drawn, the one whose bracket is
    // shortest, so it too reads whole — keeps the depths, and is whole too.
    const [target] = dependencyLevels(graph, LANDING_MODULE, 'right')
      .slice(0, deeper.right)
      .flat()
      .sort(
        (first, second) =>
          tallestColumn(graph, first, deeper) -
            tallestColumn(graph, second, deeper) ||
          (first < second ? -1 : first > second ? 1 : 0),
      );
    if (!target) {
      throw new Error(`No module depends on ${LANDING_MODULE}.`);
    }
    await bracketModule(page, 'right', target).getByRole('button').click();
    await expectWholeBracket(page, graph, target, deeper);

    await resetButton(page).click();
    await expectWholeBracket(page, graph, LANDING_MODULE, opening);
    await expect(page).toHaveURL(state.siteBaseUrl);
  });
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
    const size = page.viewportSize();
    if (!size) {
      throw new Error('The phone has no viewport size.');
    }
    const screen: Box = { x: 0, y: 0, width: size.width, height: size.height };
    for (const side of ['left', 'right'] as const) {
      const [first = []] = dependencyLevels(graph, LANDING_MODULE, side);
      const cards = first.map((name) => bracketModule(page, side, name));
      await expect
        .poll(
          async () => {
            const canvas = await visibleCanvas(page);
            let inView = 0;
            for (const card of cards) {
              // The canvas draws only the cards in view, and a card it has
              // not drawn would keep `boundingBox` waiting: it counts as none.
              if (!canvas || (await card.count()) === 0) {
                continue;
              }
              const box = await card.boundingBox();
              if (box && isInside(box, screen) && isInside(box, canvas)) {
                inView += 1;
              }
            }
            return inView;
          },
          {
            message: `A first-level module on the ${side} is drawn beside ${LANDING_MODULE}, wholly inside the screen and the canvas`,
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
