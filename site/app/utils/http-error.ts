/**
 * What the viewer may say about a failed request: its HTTP status, and nothing
 * the request itself said.
 *
 * A transport message quotes the URL the request was made to, and a response
 * body says whatever the endpoint chose to — either can carry user info, a
 * fragment or a credential. So a failure is told in fixed words, and its status
 * is the only part of it that is ever shown or reported.
 */

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
}

interface FailedRequest {
  response?: { status?: unknown }
  cause?: FailedRequest
}

/**
 * HTTP status a request failed with, or `0` when it never got a real one.
 *
 * It is read off the response, because nothing else can say what the endpoint
 * answered: `$fetch` throws an error carrying the response, and `useFetch` and
 * `useAsyncData` hold that error as the cause of one h3's `createError` wraps it
 * in — a wrapper that starts at 500 and stays there when the original carried
 * no status, so a request that never got a response would read as a server
 * error.
 */
export function readStatusCode(error: unknown): number {
  const failure = error as FailedRequest | null | undefined
  const status = (failure?.response ?? failure?.cause?.response)?.status

  return isHttpStatus(status) ? status : 0
}

/**
 * A failed request in words the viewer may show: a fixed sentence, with the
 * status it was answered with when it got one.
 */
export function describeFailedRequest(sentence: string, status: number): string {
  return isHttpStatus(status) ? `${sentence} (HTTP ${status}).` : `${sentence}.`
}

/**
 * What the error state says about a graph that would not load: that it needs
 * the token only the printed link hands over, or that the load failed — with
 * the status, when there was one.
 */
export function describeLoadFailure(status: number, requiresAccessToken = false) {
  if (requiresAccessToken) {
    return {
      title: 'Access token required',
      description: 'This inspector is gated behind a short-lived access token. Open the Graph Viewer link printed in your application console to load it again.'
    }
  }

  return {
    title: 'Failed to fetch graph data',
    description: isHttpStatus(status)
      ? `The endpoint answered with HTTP ${status}.`
      : 'Could not connect to the provided URL. Make sure your NestJS app is running and the endpoint is accessible.'
  }
}
