import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';

/** The viewer's own routes, and every other unknown path, fall back to it. */
const FALLBACK_PAGE = '404.html';

/** How Nuxt writes the base URL a build was made for into its pages. */
const NUXT_BASE_URL = /baseURL:"([^"]+)"/;

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

export type StaticSite = {
  /** The site's base URL, with a trailing slash. */
  readonly baseUrl: URL;
  close(): Promise<void>;
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The base URL the static build in `rootDir` was generated for. */
async function readBaseUrl(rootDir: string): Promise<string> {
  const fallback = join(rootDir, FALLBACK_PAGE);
  let page: string;

  try {
    page = await readFile(fallback, 'utf8');
  } catch {
    throw new Error(
      `No static site build at ${rootDir} (no ${FALLBACK_PAGE}). Generate it the way CI does: NITRO_PRESET=github_pages NUXT_APP_BASE_URL=/nest-graph-inspector/ pnpm --filter nest-graph-inspector-site exec nuxt generate`,
    );
  }

  const baseUrl = NUXT_BASE_URL.exec(page)?.[1];

  if (!baseUrl?.startsWith('/') || !baseUrl.endsWith('/')) {
    throw new Error(
      `Cannot tell which base URL ${fallback} was generated for.`,
    );
  }

  return baseUrl;
}

/**
 * Serves a static build of the site on a free loopback port, the way GitHub
 * Pages serves the deployed one, under the base URL the build was made for:
 * a file as it is, a directory by its `index.html`, a page `/a/b` by
 * `/a/b.html`, and anything else by `404.html` with status 404 — the fallback
 * through which Pages, too, serves the viewer's client-rendered routes.
 */
export async function serveStaticSite({
  rootDir,
}: {
  rootDir: string;
}): Promise<StaticSite> {
  const root = resolve(rootDir);
  const basePath = await readBaseUrl(root);

  const resolveFile = async (pathname: string): Promise<string | undefined> => {
    let relativePath: string;

    try {
      relativePath = decodeURIComponent(pathname.slice(basePath.length));
    } catch {
      return undefined;
    }

    const candidate = resolve(root, `.${sep}${relativePath}`);

    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      return undefined;
    }

    // A path with an extension names a file, and a missing one is missing:
    // only an extensionless page path is tried with `.html` after it.
    const paths = extname(candidate)
      ? [candidate]
      : [candidate, join(candidate, 'index.html'), `${candidate}.html`];

    for (const path of paths) {
      if (await isFile(path)) {
        return path;
      }
    }

    return undefined;
  };

  const respond = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }

    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    const insideBase = `${pathname}/`.startsWith(basePath);
    const file = insideBase ? await resolveFile(pathname) : undefined;
    const path = file ?? join(root, FALLBACK_PAGE);

    response.writeHead(file ? 200 : 404, {
      'content-type':
        CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    // Either side failing — the file, or a browser that hung up — closes
    // both, so an abandoned request leaves no file open.
    pipeline(createReadStream(path), response, () => undefined);
  };

  const server = http.createServer((request, response) => {
    respond(request, response).catch(() => {
      response.destroy();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The static site server has no TCP address.');
  }

  return {
    baseUrl: new URL(basePath, `http://127.0.0.1:${address.port}`),
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}
