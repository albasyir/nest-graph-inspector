import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { resolveInspectorTarget } from './inspector-outputs';

/**
 * Interval that keeps the process alive under the browser runtime. The value
 * is arbitrary: nothing runs on it, it only has to exist.
 */
const KEEP_ALIVE_INTERVAL_MS = 60_000;

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  if (resolveInspectorTarget() === 'nodepod') {
    /**
     * Express hashes `Buffer.from(body, undefined)` to build an ETag, and the
     * browser Node runtime the documentation demo runs in answers that call
     * with a value the `etag` package rejects, which turns every response into
     * a 500. Nothing in the demo depends on ETags.
     */
    app.set('etag', false);

    /**
     * That runtime also ends a process as soon as its event loop looks empty,
     * and neither a virtual HTTP server nor an in-flight cross-origin fetch
     * holds it open — the inspector awaits one during startup to report the
     * latest published version, and the application would exit underneath it.
     * A timer is something the runtime does keep a process alive for, and a
     * server that stays up until it is stopped is what happens on a real
     * machine anyway.
     */
    setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
  }

  await app.listen(8889);
}

bootstrap();
