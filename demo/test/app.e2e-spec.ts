import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
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
  });
});
