import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessTokenService } from 'nest-graph-inspector';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Every read and write in the demo waits out a simulated database round trip
 * of 100–200 ms, and one request makes several, so the flow below takes
 * seconds rather than milliseconds.
 */
const FLOW_TIMEOUT_MS = 120_000;

type Method = 'get' | 'post' | 'put' | 'delete';

interface Route {
  readonly method: Method;
  readonly path: string;
  readonly token?: string;
  readonly body?: object;
}

/**
 * Sends one request to the running application and returns its JSON body,
 * failing with the body in the message when the status is not `status`.
 */
async function call(
  server: App,
  route: Route,
  status: number,
): Promise<unknown> {
  let pending = request(server)[route.method](route.path);

  if (route.token) {
    pending = pending.set('Authorization', `Bearer ${route.token}`);
  }

  if (route.body) {
    pending = pending.send(route.body);
  }

  const response = await pending;

  if (response.status !== status) {
    throw new Error(
      `${route.method.toUpperCase()} ${route.path} answered ${response.status}, expected ${status}: ${JSON.stringify(response.body)}`,
    );
  }

  const body: unknown = response.body;

  return body;
}

/** The value at a dotted path of a JSON body; a missing step fails the test. */
function at(value: unknown, path: string): unknown {
  let current = value;

  for (const key of path.split('.')) {
    if (
      typeof current !== 'object' ||
      current === null ||
      !Object.hasOwn(current, key)
    ) {
      throw new Error(`No ${path} in ${JSON.stringify(value)}`);
    }

    const next: unknown = Reflect.get(current, key);
    current = next;
  }

  return current;
}

function textAt(value: unknown, path: string): string {
  const found = at(value, path);

  if (typeof found !== 'string') {
    throw new Error(`${path} is not a string in ${JSON.stringify(value)}`);
  }

  return found;
}

function numberAt(value: unknown, path: string): number {
  const found = at(value, path);

  if (typeof found !== 'number') {
    throw new Error(`${path} is not a number in ${JSON.stringify(value)}`);
  }

  return found;
}

function listOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected a JSON array, got ${JSON.stringify(value)}`);
  }

  const list: unknown[] = value;

  return list;
}

function textsOf(value: unknown): string[] {
  return listOf(value).map((item) => {
    if (typeof item !== 'string') {
      throw new Error(`Expected strings, got ${JSON.stringify(value)}`);
    }

    return item;
  });
}

/**
 * A cycle in one canonical spelling: `type: A → B → … → A`, started at its
 * alphabetically first node, so the same loop reads the same whichever node
 * the inspector happened to start it from.
 */
function describeLoop(type: string, path: readonly string[]): string {
  const nodes = path.slice(0, -1);
  const start = nodes.indexOf([...nodes].sort()[0] ?? '');
  const rotated = [...nodes.slice(start), ...nodes.slice(0, start)];

  return `${type}: ${[...rotated, rotated[0]].join(' → ')}`;
}

describe('Shop App (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
  });

  it(
    'takes a new customer from sign-up to a paid order bought with a loyalty voucher',
    async () => {
      const server = app.getHttpServer();
      const email = 'rina@example.com';
      const password = 'correct horse battery';

      // Register: the email is stored lower-cased, and no credential comes back.
      const customer = await call(
        server,
        {
          method: 'post',
          path: '/auth/register',
          body: { name: 'Rina Wijaya', email: 'Rina@Example.com', password },
        },
        201,
      );
      expect(customer).toMatchObject({
        name: 'Rina Wijaya',
        email,
        phone: null,
      });
      expect(customer).not.toHaveProperty('passwordHash');
      const customerId = textAt(customer, 'id');

      // Sign in for a bearer token; every private route wants one.
      await call(server, { method: 'get', path: '/orders' }, 401);
      const signedIn = await call(
        server,
        { method: 'post', path: '/auth/login', body: { email, password } },
        200,
      );
      expect(signedIn).toMatchObject({ tokenType: 'Bearer', customerId });
      const token = textAt(signedIn, 'accessToken');
      expect(
        await call(
          server,
          { method: 'get', path: '/auth/session', token },
          200,
        ),
      ).toMatchObject({ customerId });

      const loyaltyAtStart = await call(
        server,
        { method: 'get', path: '/loyalty/me', token },
        200,
      );
      expect(loyaltyAtStart).toMatchObject({
        tier: 'BRONZE',
        pointsBalance: 0,
        lifetimePoints: 0,
      });

      // Checkout without a voucher: a charger (Rp 149.000) and two cables
      // (Rp 49.000 each) at Jakarta Central. Bronze gives no tier discount.
      const firstCheckout = await call(
        server,
        {
          method: 'post',
          path: '/orders/checkout',
          token,
          body: {
            storeId: 'str_1',
            items: [
              { productId: 'prd_2', quantity: 1 },
              { productId: 'prd_1', quantity: 2 },
            ],
          },
        },
        201,
      );
      expect(firstCheckout).toMatchObject({
        order: {
          status: 'PENDING_PAYMENT',
          customerId,
          voucher: null,
          loyaltyTier: 'BRONZE',
          pricing: {
            subtotal: 247_000,
            voucherDiscount: 0,
            tierDiscount: 0,
            total: 247_000,
          },
        },
        bill: { status: 'UNPAID', amount: 247_000 },
      });
      const firstOrderId = textAt(firstCheckout, 'order.id');
      const firstBillId = textAt(firstCheckout, 'bill.id');

      // Pay it through the simulated gateway: one point per Rp 1.000 paid.
      expect(
        await call(
          server,
          {
            method: 'post',
            path: `/payments/bills/${firstBillId}/simulate-pay`,
            token,
          },
          200,
        ),
      ).toMatchObject({
        bill: { id: firstBillId, status: 'PAID' },
        order: { id: firstOrderId, status: 'PAID', pointsEarned: 247 },
      });

      const loyaltyAfterFirstOrder = await call(
        server,
        { method: 'get', path: '/loyalty/me', token },
        200,
      );
      expect(numberAt(loyaltyAfterFirstOrder, 'pointsBalance')).toBeGreaterThan(
        numberAt(loyaltyAtStart, 'pointsBalance'),
      );
      expect(loyaltyAfterFirstOrder).toMatchObject({
        pointsBalance: 247,
        lifetimePoints: 247,
      });

      // Claim a loyalty voucher: 100 points for Rp 20.000 off from Rp 100.000.
      const claim = await call(
        server,
        { method: 'post', path: '/vouchers/rewards/rwd_1/claim', token },
        201,
      );
      expect(claim).toMatchObject({
        pointsSpent: 100,
        pointsBalance: 147,
        voucher: {
          audience: 'PERSONAL',
          discount: { kind: 'FIXED', amount: 20_000 },
          minSpend: 100_000,
          usage: { status: 'AVAILABLE' },
        },
      });
      const voucherCode = textAt(claim, 'voucher.code');
      expect(voucherCode).toMatch(/^RWD-[A-Z2-9]{8}$/);
      expect(
        await call(server, { method: 'get', path: '/loyalty/me', token }, 200),
      ).toMatchObject({ pointsBalance: 147, lifetimePoints: 247 });

      // Checkout with the voucher: a power bank, Rp 299.000, less Rp 20.000.
      const stockBefore = numberAt(
        await call(
          server,
          { method: 'get', path: '/stores/str_1/products/prd_3' },
          200,
        ),
        'stock',
      );
      const secondCheckout = await call(
        server,
        {
          method: 'post',
          path: '/orders/checkout',
          token,
          body: {
            storeId: 'str_1',
            items: [{ productId: 'prd_3', quantity: 1 }],
            voucherCode,
          },
        },
        201,
      );
      expect(secondCheckout).toMatchObject({
        order: {
          status: 'PENDING_PAYMENT',
          voucher: { code: voucherCode },
          pricing: {
            subtotal: 299_000,
            voucherDiscount: 20_000,
            tierDiscount: 0,
            total: 279_000,
          },
        },
        bill: { status: 'UNPAID', amount: 279_000 },
      });
      const secondOrderId = textAt(secondCheckout, 'order.id');
      const secondBillId = textAt(secondCheckout, 'bill.id');
      expect(
        numberAt(
          await call(
            server,
            { method: 'get', path: '/stores/str_1/products/prd_3' },
            200,
          ),
          'stock',
        ),
      ).toBe(stockBefore - 1);

      expect(
        await call(
          server,
          {
            method: 'post',
            path: `/payments/bills/${secondBillId}/simulate-pay`,
            token,
          },
          200,
        ),
      ).toMatchObject({
        bill: { id: secondBillId, status: 'PAID' },
        order: { id: secondOrderId, status: 'PAID', pointsEarned: 279 },
      });

      // The voucher is spent on that order, and cannot be spent again.
      const wallet = listOf(
        await call(
          server,
          { method: 'get', path: '/vouchers/mine', token },
          200,
        ),
      );
      expect(
        wallet.find((voucher) => textAt(voucher, 'code') === voucherCode),
      ).toMatchObject({ usage: { status: 'USED', orderId: secondOrderId } });
      await call(
        server,
        {
          method: 'post',
          path: '/orders/checkout',
          token,
          body: {
            storeId: 'str_1',
            items: [{ productId: 'prd_3', quantity: 1 }],
            voucherCode,
          },
        },
        409,
      );

      expect(
        await call(server, { method: 'get', path: '/loyalty/me', token }, 200),
      ).toMatchObject({
        pointsBalance: 426,
        lifetimePoints: 526,
        tier: 'BRONZE',
      });
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'lets only one of two simultaneous checkouts take the same voucher',
    async () => {
      const server = app.getHttpServer();
      const credentials = {
        email: 'dewi@example.com',
        password: 'correct horse battery',
      };

      await call(
        server,
        {
          method: 'post',
          path: '/auth/register',
          body: { name: 'Dewi Lestari', ...credentials },
        },
        201,
      );
      const token = textAt(
        await call(
          server,
          { method: 'post', path: '/auth/login', body: credentials },
          200,
        ),
        'accessToken',
      );
      const shelfStock = async () =>
        numberAt(
          await call(
            server,
            { method: 'get', path: '/stores/str_1/products/prd_6' },
            200,
          ),
          'stock',
        );
      const voucherUsage = async () =>
        listOf(
          await call(
            server,
            { method: 'get', path: '/vouchers/mine', token },
            200,
          ),
        ).find((voucher) => textAt(voucher, 'code') === 'WELCOME10');
      const stockBefore = await shelfStock();

      // Two screen protectors, Rp 118.000, clear WELCOME10's Rp 100.000
      // minimum. Both requests are in flight at once.
      const checkout = () =>
        request(server)
          .post('/orders/checkout')
          .set('Authorization', `Bearer ${token}`)
          .send({
            storeId: 'str_1',
            items: [{ productId: 'prd_6', quantity: 2 }],
            voucherCode: 'WELCOME10',
          });
      const responses = await Promise.all([checkout(), checkout()]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      const winner: unknown = responses.find(
        (response) => response.status === 201,
      )?.body;
      const winningOrderId = textAt(winner, 'order.id');

      // Only the winner's units left the shelf, and only it holds the voucher.
      expect(await shelfStock()).toBe(stockBefore - 2);
      expect(await voucherUsage()).toMatchObject({
        usage: { status: 'RESERVED', orderId: winningOrderId },
      });

      // Cancelling the winner frees the voucher and puts its units back.
      await call(
        server,
        {
          method: 'post',
          path: `/orders/${winningOrderId}/cancel`,
          token,
        },
        200,
      );
      expect(await shelfStock()).toBe(stockBefore);
      expect(await voucherUsage()).toMatchObject({
        usage: { status: 'AVAILABLE' },
      });
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'keeps three related products still sold, however many archived ones rank above them',
    async () => {
      const server = app.getHttpServer();
      // A seed customer, signing in with the published demo-only password.
      const token = textAt(
        await call(
          server,
          {
            method: 'post',
            path: '/auth/login',
            body: { email: 'budi@example.com', password: 'shop-demo-password' },
          },
          200,
        ),
        'accessToken',
      );
      const relatedTo = async (productId: string) =>
        listOf(
          at(
            await call(
              server,
              { method: 'get', path: `/products/${productId}` },
              200,
            ),
            'frequentlyBoughtTogether',
          ),
        ).map((related) => textAt(related, 'productId'));

      // The charger leads; the rest share one order each, ranked by id.
      expect(await relatedTo('prd_1')).toEqual(['prd_2', 'prd_3', 'prd_5']);

      await call(
        server,
        { method: 'delete', path: '/products/prd_3', token },
        200,
      );

      expect(await relatedTo('prd_1')).toEqual(['prd_2', 'prd_5', 'prd_6']);

      // More archived products than the old pool of ten, each bought with the
      // cable twice — more often than prd_5 or prd_6 — so all of them rank
      // above the products still sold. The seed catalogue is too small for
      // this, so the products are made here.
      const bundle = await Promise.all(
        Array.from({ length: 11 }, (_, index) =>
          call(
            server,
            {
              method: 'post',
              path: '/products',
              token,
              body: {
                sku: `BUNDLE-${index}`,
                name: `Bundle item ${index}`,
                description: 'Bought with the cable, then discontinued.',
                category: 'charging',
              },
            },
            201,
          ),
        ),
      );
      const bundleIds = bundle.map((product) => textAt(product, 'id'));
      await Promise.all(
        bundleIds.map((productId) =>
          call(
            server,
            {
              method: 'put',
              path: `/stores/str_1/products/${productId}`,
              token,
              body: { price: 10_000, stock: 10 },
            },
            200,
          ),
        ),
      );
      for (let round = 0; round < 2; round += 1) {
        const checkout = await call(
          server,
          {
            method: 'post',
            path: '/orders/checkout',
            token,
            body: {
              storeId: 'str_1',
              items: ['prd_1', ...bundleIds].map((productId) => ({
                productId,
                quantity: 1,
              })),
            },
          },
          201,
        );
        await call(
          server,
          {
            method: 'post',
            path: `/payments/bills/${textAt(checkout, 'bill.id')}/simulate-pay`,
            token,
          },
          200,
        );
      }
      await Promise.all(
        bundleIds.map((productId) =>
          call(
            server,
            { method: 'delete', path: `/products/${productId}`, token },
            200,
          ),
        ),
      );

      expect(await relatedTo('prd_1')).toEqual(['prd_2', 'prd_5', 'prd_6']);
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'serves the shop graph, both of its loops included, to a caller holding the inspector token',
    async () => {
      // The graph endpoint is token gated, and the token is held by the
      // inspector running inside this application.
      const accessToken = app.get(AccessTokenService, { strict: false });

      const graphResponse = await request('http://localhost:53371')
        .get('/__graph-inspector/output.json')
        .set('Authorization', `Bearer ${accessToken.current()}`)
        .expect('content-type', /json/)
        .expect(200);

      const graph: unknown = graphResponse.body;

      expect(graph).toMatchObject({ root: 'AppModule' });

      // The import graph the demo is built around. DatabaseModule is global:
      // Nest adds it to every module's imports by itself, so it is left out.
      const featureImports: Record<string, string[]> = {
        AuthModule: ['CustomerModule'],
        CustomerModule: [],
        CustomerLoyaltyModule: ['CustomerModule'],
        OrderModule: [
          'CustomerLoyaltyModule',
          'PaymentModule',
          'StoreProductModule',
          'VoucherModule',
        ],
        PaymentModule: ['OrderModule'],
        ProductModule: ['RecommendationModule'],
        RecommendationModule: ['OrderModule'],
        StoreModule: [],
        StoreProductModule: ['ProductModule', 'StoreModule'],
        VoucherModule: ['CustomerLoyaltyModule'],
      };

      expect(textsOf(at(graph, 'modules.AppModule.imports')).sort()).toEqual(
        ['DatabaseModule', ...Object.keys(featureImports)].sort(),
      );

      for (const [moduleName, imports] of Object.entries(featureImports)) {
        expect({
          moduleName,
          imports: textsOf(at(graph, `modules.${moduleName}.imports`))
            .filter((imported) => imported !== 'DatabaseModule')
            .sort(),
        }).toEqual({ moduleName, imports });
      }

      expect(
        listOf(at(graph, 'modules.AuthModule.providers')).map((provider) =>
          textAt(provider, 'name'),
        ),
      ).toContain('AuthGuard');

      // Both loops, at module level and between the services that close them.
      const moduleLoops = listOf(at(graph, 'cycles.modules')).map((cycle) =>
        describeLoop(textAt(cycle, 'type'), textsOf(at(cycle, 'path'))),
      );
      expect(moduleLoops.sort()).toEqual([
        'direct: OrderModule → PaymentModule → OrderModule',
        'indirect: OrderModule → StoreProductModule → ProductModule → RecommendationModule → OrderModule',
      ]);

      const providerLoops = listOf(at(graph, 'cycles.providers')).map((cycle) =>
        describeLoop(
          textAt(cycle, 'type'),
          listOf(at(cycle, 'path')).map(
            (item) =>
              `${textAt(item, 'module.name')}:${textAt(item, 'provider.name')}`,
          ),
        ),
      );
      expect(providerLoops.sort()).toEqual([
        'direct: OrderModule:OrderService → PaymentModule:PaymentService → OrderModule:OrderService',
        'indirect: OrderModule:OrderService → StoreProductModule:StoreProductService → ProductModule:ProductService → RecommendationModule:RecommendationService → OrderModule:OrderService',
      ]);
    },
    FLOW_TIMEOUT_MS,
  );
});
