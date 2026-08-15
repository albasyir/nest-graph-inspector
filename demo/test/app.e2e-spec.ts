import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AccessTokenService } from 'nest-graph-inspector';
import { AppModule } from './../src/app.module';

describe('ProductController (e2e)', () => {
  let app: INestApplication<App>;
  const originalFeaturedProductId = process.env.MOBILE_FEATURED_PRODUCT_ID;

  beforeEach(async () => {
    process.env.MOBILE_FEATURED_PRODUCT_ID = '2';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    if (originalFeaturedProductId === undefined) {
      delete process.env.MOBILE_FEATURED_PRODUCT_ID;
      return;
    }

    process.env.MOBILE_FEATURED_PRODUCT_ID = originalFeaturedProductId;
  });

  it('uses MOBILE_FEATURED_PRODUCT_ID to return the mobile featured product', async () => {
    await request(app.getHttpServer())
      .post('/products')
      .send({ name: 'First product', price: 10, ownerId: 1 })
      .expect(201);

    await request(app.getHttpServer())
      .post('/products')
      .send({ name: 'Featured product', price: 20, ownerId: 1 })
      .expect(201);

    await request(app.getHttpServer())
      .get('/products/featured/mobile')
      .expect(200)
      .expect('Featured product');

    // The graph endpoint is token gated, and the token is held by the
    // inspector running inside this application.
    const accessToken = app.get(AccessTokenService, { strict: false });

    const graphResponse = await request('http://localhost:53371')
      .get('/__graph-inspector/output.json')
      .set('Authorization', `Bearer ${accessToken.current()}`)
      .expect('content-type', /json/)
      .expect(200);

    const graphBody: unknown = graphResponse.body;

    expect(graphBody).not.toBeNull();
    expect(typeof graphBody).toBe('object');

    if (graphBody === null || typeof graphBody !== 'object') {
      throw new Error('Viewer output must be a JSON graph object');
    }

    const graph = graphBody as Record<string, unknown>;

    expect(typeof graph.version).toBe('string');
    expect(graph.modules).not.toBeNull();
    expect(typeof graph.modules).toBe('object');
    expect(JSON.stringify(graph)).toContain('ConfigService');
  });
});
