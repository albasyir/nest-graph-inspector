import { ACCESS_TOKEN_QUERY_PARAM } from 'nest-graph-inspector';

/**
 * Nest colours its log whether or not standard output is a terminal, and the
 * escape sequences sit inside the lines the parsers below read. Every one of
 * them starts with ESC (0x1b), so a control character is the pattern.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SGR_SEQUENCE = /\u001b\[[0-9;]*m/g;

/**
 * A viewer link: the hosted viewer's base URL, then `/view/` and the graph
 * endpoint in base64url — the shape `site/app/utils/nodepod-demo-endpoint.ts`
 * reads, matched on the link rather than the sentence around it.
 */
const VIEWER_LINK = /(https?:\/\/\S+?)\/view\/([A-Za-z0-9_-]{16,})/g;

/** An endpoint a plain `http` output announces as installed. */
const HTTP_OUTPUT_INFORMATION_URL = /(https?:\/\/[^\s,]+?)\/information\.json/g;

const ACCESS_TOKEN = /ngi1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const TOKEN_QUERY_VALUE = new RegExp(
  `(${ACCESS_TOKEN_QUERY_PARAM}=)[^&\\s]+`,
  'g',
);

/** The viewer link the inspector printed, read the way a developer reads it. */
export type PrintedViewerLink = {
  /** The link as printed. */
  readonly href: string;
  /** Where the link sends the browser: everything before `/view/`. */
  readonly viewerBase: string;
  /** The segment after `/view/`: the graph endpoint, base64url-encoded. */
  readonly encodedEndpoint: string;
  /** The graph endpoint the link carries, without its access token. */
  readonly endpoint: URL;
  /** The access token the link carries. */
  readonly token: string;
};

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_SEQUENCE, '');
}

/**
 * The lines of `log` already ended, without colour: what a reader can trust
 * to be whole while output is still arriving, a chunk at a time.
 */
function completeLines(log: string): string {
  return stripAnsi(log.slice(0, log.lastIndexOf('\n') + 1));
}

/**
 * The last viewer link printed in `log` on a line already ended, or
 * `undefined` while there is none.
 * Throws for a link that is there but does not carry an access token: that is
 * a demo the suites cannot reach, not one still starting.
 */
export function readPrintedViewerLink(
  log: string,
): PrintedViewerLink | undefined {
  const match = [...completeLines(log).matchAll(VIEWER_LINK)].at(-1);

  if (!match) {
    return undefined;
  }

  const [href, viewerBase, encodedEndpoint] = match;
  const endpoint = new URL(
    Buffer.from(encodedEndpoint, 'base64url').toString('utf8'),
  );
  const token = endpoint.searchParams.get(ACCESS_TOKEN_QUERY_PARAM);

  if (!token) {
    throw new Error(
      `The printed viewer link carries no ${ACCESS_TOKEN_QUERY_PARAM}: the demo's inspector must print its access token for these suites to reach it.`,
    );
  }

  endpoint.searchParams.delete(ACCESS_TOKEN_QUERY_PARAM);

  return { href, viewerBase, encodedEndpoint, endpoint, token };
}

/**
 * The graph endpoints every plain `http` output announced in `log`: what
 * comes before the `/information.json` it lists first.
 */
export function readHttpOutputEndpoints(log: string): URL[] {
  const endpoints = new Set(
    [...completeLines(log).matchAll(HTTP_OUTPUT_INFORMATION_URL)].map(
      ([, endpoint]) => endpoint,
    ),
  );

  return [...endpoints].map((endpoint) => new URL(endpoint));
}

/**
 * `text` with every credential the inspector prints taken out: the viewer
 * link, which carries the token encoded; the token the `http` output prints
 * bare; and the token as a query parameter. CI logs are public, and the log
 * is printed when the demo fails to start.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/\/view\/[A-Za-z0-9_-]{16,}/g, '/view/<redacted>')
    .replace(ACCESS_TOKEN, 'ngi1.<redacted>')
    .replace(TOKEN_QUERY_VALUE, '$1<redacted>');
}
