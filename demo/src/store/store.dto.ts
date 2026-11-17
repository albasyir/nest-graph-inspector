import { BadRequestException } from '@nestjs/common';
import {
  optionalText,
  parseJsonObject,
  requireText,
} from '../common/request-parsing';
import type { StoreRow } from '../database/database.schema';

/** A store as the shop shows it; `closedAt` is set once it stops trading. */
export type Store = StoreRow;

/** What it takes to open a store. */
export type NewStore = Pick<StoreRow, 'name' | 'city'>;

/** A store update; a field left out stays as it is. */
export type StoreChanges = Partial<NewStore>;

/** Reads `POST /stores`'s body. */
export function parseNewStore(body: unknown): NewStore {
  const source = parseJsonObject(body);

  return {
    name: requireText(source, 'name', { maxLength: 100 }),
    city: requireText(source, 'city', { maxLength: 60 }),
  };
}

/** Reads `PATCH /stores/:storeId`'s body. */
export function parseStoreChanges(body: unknown): StoreChanges {
  const source = parseJsonObject(body);
  const name = optionalText(source, 'name', { maxLength: 100 });
  const city = optionalText(source, 'city', { maxLength: 60 });

  if (name === undefined && city === undefined) {
    throw new BadRequestException('Send at least one of: name, city');
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(city === undefined ? {} : { city }),
  };
}
