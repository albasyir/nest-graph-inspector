export type LoadSource = 'initial_mount' | 'route_change' | 'manual_refresh'

function parseGraphUrl(graphUrl: string) {
  if (!graphUrl) {
    return {
      graph_url: '',
      graph_url_host: '',
      graph_url_path: ''
    }
  }

  try {
    const url = new URL(graphUrl)

    return {
      graph_url: graphUrl,
      graph_url_host: url.host,
      graph_url_path: url.pathname
    }
  } catch {
    return {
      graph_url: graphUrl,
      graph_url_host: '',
      graph_url_path: ''
    }
  }
}

export function createGraphViewerEventProperties(options: {
  graphUrl: string
  viewerRoute: string
  loadSource: LoadSource
  isRetry?: boolean
  errorMessage?: string
}) {
  const properties = {
    ...parseGraphUrl(options.graphUrl),
    viewer_route: options.viewerRoute,
    load_source: options.loadSource
  } as {
    graph_url: string
    graph_url_host: string
    graph_url_path: string
    viewer_route: string
    load_source: LoadSource
    is_retry?: boolean
    error_message?: string
  }

  if (typeof options.isRetry === 'boolean') {
    properties.is_retry = options.isRetry
  }

  if (options.errorMessage) {
    properties.error_message = options.errorMessage
  }

  return properties
}
