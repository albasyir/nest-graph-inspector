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
  OrderRow,
  PaidOrderRow,
  PendingPaymentOrderRow,
} from '../database/database.schema';
import { PaymentService } from '../payment/payment.service';
import { MAX_QUANTITY } from '../store-product/store-product.dto';
import { StoreProductService } from '../store-product/store-product.service';
import type { VoucherOnOrder } from '../voucher/voucher.dto';
import { VoucherService } from '../voucher/voucher.service';
import { priceLine, priceOrder, subtotalOf } from './order-pricing';
import { toCancelled, toPaid } from './order-state';
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
import { type NewPendingOrder, OrderRepository } from './order.repository';

/**
 * Orders, from checkout to payment.
 *
 * Checkout checks the store has the stock, prices the cart at its shelf
 * prices, takes off a voucher and then the loyalty-tier discount, reserves
 * the stock, records the order as PENDING_PAYMENT, reserves its voucher and
 * has PaymentService raise a bill — undoing the earlier steps if a later one
 * fails. Paying the bill marks the order PAID, spending the voucher and
 * crediting points; a failed payment or a change of mind cancels it, putting
 * the stock back and freeing the voucher.
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
   * the voucher is used or on another order — two checkouts racing for one
   * voucher both get this far, and the one that loses is cancelled
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
        : await this.vouchers.quoteDiscount({
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

    const order = await this.recordPendingOrder({
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

    const hold = voucherOnOrder(order);
    if (hold) {
      await this.undoCheckoutOnFailure(
        order.id,
        'Its voucher could not be reserved',
        () => this.vouchers.reserve(hold),
      );
    }

    const bill = await this.undoCheckoutOnFailure(
      order.id,
      'Its bill could not be raised',
      () =>
        this.payments.createBill({
          orderId: order.id,
          customerId: order.customerId,
          amount: order.pricing.total,
        }),
    );

    return { order, bill };
  }

  /**
   * Marks an order paid — checked and written in one step, so an order is
   * paid at most once — then spends its voucher and credits the points it
   * earned. PaymentService calls this once the bill is paid.
   *
   * @throws NotFoundException when there is no such order
   * @throws ConflictException when the order is not waiting for payment
   */
  async markPaid(orderId: string): Promise<PaidOrderRow> {
    const paid = await this.orders.transition(orderId, (current) =>
      toPaid(current, {
        paidAt: new Date().toISOString(),
        pointsEarned: this.loyalty.pointsEarnedFor(current.pricing.total),
      }),
    );

    const hold = voucherOnOrder(paid);
    if (hold) {
      await this.spendVoucherOfPaidOrder(hold);
    }

    if (paid.pointsEarned > 0) {
      await this.loyalty.addPoints({
        customerId: paid.customerId,
        points: paid.pointsEarned,
      });
    }

    return paid;
  }

  /**
   * Cancels an order that is waiting for payment, putting its stock back and
   * freeing its voucher.
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

    const hold = voucherOnOrder(cancelled);
    if (hold) {
      await this.vouchers.release(hold);
    }

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

  /** Records a checked-out order, putting its stock back if that fails. */
  private async recordPendingOrder(
    order: NewPendingOrder,
  ): Promise<PendingPaymentOrderRow> {
    try {
      return await this.orders.insertPending(order);
    } catch (error) {
      await this.releaseAfterFailure(order.storeId, order.lines);
      throw error;
    }
  }

  /**
   * Runs one of the last steps of a checkout. If it fails, the order is
   * cancelled — its stock put back and its voucher freed — and the step's own
   * error is the one reported; a failure to cancel is logged with the id.
   */
  private async undoCheckoutOnFailure<T>(
    orderId: string,
    reason: string,
    step: () => Promise<T>,
  ): Promise<T> {
    try {
      return await step();
    } catch (error) {
      try {
        await this.cancelOrder({ orderId, reason });
      } catch (cancelError) {
        this.logger.error(
          `Could not cancel order ${orderId} after its checkout failed`,
          cancelError instanceof Error
            ? cancelError.stack
            : String(cancelError),
        );
      }
      throw error;
    }
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

  /**
   * Spends the voucher of an order that is already paid. The order holds it
   * alone, so this does not fail in practice; if it does, the voucher stays
   * held — still never usable twice — and, since the payment itself went
   * through, the failure is logged with the ids rather than undoing it.
   */
  private async spendVoucherOfPaidOrder(hold: VoucherOnOrder): Promise<void> {
    try {
      await this.vouchers.markUsed(hold);
    } catch (error) {
      this.logger.error(
        `Could not mark voucher ${hold.voucherId} used by paid order ${hold.orderId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** The voucher an order was checked out with, as the voucher module tracks it. */
function voucherOnOrder(order: OrderRow): VoucherOnOrder | null {
  return order.voucher
    ? {
        voucherId: order.voucher.voucherId,
        code: order.voucher.code,
        customerId: order.customerId,
        orderId: order.id,
      }
    : null;
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
