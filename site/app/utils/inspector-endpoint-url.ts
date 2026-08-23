/**
 * The URLs the viewer derives from one graph endpoint.
 *
 * Everything the viewer fetches hangs off the endpoint the printed link handed
 * over: the graph itself, its Markdown, the Ollama proxy, Direct Run. None of
 * these carry an access token — that travels as a request header — so every
 * function here builds a plain URL and nothing more.
 */
import { resolveInspectorMountBase } from './nodepod-demo-endpoint.ts'

function withDefaultProtocol(input: string): string {
  return input.startsWith('http://') || input.startsWith('https://')
    ? input
    : `http://${input}`
}

/**
 * Turns something a developer typed into a graph endpoint URL.
 *
 * A bare host is the common case (`localhost:53371`), and a host with no path
 * means the default mount, so both are filled in rather than rejected.
 */
export function normalizeSourceUrl(input: string): string {
  const url = new URL(withDefaultProtocol(input.trim()))

  if (url.pathname === '/' || !url.pathname) {
    url.pathname = '/__graph-inspector'
  }

  return url.toString()
}

/**
 * A file served beneath the graph endpoint — `output.json` and friends.
 *
 * Returns an empty string for anything unparseable, because the callers use
 * that to mean "nothing to fetch yet".
 */
export function appendOutputPath(value: string, fileName: string): string {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)
    const path = url.pathname.replace(/\/+$/, '')

    url.pathname = `${path}/${fileName}`
    return url.toString()
  } catch {
    return ''
  }
}

/**
 * A path at the root of the inspected application's own server, rather than
 * beneath the graph endpoint's path.
 *
 * That root is the origin for an application reached over the network, and a
 * path prefix for the in-browser demo, whose servers are addressed under a
 * segment of this site's own origin.
 *
 * The query and fragment are dropped: what belongs to the graph endpoint does
 * not belong to a sibling service like the Ollama proxy — and leaving a query
 * in place is what used to break callers that append a path onto the result.
 */
export function resolveOriginPath(value: string, pathName: string): string {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)
    url.pathname = `${resolveInspectorMountBase(value)}/${pathName.replace(/^\/+/, '')}`
    url.search = ''
    url.hash = ''

    return url.toString()
  } catch {
    return ''
  }
}

/**
 * Where Direct Run lives for a given graph endpoint.
 *
 * A live application serves it at the root of its own server. A static graph is
 * a directory of files, so its Direct Run history sits beside them.
 */
export function resolveDirectRunUrl(value: string, isStatic: boolean): string {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)

    url.pathname = isStatic
      ? `${url.pathname.replace(/\/$/, '')}/direct-run`
      : `${resolveInspectorMountBase(value)}/direct-run`
    url.search = ''
    url.hash = ''

    return url.toString()
  } catch {
    return ''
  }
}
