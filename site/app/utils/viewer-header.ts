import { isSupportedGraphOutputVersion } from './graph-output-support.ts'
import { resolveViewerPage, type ViewerPage } from './viewer-bootstrap-link.ts'

/**
 * What the viewer header says: which of the viewer's pages a route is on, what
 * state the graph it shows is in, and whether the AI chat may open.
 *
 * The header is laid out in `layouts/viewer.vue`; the decisions live here so
 * they run under the site's plain `node --test` runner.
 */

/**
 * The viewer page a route belongs to — the tab the header marks current — or
 * `undefined` for a route that is none of them: `/view` itself, or a printed
 * link the middleware has yet to spend.
 *
 * Read from the path alone, so browser back and forward move the current tab
 * along with the route. Only the navigator has pages beneath it — a module's
 * deep dive at `/view/navigator/modules/<id>` — and a page under a former name,
 * like `/view/execution-sequence`, is the page it became.
 */
export function resolveViewerHeaderPage(path: string): ViewerPage | undefined {
  const [root, segment, ...rest] = path.split('/').filter(Boolean)

  if (root !== 'view' || !segment) {
    return undefined
  }

  const page = resolveViewerPage(segment)

  if (!page || (rest.length > 0 && page !== 'navigator')) {
    return undefined
  }

  return page
}

/** What the header can say about the graph a tab is on. */
export type ViewerGraphState
  = | 'none'
    | 'starting-demo'
    | 'loading'
    | 'token-required'
    | 'unreachable'
    | 'failed'
    | 'unsupported'
    | 'ready'
    | 'not-loaded'

export type ViewerGraphStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

/** The parts of the graph store, and the demo's, the status is read from. */
export type ViewerGraphStatusInput = {
  /** The endpoint the tab is on, empty when it is on none. Only its host is ever shown. */
  endpointUrl: string
  /** The endpoint is this site's own demo, running in this tab. */
  isDemo: boolean
  /** The demo is starting, which is when a tab that had one has no endpoint. */
  isDemoStarting: boolean
  isLoading: boolean
  hasGraph: boolean
  /**
   * The graph's own `version`. The store keeps a graph in a version this viewer
   * cannot read, and opens the "update your package" modal over it.
   */
  graphVersion: unknown
  /** The graph was read from files rather than served by a running process. */
  isStatic: boolean
  requiresAccessToken: boolean
  isUnreachable: boolean
  hasLoadError: boolean
}

export type ViewerGraphStatus = {
  state: ViewerGraphState
  tone: ViewerGraphStatusTone
  icon: string
  /** Whether something is under way, so the icon turns. */
  busy: boolean
  /** Which graph this is, in one short line: the endpoint's host, or the demo. */
  title: string
  /**
   * The endpoint's host, for the details the header opens, where a long one is
   * not cut short. Absent for the demo, and for an address with no host to read.
   */
  host?: string
  /** The state in a few words, for the line under the title. */
  label: string
  /** The state in a sentence, for the details the header opens. */
  description: string
}

const DEMO_TITLE = 'In-browser demo'

/** What the header calls an endpoint it can read no host from. */
const UNNAMED_ENDPOINT_TITLE = 'Graph endpoint'

/**
 * The host and port of an endpoint: what tells one application from another,
 * and the only part of its address the viewer shows — in the header, and in
 * the loading state.
 *
 * The rest can carry a credential — user info, or an access token left in the
 * query however its name is spelled — and the host of an http(s) URL is the one
 * part the parser guarantees holds neither. Anything else, a URL that does not
 * parse included, could be a secret as easily as an address, so it gets no host
 * at all rather than being shown as it is.
 */
export function resolveEndpointHost(endpointUrl: string): string | undefined {
  try {
    const { protocol, host } = new URL(endpointUrl)

    return (protocol === 'http:' || protocol === 'https:') && host ? host : undefined
  } catch {
    return undefined
  }
}

/**
 * What the header says about the graph a tab is on.
 *
 * Checked in the order the viewer's pages check it: a load under way first —
 * a reload keeps the last attempt's error until it has an answer of its own —
 * then why a load failed, and a graph only once nothing is wrong. A graph is
 * kept through a failed reload, and the page shows the failure, so the header
 * does too. A graph in a version this viewer cannot read is kept as well, under
 * the update modal, so the header asks for the update rather than calling it
 * loaded.
 */
export function describeViewerGraphStatus(input: ViewerGraphStatusInput): ViewerGraphStatus {
  if (!input.endpointUrl) {
    // The demo drops its endpoint while it starts again, because the one the
    // tab had died with the document that started it.
    return input.isDemoStarting
      ? {
          state: 'starting-demo',
          tone: 'info',
          icon: 'i-lucide-loader-circle',
          busy: true,
          title: DEMO_TITLE,
          label: 'Starting…',
          description: 'The demo application is starting in this browser.'
        }
      : {
          state: 'none',
          tone: 'neutral',
          icon: 'i-lucide-circle-dashed',
          busy: false,
          title: 'No graph selected',
          label: 'No endpoint',
          description: 'Open the Graph Viewer link your application prints in its console to choose a graph.'
        }
  }

  // The demo's address means nothing outside the tab that started it.
  const host = input.isDemo ? undefined : resolveEndpointHost(input.endpointUrl)
  const title = input.isDemo ? DEMO_TITLE : host ?? UNNAMED_ENDPOINT_TITLE
  const status = { title, host, busy: false }

  if (input.isLoading) {
    return {
      ...status,
      state: 'loading',
      tone: 'info',
      icon: 'i-lucide-loader-circle',
      busy: true,
      label: 'Loading graph…',
      description: input.isDemo
        ? 'Fetching the graph from the demo application running in this browser.'
        : `Fetching the graph from ${host ?? 'its endpoint'}.`
    }
  }

  if (input.requiresAccessToken) {
    return {
      ...status,
      state: 'token-required',
      tone: 'warning',
      icon: 'i-lucide-key-round',
      label: 'Access token required',
      description: 'This inspector is gated behind a short-lived access token. Open the Graph Viewer link printed in your application console to load it again.'
    }
  }

  if (input.isUnreachable) {
    return {
      ...status,
      state: 'unreachable',
      tone: 'error',
      icon: 'i-lucide-unplug',
      label: 'Not reachable',
      description: 'Nothing answered at this address. Make sure your NestJS app is running and the endpoint is accessible.'
    }
  }

  if (input.hasLoadError) {
    return {
      ...status,
      state: 'failed',
      tone: 'error',
      icon: 'i-lucide-triangle-alert',
      label: 'Failed to load',
      description: 'The endpoint answered, but the graph could not be loaded from it.'
    }
  }

  if (input.hasGraph && !isSupportedGraphOutputVersion(input.graphVersion)) {
    return {
      ...status,
      state: 'unsupported',
      tone: 'warning',
      icon: 'i-lucide-circle-arrow-up',
      label: 'Update required',
      description: 'Your app serves an older graph output format than this viewer reads. Update nest-graph-inspector and restart your app.'
    }
  }

  if (input.hasGraph) {
    return {
      ...status,
      state: 'ready',
      tone: 'success',
      icon: 'i-lucide-circle-check',
      label: input.isStatic ? 'Static snapshot' : 'Graph loaded',
      description: input.isDemo
        ? 'Running in this browser tab, so it has no address worth showing anywhere else.'
        : input.isStatic
          ? 'Read from files rather than a running application, so nothing can be run against it.'
          : 'Loaded from the application at this address. Reload to fetch it again.'
    }
  }

  return {
    ...status,
    state: 'not-loaded',
    tone: 'neutral',
    icon: 'i-lucide-circle-dashed',
    label: 'Not loaded',
    description: 'The graph has not been loaded yet.'
  }
}

/** Whether the AI Chat button may open the chat, and if not, why not. */
export type AiChatAvailability = 'available' | 'no-graph' | 'restricted'

/**
 * Whether the header's AI Chat button may open the chat.
 *
 * A restricted device — a phone, a tablet, or a window narrower than the
 * chat's breakpoint, as `isMobileDevice` decides — is refused whatever graph
 * it has loaded: the model would run on that device's GPU. Only `available`
 * ever opens the chat.
 */
export function resolveAiChatAvailability({
  hasGraphEndpoint,
  isRestricted
}: {
  hasGraphEndpoint: boolean
  isRestricted: boolean
}): AiChatAvailability {
  if (isRestricted) {
    return 'restricted'
  }

  return hasGraphEndpoint ? 'available' : 'no-graph'
}
