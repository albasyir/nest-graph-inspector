import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentCustomerId } from '../common/current-customer.decorator';
import { Public } from '../common/public.decorator';
import {
  type Bill,
  type BillSettlement,
  parseGatewayCallback,
  parseSimulatedFailureBody,
} from './payment.dto';
import { PaymentService } from './payment.service';

/**
 * Bills and the simulated gateway. A customer reads and "pays" their own
 * bills; the gateway's callback is public, guarded by the bill's
 * unguessable gateway reference instead of a session.
 */
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /** `GET /payments/bills/:billId` — one of the signed-in customer's bills. */
  @Get('bills/:billId')
  getMyBill(
    @CurrentCustomerId() customerId: string,
    @Param('billId') billId: string,
  ): Promise<Bill> {
    return this.paymentService.getBillForCustomer({ billId, customerId });
  }

  /** `POST /payments/bills/:billId/simulate-pay` — pay a bill, simulated. */
  @Post('bills/:billId/simulate-pay')
  @HttpCode(HttpStatus.OK)
  simulatePay(
    @CurrentCustomerId() customerId: string,
    @Param('billId') billId: string,
  ): Promise<BillSettlement> {
    return this.paymentService.simulatePayment({ billId, customerId });
  }

  /** `POST /payments/bills/:billId/simulate-fail` — a declined payment, simulated. */
  @Post('bills/:billId/simulate-fail')
  @HttpCode(HttpStatus.OK)
  simulateFail(
    @CurrentCustomerId() customerId: string,
    @Param('billId') billId: string,
    @Body() body: unknown,
  ): Promise<BillSettlement> {
    return this.paymentService.simulateFailure({
      billId,
      customerId,
      ...parseSimulatedFailureBody(body),
    });
  }

  /** `POST /payments/callback` — the gateway reporting a payment's outcome. */
  @Public()
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  gatewayCallback(@Body() body: unknown): Promise<BillSettlement> {
    return this.paymentService.handleGatewayCallback(
      parseGatewayCallback(body),
    );
  }
}
