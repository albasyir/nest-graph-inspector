import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { Injectable } from '@nestjs/common';
import { HttpServeAdapter } from './http-serve.adapter';
import type {
  ProxyCorsOptions,
  ProxyGateway,
  ProxyGatewayOptions,
} from '../ports/proxy.gateway';

@Injectable()
export class ProxyAdapter implements ProxyGateway {
  private readonly httpServeAdapters: HttpServeAdapter[] = [];

  async serve(
    options: ProxyGatewayOptions,
    internalOptions: {
      httpAdapter?: HttpServeAdapter;
      pathPrefix?: string;
    } = {},
  ): Promise<void> {
    const fromUrl = this.normalizeUrl(options.from);
    const toUrl = this.normalizeUrl(options.to);
    const cors = options.cors === false ? undefined : options.cors;
    const isReuseHttpAdapter = !!internalOptions.httpAdapter;
    const httpServeAdapter =
      internalOptions.httpAdapter ?? new HttpServeAdapter();
    const pathPrefix = internalOptions.pathPrefix
      ? this.normalizePath(internalOptions.pathPrefix)
      : undefined;

    httpServeAdapter.register(
      { origin: fromUrl.origin },
      (pathPrefix ? [pathPrefix, `${pathPrefix}/*`] : ['*']).map((path) => ({
        type: '*',
        path,
        rawCallback: (clientReq, clientRes) => {
          if (this.handleCorsPreflight(cors, clientReq, clientRes)) {
            return;
          }

          this.forwardRequest(toUrl, cors, clientReq, clientRes, pathPrefix);
        },
      })),
    );

    if (isReuseHttpAdapter) {
      return;
    }

    try {
      await httpServeAdapter.serve();
    } catch (err) {
      httpServeAdapter.close();
      throw err;
    }

    this.httpServeAdapters.push(httpServeAdapter);
  }

  close() {
    for (const httpServeAdapter of this.httpServeAdapters) {
      httpServeAdapter.close();
    }
    this.httpServeAdapters.length = 0;
  }

  private forwardRequest(
    toUrl: URL,
    cors: ProxyCorsOptions | undefined,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    pathPrefix?: string,
  ) {
    const targetUrl = this.targetUrl(clientReq.url ?? '/', toUrl, pathPrefix);
    const requestModule = this.getRequestModule(targetUrl);

    const proxyReq = requestModule.request(
      targetUrl,
      this.createProxyRequestOptions(clientReq, targetUrl),
      (proxyRes) => this.forwardResponse(cors, proxyRes, clientReq, clientRes),
    );

    proxyReq.on('error', (error) => {
      this.handleProxyError(error, clientRes);
    });

    clientReq.pipe(proxyReq);
  }

  private targetUrl(requestUrl: string, toUrl: URL, pathPrefix?: string): URL {
    const targetUrl = new URL(requestUrl, toUrl);
    if (!pathPrefix) {
      return targetUrl;
    }

    if (
      targetUrl.pathname === pathPrefix ||
      targetUrl.pathname.startsWith(`${pathPrefix}/`)
    ) {
      targetUrl.pathname = targetUrl.pathname.slice(pathPrefix.length) || '/';
    }

    return targetUrl;
  }

  private forwardResponse(
    cors: ProxyCorsOptions | undefined,
    proxyRes: http.IncomingMessage,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
  ) {
    clientRes.writeHead(proxyRes.statusCode ?? 500, {
      ...proxyRes.headers,
      ...this.getCorsHeaders(cors, clientReq),
    });

    proxyRes.pipe(clientRes);
  }

  private createProxyRequestOptions(
    clientReq: http.IncomingMessage,
    targetUrl: URL,
  ): http.RequestOptions {
    return {
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        host: targetUrl.host,
      },
    };
  }

  private handleProxyError(error: Error, res: http.ServerResponse) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    res.statusCode = 502;
    res.end(`Proxy error: ${error.message}`);
  }

  private getRequestModule(targetUrl: URL) {
    return targetUrl.protocol === 'https:' ? https : http;
  }

  private getCorsHeaders(
    cors: ProxyCorsOptions | undefined,
    req: http.IncomingMessage,
  ): http.OutgoingHttpHeaders {
    if (!cors) return {};

    const origin = req.headers.origin;

    if (!this.isAllowedOrigin(cors, origin)) {
      return {};
    }

    const allowHeaders = Array.isArray(cors.allowHeaders)
      ? cors.allowHeaders.join(',')
      : cors.allowHeaders;

    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': (
        cors.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
      ).join(','),
      'access-control-allow-headers':
        allowHeaders ?? req.headers['access-control-request-headers'] ?? '*',
      'access-control-allow-credentials': String(cors.credentials ?? true),
      vary: 'Origin',
    };
  }

  private applyCors(
    cors: ProxyCorsOptions | undefined,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const headers = this.getCorsHeaders(cors, req);

    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) {
        res.setHeader(key, value);
      }
    }
  }

  private handleCorsPreflight(
    cors: ProxyCorsOptions | undefined,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    if (!cors || !this.isCorsPreflightRequest(req)) {
      return false;
    }

    this.applyCors(cors, req, res);
    res.writeHead(204, {
      'content-length': 0,
    });
    res.end();

    return true;
  }

  private isCorsPreflightRequest(req: http.IncomingMessage): boolean {
    return (
      req.method === 'OPTIONS' &&
      typeof req.headers.origin === 'string' &&
      typeof req.headers['access-control-request-method'] === 'string'
    );
  }

  private isAllowedOrigin(cors: ProxyCorsOptions, origin: unknown) {
    if (typeof origin !== 'string') return false;

    return cors.origins.some((allowedOrigin) => {
      if (typeof allowedOrigin === 'string') {
        return allowedOrigin === origin;
      }

      return allowedOrigin.test(origin);
    });
  }

  private normalizeUrl(value: string) {
    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      return new URL(`http://${value}`);
    }

    return new URL(value);
  }

  private normalizePath(path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    return normalizedPath.replace(/\/$/, '');
  }
}
