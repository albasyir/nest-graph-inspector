import http from 'node:http';
import os from 'node:os';
import { INestApplication, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AccessTokenService,
  NestGraphInspectorModule,
  NestGraphInspectorModuleOptions,
} from 'nest-graph-inspector';

/**
 * Network-level checks for the inspector endpoints.
 *
 * These boot the real `NestGraphInspectorModule` and talk to it over TCP,
 * rather than assembling adapters by hand, so a mistake in how the guard is
 * wired into the module shows up here.
 */

/** Stands in for the kind of provider direct run can reach. */
@Injectable()
class VaultService {
  readonly invocations: string[] = [];

  readSecret(): string {
    this.invocations.push('readSecret');

    return 'production-database-password';
  }

  /**
   * TypeScript-`private`, not runtime-private: an ordinary callable prototype
   * member once compiled. In the default permissive mode Direct Run invokes
   * it like any other prototype method; strict mode (`allowUnsafeMethods:
   * false`) is what refuses it, by reading this modifier from source, since
   * the runtime shape alone cannot tell it apart from `readSecret`.
   */
  private rotateMasterKey(): string {
    this.invocations.push('rotateMasterKey');

    return 'rotated-master-key-material';
  }

  onModuleInit(): void {}
}

@Module({ providers: [VaultService], exports: [VaultService] })
class VaultModule {}

type Probe = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

type ProbeOptions = {
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
};

function probe(url: string, options: ProbeOptions = {}): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
          }),
        );
      },
    );

    request.on('error', reject);
    request.end(options.body);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Expected a TCP address')));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** First non-loopback IPv4 address, used to reach the inspector off-loopback. */
function externalIpv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return undefined;
}

async function bootInspector(config: {
  host: string;
  port: number;
  accessToken?: NestGraphInspectorModuleOptions['accessToken'];
  directRun?: NestGraphInspectorModuleOptions['directRun'];
}): Promise<{ app: INestApplication; vault: VaultService; token: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      VaultModule,
      NestGraphInspectorModule.forRoot({
        outputs: [{ type: 'viewer', host: config.host, port: config.port }],
        ...(config.accessToken ? { accessToken: config.accessToken } : {}),
        ...(config.directRun ? { directRun: config.directRun } : {}),
      }),
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    vault: app.get(VaultService, { strict: false }),
    token: app.get(AccessTokenService, { strict: false }).current(),
  };
}

const DIRECT_RUN_BODY = JSON.stringify({
  module: 'VaultModule',
  provider: 'VaultService',
  method: 'readSecret',
});

function directRunBodyFor(method: string): string {
  return JSON.stringify({
    module: 'VaultModule',
    provider: 'VaultService',
    method,
  });
}

describe('Graph inspector network access', () => {
  describe('an anonymous caller', () => {
    let app: INestApplication;
    let vault: VaultService;
    let token: string;
    let origin: string;

    beforeAll(async () => {
      const port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      ({ app, vault, token } = await bootInspector({
        host: '127.0.0.1',
        port,
      }));
    });

    afterAll(() => app.close());

    it.each([
      ['the endpoint metadata', 'GET', '/__graph-inspector/information.json'],
      ['the dependency graph', 'GET', '/__graph-inspector/output.json'],
      ['the graph schema', 'GET', '/__graph-inspector/output.schema.json'],
      ['the markdown graph', 'GET', '/__graph-inspector/output.md'],
      ['direct run', 'POST', '/direct-run'],
      ['the direct run history', 'GET', '/direct-run/histories'],
      ['the direct run history index', 'GET', '/direct-run/history/index.json'],
    ])('is refused %s', async (_label, method, path) => {
      const response = await probe(`${origin}${path}`, { method });

      expect(response.statusCode).toBe(401);
    });

    it('finds no request-forwarding relay to reach at all', async () => {
      // The viewer used to run its AI chat through a proxy the library opened
      // to a local Ollama daemon, mounted here under /ollama. Inference now
      // happens in the visitor's browser, so that relay was deleted rather
      // than merely guarded. 404 is the assertion that matters: a 401 would
      // mean the route still exists and only the token stands in front of it.
      const response = await probe(`${origin}/ollama/api/tags`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('can still complete a CORS preflight without a token', async () => {
      // A preflight carries no credentials of its own, so guarding it would
      // stop the browser from ever sending the request it asks about.
      const response = await probe(`${origin}/direct-run`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://albasyir.github.io',
          'access-control-request-method': 'POST',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    it('cannot invoke a provider method through direct run', async () => {
      const response = await probe(`${origin}/direct-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: DIRECT_RUN_BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('production-database-password');
      expect(vault.invocations).toEqual([]);
    });

    it('is served once it presents the token', async () => {
      const response = await probe(`${origin}/__graph-inspector/output.json`, {
        headers: { authorization: `Bearer ${token}` },
      });

      const graph = JSON.parse(response.body) as {
        modules: Record<string, unknown>;
      };

      expect(response.statusCode).toBe(200);
      expect(Object.keys(graph.modules)).toContain('VaultModule');
    });

    it('omits a TypeScript-private method from the direct-run metadata, even though the default mode can invoke it', async () => {
      const response = await probe(`${origin}/__graph-inspector/output.json`, {
        headers: { authorization: `Bearer ${token}` },
      });

      const graph = JSON.parse(response.body) as {
        modules: Record<
          string,
          {
            providers: Array<{
              name: string;
              directRun?: { methods: Array<{ name: string }> };
            }>;
          }
        >;
      };

      const vaultService = graph.modules.VaultModule.providers.find(
        (provider) => provider.name === 'VaultService',
      );
      const methodNames =
        vaultService?.directRun?.methods.map((method) => method.name) ?? [];

      // Read from the same live application whose sources back the Direct Run
      // allowlist the strict-mode suite below exercises, so a regression here
      // shows up before the request-time check would have to catch it. The
      // graph metadata only ever advertises confirmed public methods,
      // regardless of `allowUnsafeMethods`.
      expect(methodNames).toContain('readSecret');
      expect(methodNames).not.toContain('rotateMasterKey');
    });

    it('runs the provider method once the token is presented', async () => {
      const response = await probe(`${origin}/direct-run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: DIRECT_RUN_BODY,
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: true,
        result: 'production-database-password',
      });
      expect(vault.invocations).toEqual(['readSecret']);
    });

    it('invokes a TypeScript-private method in the default permissive mode', async () => {
      // `allowUnsafeMethods` defaults to `true`: the keyword is erased at
      // compile time, so this is an ordinary callable prototype member at
      // runtime, and the default favors local development ergonomics.
      const response = await probe(`${origin}/direct-run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: directRunBodyFor('rotateMasterKey'),
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: true,
        result: 'rotated-master-key-material',
      });
      expect(vault.invocations).toContain('rotateMasterKey');
    });

    it('invokes a Nest lifecycle hook and an inherited prototype method in the default permissive mode', async () => {
      for (const method of ['onModuleInit', 'toString']) {
        const response = await probe(`${origin}/direct-run`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: directRunBodyFor(method),
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({ ok: true });
      }
    });

    it('still refuses to invoke the constructor even in the default permissive mode', async () => {
      const response = await probe(`${origin}/direct-run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: directRunBodyFor('constructor'),
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('a caller in strict mode (allowUnsafeMethods: false)', () => {
    let app: INestApplication;
    let vault: VaultService;
    let token: string;
    let origin: string;

    beforeAll(async () => {
      const port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      ({ app, vault, token } = await bootInspector({
        host: '127.0.0.1',
        port,
        directRun: {
          allowUnsafeMethods: false,
          maxBodySizeBytes: 1024 * 1024,
        },
      }));
    });

    afterAll(() => app.close());

    it('still runs an allowlisted public method', async () => {
      const response = await probe(`${origin}/direct-run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: DIRECT_RUN_BODY,
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: true,
        result: 'production-database-password',
      });
      expect(vault.invocations).toEqual(['readSecret']);
    });

    it('rejects a TypeScript-private method even with a valid token, without invoking it', async () => {
      const response = await probe(`${origin}/direct-run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: directRunBodyFor('rotateMasterKey'),
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('rotated-master-key-material');
      expect(vault.invocations).not.toContain('rotateMasterKey');
    });

    it.each(['constructor', 'onModuleInit', 'toString', 'unknownMethod'])(
      'rejects the non-allowlisted method %s even with a valid token',
      async (method) => {
        const response = await probe(`${origin}/direct-run`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: directRunBodyFor(method),
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain('production-database-password');
      },
    );

    it('rejects a request body over the configured limit without leaking its contents', async () => {
      const secret = 'oversized-direct-run-secret';
      const response = await probe(`${origin}/direct-run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ args: `${secret}${'x'.repeat(1024 * 1024)}` }),
      });

      expect(response.statusCode).toBe(413);
      expect(response.body).not.toContain(secret);
    });
  });

  describe('a caller that keeps guessing', () => {
    let app: INestApplication;
    let token: string;
    let origin: string;

    beforeAll(async () => {
      const port = await freePort();
      origin = `http://127.0.0.1:${port}`;
      ({ app, token } = await bootInspector({
        host: '127.0.0.1',
        port,
        accessToken: { bruteForce: { maxFailures: 4, blockMs: 120_000 } },
      }));
    });

    afterAll(() => app.close());

    it('is locked out, token or not, once it runs out of attempts', async () => {
      const guess = (attempt: number) =>
        probe(`${origin}/__graph-inspector/output.json`, {
          headers: { authorization: `Bearer ngi1.eyJhIjoxfQ.guess${attempt}` },
        });

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect((await guess(attempt)).statusCode).toBe(401);
      }

      const blocked = await guess(5);
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // The lockout follows the caller, so a real token does not lift it.
      const withRealToken = await probe(
        `${origin}/__graph-inspector/output.json`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(withRealToken.statusCode).toBe(429);
    });
  });

  const lanAddress = externalIpv4();
  const describeOffLoopback = lanAddress ? describe : describe.skip;

  describeOffLoopback('a caller on another network interface', () => {
    let app: INestApplication;
    let token: string;
    let lanOrigin: string;
    let loopbackOrigin: string;

    beforeAll(async () => {
      const port = await freePort();
      lanOrigin = `http://${lanAddress}:${port}`;
      loopbackOrigin = `http://127.0.0.1:${port}`;
      // The default binding, which is what makes the inspector reachable from
      // outside the machine in the first place.
      ({ app, token } = await bootInspector({
        host: '0.0.0.0',
        port,
        accessToken: { bruteForce: { maxFailures: 2, blockMs: 120_000 } },
      }));
    });

    afterAll(() => app.close());

    it('reaches the inspector but is still refused without a token', async () => {
      const response = await probe(
        `${lanOrigin}/__graph-inspector/output.json`,
      );

      // A connection was accepted, so the port really is exposed; the 401 is
      // what stands between the network and the graph.
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({ reason: 'missing' });
    });

    it('does not lock out other callers when it is blocked', async () => {
      const guess = (attempt: number) =>
        probe(`${lanOrigin}/__graph-inspector/output.json`, {
          headers: { authorization: `Bearer ngi1.eyJhIjoxfQ.guess${attempt}` },
        });

      expect((await guess(1)).statusCode).toBe(401);
      expect((await guess(2)).statusCode).toBe(401);
      expect((await guess(3)).statusCode).toBe(429);

      const fromLoopback = await probe(
        `${loopbackOrigin}/__graph-inspector/output.json`,
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(fromLoopback.statusCode).toBe(200);
    });
  });
});
