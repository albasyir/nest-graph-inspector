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
 * The landing page in Chromium: its hero, the demo's whole graph as the page
 * has always opened on, and the sections after it, each a picture beside its
 * words, the pictures alternating left and right. The second is the blast
 * effect: one module of the demo in its dependency bracket, kept in place on
 * the page, and the two ways out of it. The landing page draws the demo's
 * static graph, exported from the same build as the demo these tests run, so
 * every module, level and count expected here is read from the graph that
 * demo serves.
 */

/**
 * The module the demo opens on: a fact of the site (`BLAST_DEMO_MODULE` in
 * `site/app/utils/landing-blast-demo.ts`), not of the demo.
 */
const LANDING_MODULE = 'CustomerModule';

/** The blast effect's section, by its heading: a fact of `site/content/index.md`. */
const BLAST_SECTION = 'See the Blast Effect of a Change';

/**
 * The sections after the hero, in the order the page sets them, the first
 * with its picture on the left of its words and each next on the other side
 * (`reverse` in `site/content/index.md`).
 */
const SECTIONS = [
  BLAST_SECTION,
  'Find Circular Dependencies Fast',
  'Context-Aware AI Assistant',
  'Run Providers From The Graph',
] as const;

/** Bright Line, however it is written: gone from the site, and to stay gone. */
const BRIGHT_LINE = /bright[\s-]*line/i;

/**
 * The smallest size, in CSS pixels, a module's name is drawn at where the
 * demo opens: the site's `READABLE_ZOOM` for a compact bracket, 0.96, times
 * its 11.5px names (`site/app/utils/module-bracket-viewport.ts`).
 */
const READABLE_PX = 11;

/** The landing page's hero: the block its one `h1` heads. */
function hero(page: Page): Locator {
  return page
    .getByRole('heading', { level: 1 })
    .locator('xpath=ancestor::*[@data-slot="root"][1]');
}

/** A section of the landing page, by its heading. */
function pageSection(page: Page, title: string): Locator {
  return page
    .getByRole('heading', { level: 2, name: title, exact: true })
    .locator('xpath=ancestor::section[@data-slot="root"][1]');
}

/**
 * A section's own container: the one directly inside it, not one of a
 * component set in its picture.
 */
function sectionContainer(section: Locator): Locator {
  return section.locator(':scope > [data-slot="container"]');
}

/** A section's words — its heading, description and features — and its picture beside them. */
function sectionParts(section: Locator): { words: Locator; picture: Locator } {
  const container = sectionContainer(section);
  return {
    words: container.locator(':scope > [data-slot="wrapper"]'),
    picture: container.locator(':scope > :not([data-slot="wrapper"])').first(),
  };
}

/** The blast-effect demo, found by its section's heading. */
function blastDemo(page: Page): Locator {
  return pageSection(page, BLAST_SECTION).getByRole('region', {
    name: 'Blast effect',
    exact: true,
  });
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

/** How far a change to a module reaches, as the line under the demo says it. */
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

/** The size a card's name is drawn at: its font size, scaled by the zoom. */
async function drawnNameSize(card: Locator): Promise<number> {
  return card.evaluate((node) => {
    const name = node.querySelector(
      '.module-bracket-module__name, .module-bracket-center__name',
    );
    if (!(node instanceof HTMLElement) || !name || node.offsetWidth === 0) {
      throw new Error('The card has no name drawn');
    }
    const zoom = node.getBoundingClientRect().width / node.offsetWidth;
    return Number.parseFloat(getComputedStyle(name).fontSize) * zoom;
  });
}

/**
 * Waits for the demo to be ready, then requires it opened on `moduleName` as
 * a section's column draws it: the module and every module of the first
 * level on each side drawn wholly inside the canvas, below its pinned
 * headings, each name at a size to read. The whole bracket is wider than a
 * column draws it at that size, so the rest is a chip or a step away.
 */
async function expectOpenOnModule(
  page: Page,
  graph: GraphOutput,
  moduleName: string,
): Promise<void> {
  await expectDemoReady(page);
  await expect(center(page)).toContainText(moduleName);
  const canvas = await visibleCanvas(page);
  if (!canvas) {
    throw new Error('The demo has no canvas on screen.');
  }

  const cards = [
    { what: moduleName, card: center(page) },
    ...(['left', 'right'] as const).flatMap((side) =>
      (dependencyLevels(graph, moduleName, side)[0] ?? []).map((name) => ({
        what: `${name} (${side})`,
        card: bracketModule(page, side, name),
      })),
    ),
  ];
  for (const { what, card } of cards) {
    await expect(card, `${what} is drawn`).toBeAttached();
    const box = await card.boundingBox();
    expect(
      box !== null && isInside(box, canvas),
      `${what} is wholly inside the canvas`,
    ).toBe(true);
    expect(
      await drawnNameSize(card),
      `${what}'s name is drawn at a size to read`,
    ).toBeGreaterThanOrEqual(READABLE_PX);
  }
}

/**
 * What on the demo's canvas covers a card: every card it draws — with the
 * marks and handles it draws past its own edges, and the module's Direct Run
 * — against what is drawn over the canvas: its zoom controls, every chip it
 * shows, and the column headings. Empty when nothing covers a card.
 */
async function cardsCovered(page: Page): Promise<string[]> {
  return blastDemo(page).evaluate((demo) => {
    type Edges = { left: number; top: number; right: number; bottom: number };
    const drawn = (card: Element): Edges => {
      const boxes = [card, ...card.querySelectorAll('*')]
        .map((part) => part.getBoundingClientRect())
        .filter((box) => box.width > 1 && box.height > 1);
      return {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
      };
    };
    const covering = (overlay: Element): string =>
      overlay.matches('[data-chip]')
        ? `The chip "${overlay.textContent?.trim().replace(/\s+/g, ' ')}" covers`
        : overlay.matches('.vue-flow__controls')
          ? 'The zoom controls cover'
          : 'The column headings cover';
    const overlays = [
      ...demo.querySelectorAll(
        '.vue-flow__controls, [data-chip], .module-bracket__headings',
      ),
    ].map((overlay) => ({
      covering: covering(overlay),
      box: overlay.getBoundingClientRect(),
    }));

    return [...demo.querySelectorAll('.vue-flow__node')].flatMap((card) => {
      const box = drawn(card);
      return overlays
        .filter(
          (overlay) =>
            box.left < overlay.box.right &&
            box.right > overlay.box.left &&
            box.top < overlay.box.bottom &&
            box.bottom > overlay.box.top,
        )
        .map(
          (overlay) =>
            `${overlay.covering} ${card.getAttribute('data-id') ?? 'a card'}`,
        );
    });
  });
}

/** Text anywhere on the page that offers Bright Line, or a control named for it. */
async function expectNoBrightLine(page: Page): Promise<void> {
  await expect(page.getByText(BRIGHT_LINE)).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: BRIGHT_LINE })).toHaveCount(
    0,
  );
  await expect(page.getByRole('switch', { name: BRIGHT_LINE })).toHaveCount(0);
}

test("the hero is the demo's whole graph, as it has always been: its modules drawn, and no bracket", async ({
  page,
  state,
  graph,
}) => {
  await page.goto(state.siteBaseUrl);
  await expectGraphLayoutsReady(page);

  const top = hero(page);
  await expect(top.locator('.graph-viewer')).toHaveCount(1);
  await expect(top.locator('.module-bracket')).toHaveCount(0);
  await expect(top.getByRole('region', { name: 'Blast effect' })).toHaveCount(
    0,
  );

  // The root, the demo's module, and the root's first imports.
  const modules = [
    graph.root,
    LANDING_MODULE,
    ...(dependencyLevels(graph, graph.root, 'left')[0] ?? []).slice(0, 3),
  ];
  for (const moduleName of new Set(modules)) {
    await expect(
      top.locator(
        `.vue-flow__node[data-id=${JSON.stringify(`module-${moduleName}`)}]`,
      ),
      `${moduleName} is drawn in the hero's graph`,
    ).toBeVisible();
  }
  await expectNoBrightLine(page);
});

test("the blast effect's section opens on its module: both sides as the graph has them, and how far a change reaches", async ({
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
  await expect(pageSection(page, BLAST_SECTION)).toContainText(
    'Blast effect: pick a module and see everything that depends on it — the modules a change would hit.',
  );
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

  test("the sections take turns: the blast effect's picture left of its words, in a column of its own, and the next one's on the right", async ({
    page,
    state,
  }) => {
    await openLanding(page, state);

    // After the hero, the sections in the page's order.
    const titles = (
      await page.getByRole('heading', { level: 2 }).allTextContents()
    ).map((title) => title.trim());
    expect(titles.slice(0, SECTIONS.length)).toEqual([...SECTIONS]);

    // Each picture beside its words, the first on the left, then turn about.
    for (const [index, title] of SECTIONS.entries()) {
      const { words, picture } = sectionParts(pageSection(page, title));
      const wordsBox = await words.boundingBox();
      const pictureBox = await picture.boundingBox();
      if (!wordsBox || !pictureBox) {
        throw new Error(`The section "${title}" has no words or picture.`);
      }
      if (index % 2 === 0) {
        expect(
          pictureBox.x + pictureBox.width,
          `"${title}": the picture is on the left of the words`,
        ).toBeLessThanOrEqual(wordsBox.x);
      } else {
        expect(
          wordsBox.x + wordsBox.width,
          `"${title}": the picture is on the right of the words`,
        ).toBeLessThanOrEqual(pictureBox.x);
      }
    }

    // The blast effect's panel keeps to its column: half its section or less.
    const container = await sectionContainer(
      pageSection(page, BLAST_SECTION),
    ).boundingBox();
    const panel = await blastDemo(page)
      .locator('.blast-demo__panel')
      .boundingBox();
    if (!container || !panel) {
      throw new Error('The blast effect has no section or panel.');
    }
    expect(panel.width).toBeLessThanOrEqual(container.width / 2);
  });

  test('the demo opens on its module in its column, the first level of each side beside it, and a step frames it the same way', async ({
    page,
    state,
    graph,
  }) => {
    await openLanding(page, state);
    await blastDemo(page).scrollIntoViewIfNeeded();
    await expectOpenOnModule(page, graph, LANDING_MODULE);

    await stepper(page, 'right', 'more').click();
    await expectDepth(page, 'right', DEFAULT_DEPTH + 1);
    await expectOpenOnModule(page, graph, LANDING_MODULE);
    await expect(page).toHaveURL(state.siteBaseUrl);
  });
});

/**
 * The screens the demo opens on: in a column beside its words on a desktop,
 * stacked above them on a tablet — by mouse, and by touch, where the zoom
 * controls stand in a row along the canvas foot — and on a phone.
 */
const OPENING_SCREENS: ReadonlyArray<{
  width: number;
  height: number;
  hasTouch?: boolean;
}> = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 820, height: 1180 },
  { width: 768, height: 1024 },
  { width: 768, height: 1024, hasTouch: true },
  { width: 390, height: 844, hasTouch: true },
];

for (const { width, height, hasTouch = false } of OPENING_SCREENS) {
  test.describe(`on a ${width}×${height} screen${hasTouch ? ', by touch' : ''}`, () => {
    test.use({ viewport: { width, height }, hasTouch });

    test('the demo opens on its module and every module of both first levels, readable, and nothing drawn over the canvas covers a card', async ({
      page,
      state,
      graph,
    }) => {
      await openLanding(page, state);
      await blastDemo(page).scrollIntoViewIfNeeded();
      await expectOpenOnModule(page, graph, LANDING_MODULE);
      expect(
        await cardsCovered(page),
        'The zoom controls, the chips and the column headings stand clear of every card',
      ).toEqual([]);
    });
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the blast effect fits the phone: its picture before its words, inside the gutter, the module and both first levels, its controls in reach', async ({
    page,
    state,
    graph,
  }) => {
    await openLanding(page, state);

    const scroll = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      window: window.innerWidth,
    }));
    expect(scroll.width, 'The page scrolls sideways').toBe(scroll.window);

    // Stacked as its neighbours stack: the picture, then its words.
    const section = pageSection(page, BLAST_SECTION);
    const { words } = sectionParts(section);
    const panelBox = await blastDemo(page)
      .locator('.blast-demo__panel')
      .boundingBox();
    const wordsBox = await words.boundingBox();
    const gutter = await sectionContainer(section).evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).paddingLeft),
    );
    if (!panelBox || !wordsBox) {
      throw new Error('The blast effect has no panel or words.');
    }
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(wordsBox.y);
    expect(panelBox.x, 'The panel keeps to the gutter').toBeGreaterThanOrEqual(
      gutter - 1,
    );
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(
      scroll.window - gutter + 1,
    );

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
