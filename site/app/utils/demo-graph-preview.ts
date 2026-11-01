import type { GraphFileSource } from './graph-file-session.ts'

/**
 * The demo application's graph as a file: what `/view?preview=true` opens
 * when no demo is running in the tab.
 *
 * The demo's `build:nodepod` script ends by running `nest-graph-inspector
 * export` against the demo's build, writing `graph.json` beside the nodepod
 * payload — a static graph, byte for byte what the running demo would serve.
 */

/** Where the static graph is published, relative to the site's base URL. */
export const EXAMPLE_GRAPH_FILE = 'nodepod-demo/graph.json'

/** The static graph, opened in the viewer as a file source. */
export const EXAMPLE_GRAPH_SOURCE: GraphFileSource = {
  name: 'graph.json',
  kind: 'example'
}

/** The static graph's absolute URL, under the base path the site is served from. */
export function resolveExampleGraphUrl(baseURL: string, origin: string): string {
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`

  return new URL(EXAMPLE_GRAPH_FILE, new URL(base, origin)).toString()
}

export type ExampleGraphStatus = 'idle' | 'loading' | 'ready' | 'error'
