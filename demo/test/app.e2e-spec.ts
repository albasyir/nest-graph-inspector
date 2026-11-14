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

type Method = 'get' | 'post';

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
