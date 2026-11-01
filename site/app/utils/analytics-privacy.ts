import { describeViewerRoute } from './graph-viewer-analytics.ts'

/**
 * Keeps the graph out of the events PostHog sends on its own.
 *
 * The site's own events already name a viewer route by its shape — see
 * `describeViewerRoute` — but PostHog stamps every event, its own pageviews,
 * clicks and exceptions included, with the address the tab is on, under more
 * names than one: `$current_url`, `$pathname`, the session's entry URL, the
 * person's initial URL, and the URL keys heatmaps are grouped by. A viewer
 * route can carry the graph there: a module's deep dive names the module in
 * its path, and the navigator's `focus-module` and `direct-run-on` name one in
 * the query.
 *
 * So every viewer route in an event, wherever it appears, is rewritten to the
 * shape the site's own events use, before the event leaves the tab. A viewer
 * page's title goes too: no viewer page puts the graph in its title, and
 * dropping it keeps one that ever does out of the event. What is on screen is
 * kept out separately: the viewer marks itself `ph-no-capture`, which PostHog's
 * click capture and session replay both honour, and replays mask `<title>`.
 */

/** A viewer route inside a URL or a path: `/view`, the rest of its path, its query and fragment. */
const VIEWER_ROUTE = /\/view(?=[/?#]|$)[^\s"'<>]*/g

/** A string with every viewer route in it reduced to its shape. */
export function redactViewerRoutes(text: string): string {
  return text.replace(VIEWER_ROUTE, route => describeViewerRoute(route))
}

/**
 * An analytics event with every viewer route in it — in property values and
 * keys, at any depth — reduced to its shape, and with no page title when it
 * was captured on a viewer page. Anything that is not text, an array or a
 * plain object, like the event's timestamp, is passed through as it is.
 *
 * Shaped to be PostHog's `before_send`, which hands over the event or `null`.
 */
export function redactAnalyticsEvent<T>(event: T): T {
  const redacted = redactValue(event) as T

  if (isPlainObject(redacted) && isPlainObject(redacted.properties)) {
    const { properties } = redacted
    const currentUrl = properties.$current_url

    if (typeof currentUrl === 'string' && hasViewerRoute(currentUrl)) {
      delete properties.title
    }
  }

  return redacted
}

function hasViewerRoute(text: string): boolean {
  VIEWER_ROUTE.lastIndex = 0
  const found = VIEWER_ROUTE.test(text)
  VIEWER_ROUTE.lastIndex = 0

  return found
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactViewerRoutes(value)
  }

  if (Array.isArray(value)) {
    return value.map(redactValue)
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactViewerRoutes(key), redactValue(entry)])
    )
  }

  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const prototype: unknown = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}
