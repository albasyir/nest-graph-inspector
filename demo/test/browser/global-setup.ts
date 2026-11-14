import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import {
  buildDemo,
  DEMO_DIR,
  exportGraph,
  startDemo,
} from '../support/demo-process';
import { BROWSER_STATE_ENV, type BrowserState } from './browser-state';
import { serveStaticSite } from './static-site';

/** Where `nuxt generate` writes the site. */
const SITE_BUILD_DIR = resolve(DEMO_DIR, '../site/.output/public');

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : inspect(error);
}

/**
 * Starts what the viewer tests run against, once for the whole run: the site
 * build, served the way GitHub Pages serves it; the demo, built and started as
 * a process of its own; and a graph file exported from the same build.
 *
 * Returns the teardown, which Playwright runs whether the tests passed or
 * not, and which runs here too when the setup itself fails half way.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const cleanups: Array<() => Promise<void>> = [];

  const teardown = async (): Promise<void> => {
    const failures: string[] = [];

    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(messageOf(error));
      }
    }

    if (failures.length > 0) {
      throw new Error(`Teardown failed:\n${failures.join('\n')}`);
    }
  };

  try {
    const site = await serveStaticSite({ rootDir: SITE_BUILD_DIR });
    cleanups.push(() => site.close());

    buildDemo();

    const graphFileDir = await mkdtemp(join(os.tmpdir(), 'ngi-graph-file-'));
    // Removed by the teardown, and — should the runner end without running
    // it — as this process exits, best effort, as the demo's directory is.
    const removeGraphFileDir = () =>
      rmSync(graphFileDir, { recursive: true, force: true, maxRetries: 3 });
    process.once('exit', removeGraphFileDir);
    cleanups.push(async () => {
      process.removeListener('exit', removeGraphFileDir);
      await rm(graphFileDir, { recursive: true, force: true });
    });

    // The file `npx nest-graph-inspector export` writes, by its default name.
    const graphFile = join(graphFileDir, 'nest-graph.json');
    const exported = await exportGraph(['--out', graphFile]);

    if (exported.status !== 0) {
      throw new Error(
        `nest-graph-inspector export failed (exit code ${String(exported.status)}):\n${exported.stderr}`,
      );
    }

    const demo = await startDemo();
    cleanups.push(() => demo.stop());

    // The link exactly as printed, with the hosted viewer it names swapped
    // for the build under test.
    const viewerLink = `${site.baseUrl.href.replace(/\/$/, '')}${demo.link.href.slice(demo.link.viewerBase.length)}`;
    const state: BrowserState = {
      siteBaseUrl: site.baseUrl.href,
      viewerLink,
      endpoint: demo.link.endpoint.href,
      token: demo.link.token,
      graphFile,
    };

    process.env[BROWSER_STATE_ENV] = JSON.stringify(state);
  } catch (error) {
    // The setup's own failure is the one to report; a teardown that fails as
    // well is added to it rather than put in its place.
    const teardownError = await teardown().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    if (teardownError !== undefined) {
      throw new Error(`${messageOf(error)}\n\n${messageOf(teardownError)}`, {
        cause: error,
      });
    }

    throw error;
  }

  return teardown;
}
