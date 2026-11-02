import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AccessTokenService } from 'nest-graph-inspector';
import { AppModule } from './../src/app.module';

const DEMO_DIR = resolve(__dirname, '..');
const CLI = resolve(
  DEMO_DIR,
  'node_modules/nest-graph-inspector/dist/cli/bin.js',
);

function exportGraph(...args: string[]) {
  return spawnSync(
    process.execPath,
    [CLI, 'export', '--compact', '--out', '-', ...args],
    { cwd: DEMO_DIR, encoding: 'utf8' },
  );
}

/**
 * `nest-graph-inspector export` draws the demo's graph without running it,
 * by booting it in Nest's preview mode. The graph it writes must be the very
 * document the running demo serves the viewer.
 */
describe('nest-graph-inspector export (e2e)', () => {
  let servedGraph: string;

  beforeAll(async () => {
    // The export reads the nest build output, as `build:graph` does.
    const build = spawnSync(
      process.execPath,
      [require.resolve('@nestjs/cli/bin/nest.js'), 'build'],
      { cwd: DEMO_DIR, encoding: 'utf8' },
    );
    if (build.status !== 0) {
      throw new Error(`nest build failed:\n${build.stdout}${build.stderr}`);
    }

    const app: INestApplication = await NestFactory.create(AppModule, {
      logger: false,
    });

    try {
      await app.init();
      const accessToken = app.get(AccessTokenService, { strict: false });
      const response = await request('http://localhost:53371')
        .get('/__graph-inspector/output.json')
        .set('Authorization', `Bearer ${accessToken.current()}`)
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => done(null, text));
        })
        .expect(200);

      servedGraph = response.body as string;
    } finally {
      await app.close();
    }
  }, 120_000);

  it('exports the compiled demo exactly as the running demo serves it', () => {
    const result = exportGraph();

    expect(result.stderr).toContain(
      'nest-graph-inspector: exported AppModule (',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(servedGraph);
  }, 60_000);

  it('exports the TypeScript sources the same way, through ts-node', () => {
    const result = exportGraph(
      '--entry',
      'src/app.module.ts',
      '--require',
      'ts-node/register',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(servedGraph);
  }, 60_000);
});
