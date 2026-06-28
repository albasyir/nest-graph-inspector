import http from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';

import { DirectRunOutputAdapter } from './direct-run-output.adapter';
import { HttpServeAdapter } from './http-serve.adapter';

describe(DirectRunOutputAdapter.name, () => {
  let moduleRef: TestingModule;
  let adapter: DirectRunOutputAdapter;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [HttpServeAdapter, DirectRunOutputAdapter],
    }).compile();

    adapter = moduleRef.get(DirectRunOutputAdapter);
  });

  afterEach(() => moduleRef.close());

  it('executes zero-argument provider methods over HTTP', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', (moduleName, providerName) => {
          if (moduleName === 'AppModule' && providerName === 'PingProvider') {
            return {
              ping: () => 'pong',
            };
          }

          return undefined;
        }),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'PingProvider',
      method: 'ping',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      method: 'ping',
      result: 'pong',
    });
  });

  it('rejects methods that require arguments', async () => {
    const port = await availablePort();
    const httpServeAdapter = moduleRef.get(HttpServeAdapter);

    httpServeAdapter.register(
      {
        host: '127.0.0.1',
        port,
      },
      [
        adapter.createRoute('/direct-run', () => ({
          ping: (_value: string) => 'pong',
        })),
      ],
    );
    await httpServeAdapter.serve();

    const response = await post(`http://127.0.0.1:${port}/direct-run`, {
      module: 'AppModule',
      provider: 'PingProvider',
      method: 'ping',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: 'Method ping requires arguments and cannot be direct-run.',
    });
  });
});

type HttpResponse = {
  statusCode?: number;
  body: string;
};

function post(url: string, payload: unknown): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const req = http.request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: responseBody,
          });
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
