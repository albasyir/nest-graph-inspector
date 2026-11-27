/**
 * A box on the page, as Playwright's `boundingBox` gives one: CSS pixels from
 * the top left of the viewport.
 */
export type Box = { x: number; y: number; width: number; height: number };

/**
 * Whether `box` lies wholly inside `area`, on both axes, to a pixel either
 * way — the rounding of boxes measured from the page.
 */
export function isInside(box: Box, area: Box): boolean {
  return (
    box.x >= area.x - 1 &&
    box.y >= area.y - 1 &&
    box.x + box.width <= area.x + area.width + 1 &&
    box.y + box.height <= area.y + area.height + 1
  );
}
