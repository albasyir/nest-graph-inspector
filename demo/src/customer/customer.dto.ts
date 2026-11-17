import { BadRequestException } from '@nestjs/common';
import {
  optionalNullableText,
  optionalText,
  parseJsonObject,
} from '../common/request-parsing';
import type { CustomerRow } from '../database/database.schema';

/** A customer as the shop shows it. It holds no credentials. */
export type Customer = CustomerRow;

/** What it takes to register a customer. */
export type NewCustomer = Pick<CustomerRow, 'name' | 'email' | 'phone'>;

/** A profile update; a field left out stays as it is, `phone: null` clears it. */
export type CustomerProfileChanges = Partial<
  Pick<CustomerRow, 'name' | 'phone'>
>;

const PHONE_PATTERN = /^\+?[0-9]{6,15}$/;

/** Reads `PATCH /customers/me`'s body. */
export function parseCustomerProfileChanges(
  body: unknown,
): CustomerProfileChanges {
  const source = parseJsonObject(body);
  const name = optionalText(source, 'name', { maxLength: 100 });
  const phone = optionalNullableText(source, 'phone', { maxLength: 16 });

  if (name === undefined && phone === undefined) {
    throw new BadRequestException('Send at least one of: name, phone');
  }

  if (typeof phone === 'string' && !PHONE_PATTERN.test(phone)) {
    throw new BadRequestException(
      'phone must be 6 to 15 digits, optionally starting with +',
    );
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(phone === undefined ? {} : { phone }),
  };
}
