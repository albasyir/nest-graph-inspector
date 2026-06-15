import http from 'node:http';
import { AddressInfo } from 'node:net';

import { HttpServeAdapter } from './http-serve.adapter';
import { ProxyAdapter } from './proxy.adapter';

type HttpResponse = {
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

describe(ProxyAdapter.name, () => {
  let httpServeAdapter: HttpServeAdapter;
  let proxyAdapter: ProxyAdapter;
  let targetServer: http.Server | undefined;

  beforeEach(() => {
    httpServeAdapter = new HttpServeAdapter();
    proxyAdapter = new ProxyAdapter();
  });

  afterEach(() => {
    httpServeAdapter.close();
    targetServer?.close();
    targetServer = undefined;
  });

  it('proxies /ollama requests to the target origin without the /ollama prefix', async () => {
    targetServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ url: req.url }));
    });
    await listen(targetServer, 0);

    const targetAddress = targetServer.address() as AddressInfo;
    const viewerPort = await availablePort();

    await proxyAdapter.serve(
      {
        from: `http://127.0.0.1:${viewerPort}`,
        to: `http://127.0.0.1:${targetAddress.port}`,
        cors: false,
      },
      {
        httpAdapter: httpServeAdapter,
        pathPrefix: '/ollama',
      },
    );
    await httpServeAdapter.serve();

    const response = await get(
      `http://127.0.0.1:${viewerPort}/ollama/api/tags?limit=1`,
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      url: '/api/tags?limit=1',
    });
  });

  it('proxies request body to the target origin', async () => {
    targetServer = http.createServer((req, res) => {
      let body = '';

      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify({ url: req.url, body }));
      });
    });
    await listen(targetServer, 0);

    const targetAddress = targetServer.address() as AddressInfo;
    const viewerPort = await availablePort();

    await proxyAdapter.serve(
      {
        from: `http://127.0.0.1:${viewerPort}`,
        to: `http://127.0.0.1:${targetAddress.port}`,
        cors: false,
      },
      {
        httpAdapter: httpServeAdapter,
        pathPrefix: '/ollama',
      },
    );
    await httpServeAdapter.serve();

    const response = await post(
      `http://127.0.0.1:${viewerPort}/ollama/api/pull`,
      JSON.stringify({
        model: 'qwen3:8b',
        stream: true,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      url: '/api/pull',
      body: JSON.stringify({
        model: 'qwen3:8b',
        stream: true,
      }),
    });
  });

  it('adds CORS headers to proxied responses for allowed origins', async () => {
    targetServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ url: req.url }));
    });
    await listen(targetServer, 0);

    const targetAddress = targetServer.address() as AddressInfo;
    const viewerPort = await availablePort();

    await proxyAdapter.serve(
      {
        from: `http://127.0.0.1:${viewerPort}`,
        to: `http://127.0.0.1:${targetAddress.port}`,
        cors: {
          origins: ['https://viewer.example'],
          methods: ['GET', 'POST', 'OPTIONS'],
          allowHeaders: ['content-type', 'authorization'],
        },
      },
      {
        httpAdapter: httpServeAdapter,
        pathPrefix: '/ollama',
      },
    );
    await httpServeAdapter.serve();

    const response = await request(
      `http://127.0.0.1:${viewerPort}/ollama/api/tags`,
      {
        headers: {
          origin: 'https://viewer.example',
        },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://viewer.example',
    );
    expect(response.headers['access-control-allow-methods']).toBe(
      'GET,POST,OPTIONS',
    );
    expect(response.headers['access-control-allow-headers']).toBe(
      'content-type,authorization',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers.vary).toBe('Origin');
  });

  it('responds to CORS preflight requests without forwarding to the target origin', async () => {
    let targetRequestCount = 0;

    targetServer = http.createServer((_req, res) => {
      targetRequestCount += 1;
      res.writeHead(405);
      res.end();
    });
    await listen(targetServer, 0);

    const targetAddress = targetServer.address() as AddressInfo;
    const viewerPort = await availablePort();

    await proxyAdapter.serve(
      {
        from: `http://127.0.0.1:${viewerPort}`,
        to: `http://127.0.0.1:${targetAddress.port}`,
        cors: {
          origins: [/^https:\/\/viewer\.example$/],
          methods: ['POST', 'OPTIONS'],
        },
      },
      {
        httpAdapter: httpServeAdapter,
        pathPrefix: '/ollama',
      },
    );
    await httpServeAdapter.serve();

    const response = await request(
      `http://127.0.0.1:${viewerPort}/ollama/api/pull`,
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://viewer.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      },
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://viewer.example',
    );
    expect(response.headers['access-control-allow-methods']).toBe(
      'POST,OPTIONS',
    );
    expect(response.headers['access-control-allow-headers']).toBe(
      'content-type',
    );
    expect(targetRequestCount).toBe(0);
  });
});

function get(url: string): Promise<HttpResponse> {
  return request(url);
}

function post(url: string, body: string): Promise<HttpResponse> {
  return request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    body,
  });
}

function request(
  url: string,
  options: http.RequestOptions & { body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);
    req.end(options.body);
  });
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function availablePort(): Promise<number> {
  const server = http.createServer();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Expected TCP address')));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
