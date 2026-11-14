import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CustomerLoyaltyService } from '../customer-loyalty/customer-loyalty.service';
import type {
  CancelledOrderRow,
  OrderLine,
  PaidOrderRow,
  PendingPaymentOrderRow,
} from '../database/database.schema';
import { PaymentService } from '../payment/payment.service';
import { MAX_QUANTITY } from '../store-product/store-product.dto';
import { StoreProductService } from '../store-product/store-product.service';
import type { VoucherQuote, VoucherRedemption } from '../voucher/voucher.dto';
import { VoucherService } from '../voucher/voucher.service';
import { priceLine, priceOrder, subtotalOf } from './order-pricing';
import { assertPendingPayment, toCancelled, toPaid } from './order-state';
import {
  type CheckoutItem,
  type CheckoutRequest,
  type CheckoutResult,
  type CustomerOrderRef,
  MAX_CHECKOUT_ITEMS,
  type Order,
  type OrderCancellation,
  type PurchasedBasket,
} from './order.dto';
import { OrderRepository } from './order.repository';

/**
 * Orders, from checkout to payment.
 *
 * Checkout checks the store has the stock, prices the cart at its shelf
 * prices, takes off a voucher and then the loyalty-tier discount, reserves
 * the stock, records the order as PENDING_PAYMENT and has PaymentService
 * raise a bill — undoing the earlier steps if a later one fails. Paying the
 * bill marks the order PAID, spending the voucher and crediting points; a
 * failed payment or a change of mind cancels it and puts the stock back.
 *
 * PaymentService is injected through forwardRef(): it calls back into this
 * service, so the two modules import each other.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly orders: OrderRepository,
    private readonly storeProducts: StoreProductService,
    private readonly vouchers: VoucherService,
    private readonly loyalty: CustomerLoyaltyService,
    @Inject(forwardRef(() => PaymentService))
    private readonly payments: PaymentService,
  ) {}

  /**
   * Checks out a cart at one store and raises its bill.
   *
   * @throws BadRequestException when the cart breaks an order rule, or the
   * voucher's minimum spend is not met
   * @throws NotFoundException when the store, a product or the voucher does
   * not exist, or the store does not sell a product
   * @throws ConflictException when stock runs short, the store is closed, or
   * the voucher is used or held by another unpaid order
   */
  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    assertCheckoutItems(request.items);

    const lines = await Promise.all(
      request.items.map((item) => this.priceInStock(request.storeId, item)),
    );
    const subtotal = subtotalOf(lines);
    const voucher =
      request.voucherCode === undefined
        ? null
        : await this.quoteVoucher({
            customerId: request.customerId,
            code: request.voucherCode,
            subtotal,
          });
    const tier = await this.loyalty.getTierDiscount(request.customerId);
    const pricing = priceOrder({
      subtotal,
      voucherDiscount: voucher?.discountAmount ?? 0,
      tierDiscountPercent: tier.percent,
    });

    await this.reserveStock(request.storeId, request.items);

    let order: PendingPaymentOrderRow;
    try {
      order = await this.orders.insertPending({
        customerId: request.customerId,
        storeId: request.storeId,
        lines,
        pricing,
        voucher: voucher
          ? { voucherId: voucher.voucherId, code: voucher.code }
          : null,
        loyaltyTier: tier.tier,
        tierDiscountPercent: tier.percent,
      });
    } catch (error) {
      await this.releaseAfterFailure(request.storeId, request.items);
      throw error;
    }

    try {
      const bill = await this.payments.createBill({
        orderId: order.id,
        customerId: order.customerId,
        amount: pricing.total,
      });

      return { order, bill };
    } catch (error) {
      await this.cancelOrder({
        orderId: order.id,
        reason: 'The bill could not be raised',
      });
      throw error;
    }
  }

  /**
   * Marks an order paid: spends its voucher, records the points it earns and
   * credits them to the customer. PaymentService calls this once the bill
   * is paid.
   *
   * @throws NotFoundException when there is no such order
   * @throws ConflictException when the order is not waiting for payment, or
   * its voucher was spent elsewhere in the meantime
   */
  async markPaid(orderId: string): Promise<PaidOrderRow> {
    const order = await this.requireOrder(orderId);
    assertPendingPayment(order, 'paid');

    const redemption: VoucherRedemption | null = order.voucher
      ? {
          voucherId: order.voucher.voucherId,
          customerId: order.customerId,
          orderId,
        }
      : null;
    if (redemption) {
      await this.vouchers.markUsed(redemption);
    }

    const pointsEarned = this.loyalty.pointsEarnedFor(order.pricing.total);
    let paid: PaidOrderRow;
    try {
      paid = await this.orders.transition(orderId, (current) =>
        toPaid(current, { paidAt: new Date().toISOString(), pointsEarned }),
      );
    } catch (error) {
      if (redemption) {
        await this.restoreVoucherAfterFailure(redemption);
      }
      throw error;
    }

    if (pointsEarned > 0) {
      await this.loyalty.addPoints({
        customerId: paid.customerId,
        points: pointsEarned,
      });
    }

    return paid;
  }

  /**
   * Cancels an order that is waiting for payment and puts its stock back.
   *
   * @throws NotFoundException when there is no such order
   * @throws ConflictException when the order is already paid or cancelled
   */
  async cancelOrder(
    cancellation: OrderCancellation,
  ): Promise<CancelledOrderRow> {
    const cancelled = await this.orders.transition(
      cancellation.orderId,
      (current) =>
        toCancelled(current, {
          cancelledAt: new Date().toISOString(),
          cancelReason: cancellation.reason,
        }),
    );

    await this.releaseStock(cancelled.storeId, cancelled.lines);

    return cancelled;
  }

  /**
   * A customer calling off their own unpaid order: it is cancelled and its
   * bill withdrawn.
   *
   * @throws NotFoundException when the customer has no such order
   * @throws ConflictException when the order is already paid or cancelled
   */
  async cancelOrderForCustomer(
    ref: CustomerOrderRef,
  ): Promise<CancelledOrderRow> {
    await this.getOrderForCustomer(ref);

    const cancelled = await this.cancelOrder({
      orderId: ref.orderId,
      reason: 'Cancelled by the customer',
    });
    await this.payments.voidBillForOrder(ref.orderId);

    return cancelled;
  }

  /**
   * One of a customer's orders. Another customer's order is reported as not
   * found rather than forbidden, so ids reveal nothing.
   *
   * @throws NotFoundException when the customer has no such order
   */
  async getOrderForCustomer(ref: CustomerOrderRef): Promise<Order> {
    const order = await this.orders.findById(ref.orderId);

    if (!order || order.customerId !== ref.customerId) {
      throw new NotFoundException(`Order ${ref.orderId} not found`);
    }

    return order;
  }

  /** A customer's order history, newest first. */
  async listOrdersForCustomer(customerId: string): Promise<Order[]> {
    const orders = await this.orders.listByCustomer(customerId);

    return orders.reverse();
  }

  /**
   * Co-purchase data: what each paid order holding this product contained,
   * oldest first. RecommendationService ranks it.
   */
  async listPaidBasketsContaining(
    productId: string,
  ): Promise<PurchasedBasket[]> {
    const orders = await this.orders.listPaidContaining(productId);

    return orders.map((order) => ({
      orderId: order.id,
      lines: order.lines.map((line) => ({
        productId: line.productId,
        productName: line.productName,
      })),
    }));
  }

  private async requireOrder(orderId: string): Promise<Order> {
    const order = await this.orders.findById(orderId);

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    return order;
  }

  /** Checks the shelf has enough and prices the line at the shelf price. */
  private async priceInStock(
    storeId: string,
    item: CheckoutItem,
  ): Promise<OrderLine> {
    const stock = await this.storeProducts.checkStock({ storeId, ...item });

    if (!stock.available) {
      throw new ConflictException(
        `Only ${stock.listing.stock} of ${stock.listing.name} (${item.productId}) left at store ${storeId}; ${item.quantity} requested`,
      );
    }

    return priceLine({
      productId: stock.listing.productId,
      productName: stock.listing.name,
      unitPrice: stock.listing.price,
      quantity: item.quantity,
    });
  }

  /**
   * Quotes the voucher, refusing one this customer already has on an order
   * waiting for payment: it could only be spent once.
   */
  private async quoteVoucher(request: {
    readonly customerId: string;
    readonly code: string;
    readonly subtotal: number;
  }): Promise<VoucherQuote> {
    const quote = await this.vouchers.quoteDiscount(request);
    const pending = await this.orders.findPendingWithVoucher({
      customerId: request.customerId,
      voucherId: quote.voucherId,
    });

    if (pending) {
      throw new ConflictException(
        `Voucher ${quote.code} is already on order ${pending.id}, which is waiting for payment; pay or cancel that order first`,
      );
    }

    return quote;
  }

  /** Reserves every line at once; if any fails, the others are put back. */
  private async reserveStock(
    storeId: string,
    items: readonly CheckoutItem[],
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      items.map(async (item) => {
        await this.storeProducts.reserveStock({ storeId, ...item });

        return item;
      }),
    );
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');

    if (failure?.status === 'rejected') {
      const reserved = outcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled' ? [outcome.value] : [],
      );
      await this.releaseAfterFailure(storeId, reserved);
      throw failure.reason;
    }
  }

  private async releaseStock(
    storeId: string,
    items: readonly CheckoutItem[],
  ): Promise<void> {
    await Promise.all(
      items.map((item) =>
        this.storeProducts.releaseStock({
          storeId,
          productId: item.productId,
          quantity: item.quantity,
        }),
      ),
    );
  }

  /**
   * Puts stock back while another failure is already on its way to the
   * caller. A failure here is logged with the ids to repair it by, and the
   * original error is the one reported.
   */
  private async releaseAfterFailure(
    storeId: string,
    items: readonly CheckoutItem[],
  ): Promise<void> {
    try {
      await this.releaseStock(storeId, items);
    } catch (error) {
      this.logger.error(
        `Could not put back reserved stock at store ${storeId} for ${items.map((item) => `${item.productId}×${item.quantity}`).join(', ')}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Makes a voucher usable again after the order it was spent on failed to be paid. */
  private async restoreVoucherAfterFailure(
    redemption: VoucherRedemption,
  ): Promise<void> {
    try {
      await this.vouchers.releaseRedemption(redemption);
    } catch (error) {
      this.logger.error(
        `Could not restore voucher ${redemption.voucherId} after order ${redemption.orderId} failed to be paid`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** The rules a cart must keep before anything is priced or reserved. */
function assertCheckoutItems(items: readonly CheckoutItem[]): void {
  if (items.length === 0) {
    throw new BadRequestException('An order needs at least one item');
  }

  if (items.length > MAX_CHECKOUT_ITEMS) {
    throw new BadRequestException(
      `An order can hold at most ${MAX_CHECKOUT_ITEMS} different products`,
    );
  }

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.productId)) {
      throw new BadRequestException(
        `Product ${item.productId} appears twice; send it once with the total quantity`,
      );
    }
    seen.add(item.productId);

    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_QUANTITY
    ) {
      throw new BadRequestException(
        `The quantity of ${item.productId} must be a whole number between 1 and ${MAX_QUANTITY}`,
      );
    }
  }
}
