import type { Locator, Page } from '@playwright/test';
import type { GraphOutput } from 'nest-graph-inspector';
import { type DependencySide, dependencyLevels } from '../support/graph-facts';
import type { BrowserState } from './browser-state';
import { expect, graphNode } from './viewer.fixtures';

/**
 * A module's dependency bracket, as a module's page and the landing page's
 * demo both draw it: what the module needs on the left, what needs it on the
 * right, each side's depth stepped on its own. Nothing here names a module of
 * the demo: every module, level and count is read from the graph it serves.
 */

/**
 * How many levels each side shows when nothing else asks: a fact of the site
 * (`DEFAULT_BRACKET_DEPTH` in `site/app/utils/module-dependency-bracket.ts`),
 * not of the demo.
 */
export const DEFAULT_DEPTH = 3;

const SIDE_LABELS: Record<DependencySide, string> = {
  left: 'Needs',
  right: 'Needed by',
};

/** A module's page in the viewer, with `query` after it. */
export function modulePageUrl(
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

/** The card in the middle of the bracket. */
export function center(page: Page): Locator {
  return page.locator('.vue-flow__node[data-bracket-node="center"]');
}

/**
 * The bracket once Vue Flow has taken the frame it opens at, since it was
 * last laid out: its root says so in `data-framed`, a signal, never a timer.
 */
function framedBracket(page: Page): Locator {
  return page.locator('.module-bracket[data-framed="true"]');
}

/**
 * The cards the canvas draws once the bracket is framed, by node id, sorted.
 * Vue Flow draws only the cards in view, so these are what the frame shows.
 */
export async function drawnCardIds(page: Page): Promise<string[]> {
  await expect(framedBracket(page)).toBeVisible();
  const ids = await page
    .locator('.module-bracket .vue-flow__node[data-id]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-id') ?? ''),
    );

  return ids.sort();
}

/**
 * The cards the frame draws well inside the canvas, by node id, sorted:
 * wholly inside it, below its pinned headings, and at least their own height
 * clear of its top and bottom. A card at an edge is drawn or not by a pixel
 * either way as the canvas settles on its size; one well inside is drawn
 * however the frame settles.
 */
export async function cardsWellInside(page: Page): Promise<string[]> {
  await expect(framedBracket(page)).toBeVisible();
  const ids = await page.evaluate(() => {
    const canvas = document
      .querySelector('.module-bracket__canvas')
      ?.getBoundingClientRect();
    const headings = document
      .querySelector('.module-bracket__headings')
      ?.getBoundingClientRect();
    if (!canvas) {
      return [];
    }
    const top = headings ? headings.bottom : canvas.top;

    return [
      ...document.querySelectorAll('.module-bracket .vue-flow__node[data-id]'),
    ]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return (
          box.left >= canvas.left &&
          box.right <= canvas.right &&
          box.top >= top + box.height &&
          box.bottom <= canvas.bottom - box.height
        );
      })
      .map((node) => node.getAttribute('data-id') ?? '');
  });

  return ids.sort();
}

/** A side's depth: its label, its two steppers, and the depth between them. */
export function depthGroup(page: Page, side: DependencySide): Locator {
  return page.getByRole('group', { name: SIDE_LABELS[side], exact: true });
}

export async function expectDepth(
  page: Page,
  side: DependencySide,
  depth: number,
): Promise<void> {
  await expect(depthGroup(page, side).locator('output')).toHaveText(
    new RegExp(`^${depth} levels?$`),
  );
}

/** A module card the bracket draws, by side and name. */
export function bracketModule(
  page: Page,
  side: DependencySide,
  moduleName: string,
): Locator {
  return graphNode(page, `${side}:${encodeURIComponent(moduleName)}`);
}

/**
 * Frames the whole bracket, however small that draws it. The bracket opens
 * on its module at a size to read, and the canvas draws only the cards in
 * view, so what a side holds is counted from this overview.
 */
export async function showWholeBracket(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Show the whole bracket', exact: true })
    .click();
}

/**
 * The modules drawn on a side, level by level, each level's names sorted.
 * It frames the whole bracket first, as a reader's own zoom would, so from
 * then on a resize leaves the canvas where it is: a check of the frame the
 * bracket opens at goes before it, or after a change that frames it afresh.
 */
export async function drawnLevels(
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
export async function expectLevels({
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

/** The "+N modules" counts on a side's stubs, sorted. It frames the whole bracket first, as `drawnLevels` does. */
export async function drawnStubCounts(
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
