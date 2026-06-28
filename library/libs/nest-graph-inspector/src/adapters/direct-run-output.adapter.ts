import { Injectable } from '@nestjs/common';
import type { HttpServeResponse } from './http-serve.adapter';
import { HttpServeAdapter } from './http-serve.adapter';
import type { DirectRunResult } from '../types/direct-run.type';

@Injectable()
export class DirectRunOutputAdapter {
  constructor(
    private readonly httpServeAdapter: HttpServeAdapter,
  ) {}

  createRoute(path: string, instanceLookup: (moduleName: string, providerName: string) => unknown) {
    return this.httpServeAdapter.post(path, async ({ request }) => {
      const body = await this.readJsonBody(request);
      const moduleName = typeof body.module === 'string' ? body.module : '';
      const providerName = typeof body.provider === 'string' ? body.provider : '';
      const methodName = typeof body.method === 'string' ? body.method : '';

      if (!moduleName || !providerName || !methodName) {
        return this.badRequest('module, provider, and method are required.');
      }

      const instance = instanceLookup(moduleName, providerName) as Record<string, unknown> | undefined;
      if (!instance) {
        return this.notFound(`Provider ${moduleName}:${providerName} is unavailable.`);
      }

      const method = instance[methodName];
      if (typeof method !== 'function') {
        return this.badRequest(`Method ${methodName} is unavailable for direct run.`);
      }

      if (method.length > 0) {
        return this.badRequest(`Method ${methodName} requires arguments and cannot be direct-run.`);
      }

      try {
        const result = await method.call(instance);
        const payload: DirectRunResult = {
          ok: true,
          method: methodName,
          result,
        };

        return {
          statusCode: 200,
          body: payload,
        } satisfies HttpServeResponse;
      } catch (error) {
        const payload: DirectRunResult = {
          ok: false,
          method: methodName,
          error: error instanceof Error ? error.message : 'Direct run failed.',
        };

        return {
          statusCode: 500,
          body: payload,
        } satisfies HttpServeResponse;
      }
    }, {
      responseHeaders: {
        'content-type': 'application/json; charset=utf-8',
      },
      requestHeaders: {
        'content-type': 'application/json',
      },
    });
  }

  private async readJsonBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
    let body = '';

    for await (const chunk of request) {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    }

    if (!body.trim()) {
      return {};
    }

    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private badRequest(message: string): HttpServeResponse {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: message,
      } satisfies DirectRunResult,
    };
  }

  private notFound(message: string): HttpServeResponse {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: message,
      } satisfies DirectRunResult,
    };
  }
}
