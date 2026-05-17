import http from 'node:http';
import { URL } from 'node:url';
import { Injectable, OnModuleDestroy } from '@nestjs/common';

export type HttpServeOptions = {
  origin?: string;
  host?: string;
  port?: number;
};

export type HttpServeRoute = {
  type: string;
  path: string;
  callback?: (context: HttpServeRequest) => unknown | Promise<unknown>;
  rawCallback?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void | Promise<void>;
  requestHeaders?: http.OutgoingHttpHeaders;
  responseHeaders?: http.OutgoingHttpHeaders;
  contentType?: string;
  statusCode?: number;
};

export type HttpServeRequest = {
  request: http.IncomingMessage;
  headers: http.IncomingHttpHeaders;
};

export type HttpServeResponse = {
  statusCode?: number;
  contentType?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: unknown;
};

type HttpServerState = {
  server?: http.Server;
  originUrl: URL;
  routes: Map<string, HttpServeRoute[]>;
  listenPromise?: Promise<void>;
};

@Injectable()
export class HttpServeAdapter implements OnModuleDestroy {
  private readonly servers = new Map<string, HttpServerState>();

  register(
    options: HttpServeOptions,
    routes: HttpServeRoute[],
  ): { origin: string } {
    const originUrl = this.normalizeOrigin(options);
    const state = this.serverState(originUrl);

    for (const route of routes) {
      const key = this.routeKey(route.type, this.normalizePath(route.path));
      const routeGroup = state.routes.get(key) ?? [];
      routeGroup.push(route);
      state.routes.set(key, routeGroup);
    }

    return { origin: state.originUrl.origin };
  }

  get(
    path: string,
    callback: HttpServeRoute['callback'],
    options: Omit<HttpServeRoute, 'type' | 'path' | 'callback'> = {},
  ): HttpServeRoute {
    return { type: 'GET', path, callback, ...options };
  }

  post(
    path: string,
    callback: HttpServeRoute['callback'],
    options: Omit<HttpServeRoute, 'type' | 'path' | 'callback'> = {},
  ): HttpServeRoute {
    return { type: 'POST', path, callback, ...options };
  }

  all(
    path: string,
    rawCallback: NonNullable<HttpServeRoute['rawCallback']>,
    options: Omit<HttpServeRoute, 'type' | 'path' | 'rawCallback'> = {},
  ): HttpServeRoute {
    return { type: '*', path, rawCallback, ...options };
  }

  async serve(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map((state) => this.serveState(state)),
    );
  }

  close(origin?: string): void {
    if (!origin) {
      for (const state of this.servers.values()) {
        state.server?.close();
      }
      this.servers.clear();
      return;
    }

    const originUrl = this.normalizeOrigin({ origin });
    const state = this.servers.get(originUrl.origin);
    state?.server?.close();
    this.servers.delete(originUrl.origin);
  }

  onModuleDestroy(): void {
    this.close();
  }

  private serverState(originUrl: URL): HttpServerState {
    const existing = this.servers.get(originUrl.origin);
    if (existing) {
      return existing;
    }

    const state: HttpServerState = {
      originUrl,
      routes: new Map<string, HttpServeRoute[]>(),
    };

    this.servers.set(originUrl.origin, state);

    return state;
  }

  private serveState(state: HttpServerState): Promise<void> {
    if (state.listenPromise) {
      return state.listenPromise;
    }

    state.server = http.createServer((req, res) => {
      void this.handleRequest(state.originUrl, state.routes, req, res);
    });
    state.listenPromise = this.listen(state);

    return state.listenPromise;
  }

  private listen(state: HttpServerState): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };

      state.server?.once('error', onError);
      state.server?.listen(
        Number(state.originUrl.port || 80),
        state.originUrl.hostname,
        () => {
          state.server?.off('error', onError);
          this.resolveDynamicPort(state);
          resolve();
        },
      );
    });
  }

  private async handleRequest(
    originUrl: URL,
    routes: Map<string, HttpServeRoute[]>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    this.setCorsHeaders(res);

    const route = this.route(originUrl, routes, req);

    if (!route) {
      this.sendText(res, 404, 'Not Found');
      return;
    }

    try {
      if (route.rawCallback) {
        await route.rawCallback(req, res);
        return;
      }

      const result = await route.callback?.({
        request: req,
        headers: req.headers,
      });
      this.sendResult(res, route, result);
    } catch (err) {
      if (!res.headersSent) {
        this.sendText(res, 500, err instanceof Error ? err.message : 'Error');
        return;
      }

      res.destroy(err instanceof Error ? err : undefined);
    }
  }

  private route(
    originUrl: URL,
    routes: Map<string, HttpServeRoute[]>,
    req: http.IncomingMessage,
  ): HttpServeRoute | undefined {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', originUrl).pathname;

    const candidates = [
      ...(routes.get(this.routeKey(method, path)) ?? []),
      ...this.wildcardPathCandidates(routes, method, path),
      ...(routes.get(this.routeKey(method, '*')) ?? []),
      ...(routes.get(this.routeKey('*', path)) ?? []),
      ...this.wildcardPathCandidates(routes, '*', path),
      ...(routes.get(this.routeKey('*', '*')) ?? []),
    ];

    return candidates.find((route) =>
      this.requestHeadersMatch(route.requestHeaders, req),
    );
  }

  private wildcardPathCandidates(
    routes: Map<string, HttpServeRoute[]>,
    method: string,
    path: string,
  ): HttpServeRoute[] {
    const methodPrefix = `${method.toUpperCase()} `;
    const candidates: HttpServeRoute[] = [];

    for (const [key, routeGroup] of routes) {
      if (!key.startsWith(methodPrefix)) {
        continue;
      }

      const routePath = key.slice(methodPrefix.length);
      if (!routePath.endsWith('/*')) {
        continue;
      }

      const prefix = routePath.slice(0, -1);
      if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
        candidates.push(...routeGroup);
      }
    }

    return candidates;
  }

  private routeKey(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  private sendResult(
    res: http.ServerResponse,
    route: HttpServeRoute,
    result: unknown,
  ) {
    if (res.writableEnded) {
      return;
    }

    const response = this.normalizeResponse(route, result);
    const { body, contentType } = this.serializeBody(
      response.body,
      response.contentType,
    );

    res.writeHead(response.statusCode ?? 200, {
      ...response.headers,
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private normalizeResponse(
    route: HttpServeRoute,
    result: unknown,
  ): HttpServeResponse {
    const defaults: HttpServeResponse = {
      statusCode: route.statusCode,
      contentType:
        route.contentType ?? this.contentTypeHeader(route.responseHeaders),
      headers: route.responseHeaders,
    };

    if (this.isHttpServeResponse(result)) {
      return {
        ...defaults,
        ...result,
        contentType:
          result.contentType ??
          this.contentTypeHeader(result.headers) ??
          defaults.contentType,
        headers: {
          ...defaults.headers,
          ...result.headers,
        },
      };
    }

    return { ...defaults, body: result };
  }

  private isHttpServeResponse(result: unknown): result is HttpServeResponse {
    if (!result || typeof result !== 'object' || Buffer.isBuffer(result)) {
      return false;
    }

    return (
      'body' in result ||
      'headers' in result ||
      'contentType' in result ||
      'statusCode' in result
    );
  }

  private serializeBody(
    body: unknown,
    contentType?: string,
  ): { body: string; contentType: string } {
    if (body === undefined || body === null) {
      return {
        body: '',
        contentType: contentType ?? 'text/plain; charset=utf-8',
      };
    }

    if (Buffer.isBuffer(body)) {
      return {
        body: body.toString(),
        contentType: contentType ?? 'application/octet-stream',
      };
    }

    if (typeof body === 'string') {
      return {
        body,
        contentType: contentType ?? 'text/plain; charset=utf-8',
      };
    }

    return {
      body: JSON.stringify(body),
      contentType: contentType ?? 'application/json; charset=utf-8',
    };
  }

  private sendText(res: http.ServerResponse, statusCode: number, body: string) {
    res.writeHead(statusCode, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private requestHeadersMatch(
    expectedHeaders: http.OutgoingHttpHeaders | undefined,
    req: http.IncomingMessage,
  ): boolean {
    if (!expectedHeaders) {
      return true;
    }

    return Object.entries(expectedHeaders).every(([name, expectedValue]) => {
      const actualValue = req.headers[name.toLowerCase()];

      if (Array.isArray(expectedValue)) {
        return expectedValue.join(',') === this.headerValue(actualValue);
      }

      return String(expectedValue) === this.headerValue(actualValue);
    });
  }

  private headerValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
      return value.join(',');
    }

    return value ?? '';
  }

  private contentTypeHeader(
    headers: http.OutgoingHttpHeaders | undefined,
  ): string | undefined {
    const value = headers?.['content-type'] ?? headers?.['Content-Type'];

    if (Array.isArray(value)) {
      return value[0];
    }

    return typeof value === 'number' ? String(value) : value;
  }

  private setCorsHeaders(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
  }

  private resolveDynamicPort(state: HttpServerState) {
    if (state.originUrl.port !== '0') {
      return;
    }

    const originalOrigin = state.originUrl.origin;
    const address = state.server?.address();
    if (address && typeof address !== 'string') {
      state.originUrl.port = String(address.port);
      this.servers.delete(originalOrigin);
      this.servers.set(state.originUrl.origin, state);
    }
  }

  private normalizeOrigin(options: HttpServeOptions): URL {
    const origin = options.origin ?? 'http://localhost';
    const normalizedOrigin =
      origin.startsWith('http://') || origin.startsWith('https://')
        ? origin
        : `http://${origin}`;
    const originUrl = new URL(normalizedOrigin);

    if (originUrl.protocol !== 'http:') {
      throw new Error(
        `Graph inspector native HTTP server only supports http origins: ${origin}`,
      );
    }

    if (options.host) {
      originUrl.hostname = options.host;
    }

    if (options.port !== undefined) {
      originUrl.port = String(options.port);
    }

    if (!originUrl.port) {
      originUrl.port = '80';
    }

    return originUrl;
  }

  private normalizePath(path: string): string {
    if (path === '*') {
      return path;
    }

    return path.startsWith('/') ? path : `/${path}`;
  }
}
