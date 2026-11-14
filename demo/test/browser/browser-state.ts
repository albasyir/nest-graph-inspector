import { z } from 'zod';
import { parseJson } from '../support/inspector-api';

/**
 * What the global setup started, handed to the tests — which run in other
 * processes — through one environment variable.
 */
export const BROWSER_STATE_ENV = 'NGI_BROWSER_E2E_STATE';

export const browserStateSchema = z.object({
  /** The static site build, served the way GitHub Pages serves it. */
  siteBaseUrl: z.url(),
  /** The viewer link the demo printed, moved onto the local site. */
  viewerLink: z.url(),
  /** The demo's graph endpoint, without its access token. */
  endpoint: z.url(),
  /** The access token the printed link carried. */
  token: z.string().min(1),
  /** The demo's graph, exported to a file by `nest-graph-inspector export`. */
  graphFile: z.string().min(1),
});

export type BrowserState = z.infer<typeof browserStateSchema>;

export function readBrowserState(): BrowserState {
  const state = process.env[BROWSER_STATE_ENV];

  if (!state) {
    throw new Error(
      `${BROWSER_STATE_ENV} is not set: run these tests through test/browser/playwright.config.ts, whose global setup starts the demo and the site.`,
    );
  }

  return parseJson(state, browserStateSchema);
}
