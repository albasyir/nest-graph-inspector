/**
 * A plain, hand-written NestJS application for the raw-NestJS spike: four
 * CommonJS files and the packages they need, installed into the pod from the
 * registry rather than bundled ahead of time.
 *
 * The demo payload proves a prebuilt bundle starts under nodepod; this proves
 * an ordinary multi-file project does, resolving `@nestjs/*` out of a real
 * `node_modules`. Both `scripts/verify-raw-nestjs-spike.ts` and the
 * `/raw-spike` page boot exactly these files, so the page shows what the check
 * verifies.
 *
 * The sources are JavaScript with no decorator syntax: `Reflect.decorate` and
 * an explicit `design:paramtypes` entry stand in for what `tsc` would emit
 * with `emitDecoratorMetadata`.
 */

export const RAW_SPIKE_WORKDIR = '/app'
export const RAW_SPIKE_ENTRY = 'main.js'
export const RAW_SPIKE_PORT = 3333
export const RAW_SPIKE_REQUEST_PATH = '/api/hello'
export const RAW_SPIKE_READY_LINE = `NESTJS RAW MULTI-FILE READY ON ${RAW_SPIKE_PORT}`
export const RAW_SPIKE_MESSAGE = 'Hello from raw NestJS running inside nodepod'

/** Exact versions, so a run measures the runtime rather than a moving target. */
export const RAW_SPIKE_PACKAGES: ReadonlyArray<readonly [name: string, version: string]> = [
  ['reflect-metadata', '0.2.2'],
  ['rxjs', '7.8.1'],
  ['@nestjs/common', '11.2.1'],
  ['@nestjs/core', '11.2.1'],
  ['@nestjs/platform-express', '11.2.1']
]

const APP_SERVICE = `const { Injectable } = require('@nestjs/common');

class AppService {
  getHello() {
    return { message: ${JSON.stringify(RAW_SPIKE_MESSAGE)}, success: true };
  }
}

Reflect.decorate([Injectable()], AppService);

module.exports = { AppService };
`

const APP_CONTROLLER = `const { Controller, Get } = require('@nestjs/common');
const { AppService } = require('./app.service');

class AppController {
  constructor(appService) {
    this.appService = appService;
  }

  getHello() {
    return this.appService.getHello();
  }
}

Reflect.decorate(
  [Get('hello')],
  AppController.prototype,
  'getHello',
  Object.getOwnPropertyDescriptor(AppController.prototype, 'getHello')
);
Reflect.decorate(
  [Controller('api'), Reflect.metadata('design:paramtypes', [AppService])],
  AppController
);

module.exports = { AppController };
`

const APP_MODULE = `const { Module } = require('@nestjs/common');
const { AppController } = require('./app.controller');
const { AppService } = require('./app.service');

class AppModule {}

Reflect.decorate(
  [Module({ controllers: [AppController], providers: [AppService] })],
  AppModule
);

module.exports = { AppModule };
`

// The two accommodations mirror demo/scripts/build-nodepod-payload.ts: the
// runtime's two Buffer implementations must recognise each other or Express's
// ETag hashing turns every response into a 500, and a timer keeps the event
// loop alive because a virtual HTTP server alone does not.
const MAIN = `require('reflect-metadata');

(() => {
  const moduleBuffer = require('buffer').Buffer;
  const globalBuffer = globalThis.Buffer;

  if (moduleBuffer && globalBuffer && moduleBuffer !== globalBuffer) {
    const recognisedByModule = moduleBuffer.isBuffer.bind(moduleBuffer);
    const recognisedByGlobal = globalBuffer.isBuffer.bind(globalBuffer);
    const isBuffer = (value) =>
      recognisedByGlobal(value) || recognisedByModule(value);

    moduleBuffer.isBuffer = isBuffer;
    globalBuffer.isBuffer = isBuffer;
  }

  setInterval(() => undefined, 60000);
})();

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./app.module');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  await app.listen(${RAW_SPIKE_PORT});
  console.log(${JSON.stringify(RAW_SPIKE_READY_LINE)});
}

bootstrap().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`

/** The project files, keyed by absolute path inside the pod. */
export const RAW_SPIKE_FILES: Readonly<Record<string, string>> = {
  [`${RAW_SPIKE_WORKDIR}/package.json`]: `${JSON.stringify(
    {
      name: 'raw-nestjs-spike',
      private: true,
      main: RAW_SPIKE_ENTRY,
      dependencies: Object.fromEntries(RAW_SPIKE_PACKAGES)
    },
    null,
    2
  )}\n`,
  [`${RAW_SPIKE_WORKDIR}/app.service.js`]: APP_SERVICE,
  [`${RAW_SPIKE_WORKDIR}/app.controller.js`]: APP_CONTROLLER,
  [`${RAW_SPIKE_WORKDIR}/app.module.js`]: APP_MODULE,
  [`${RAW_SPIKE_WORKDIR}/${RAW_SPIKE_ENTRY}`]: MAIN
}

export type RawSpikeHelloBody = { message: string, success: true }

/**
 * Checks a response body is the one `AppService.getHello` returns, so the
 * script and the page agree on what "it answered" means.
 */
export function isRawSpikeHelloBody(value: unknown): value is RawSpikeHelloBody {
  if (!value || typeof value !== 'object') {
    return false
  }

  const body = value as Record<string, unknown>

  return typeof body.message === 'string' && body.message.length > 0 && body.success === true
}
