import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { NewStore, Store, StoreChanges } from './store.dto';
import { StoreRepository } from './store.repository';

/**
 * The shop's locations: opening, renaming and closing stores.
 *
 * A store is closed rather than deleted, because its shelves and its orders
 * still point at it. StoreProduct asks here whether a store is open before
 * it lists or sells anything there.
 */
@Injectable()
export class StoreService {
  constructor(private readonly stores: StoreRepository) {}

  /** Every store that is open, in the order they opened. */
  listStores(): Promise<Store[]> {
    return this.stores.listOpen();
  }

  /**
   * One store, open or closed.
   *
   * @throws NotFoundException when there is no store with this id
   */
  async getStore(storeId: string): Promise<Store> {
    const store = await this.stores.findById(storeId);

    if (!store) {
      throw new NotFoundException(`Store ${storeId} not found`);
    }

    return store;
  }

  /**
   * A store that is still trading.
   *
   * @throws NotFoundException when there is no store with this id
   * @throws ConflictException when the store has closed
   */
  async getOpenStore(storeId: string): Promise<Store> {
    const store = await this.getStore(storeId);

    if (store.closedAt !== null) {
      throw new ConflictException(`Store ${storeId} is closed`);
    }

    return store;
  }

  /** Opens a store. */
  createStore(store: NewStore): Promise<Store> {
    return this.stores.insert(store);
  }

  /**
   * Renames a store or moves it to another city.
   *
   * @throws NotFoundException when there is no store with this id
   */
  async updateStore(storeId: string, changes: StoreChanges): Promise<Store> {
    const store = await this.stores.update(storeId, (current) => ({
      ...current,
      name: changes.name ?? current.name,
      city: changes.city ?? current.city,
    }));

    if (!store) {
      throw new NotFoundException(`Store ${storeId} not found`);
    }

    return store;
  }

  /**
   * Closes a store: it disappears from listings and stops selling.
   *
   * @throws NotFoundException when there is no store with this id
   * @throws ConflictException when it is already closed
   */
  async closeStore(storeId: string): Promise<Store> {
    const store = await this.stores.update(storeId, (current) => {
      if (current.closedAt !== null) {
        throw new ConflictException(`Store ${storeId} is already closed`);
      }

      return { ...current, closedAt: new Date().toISOString() };
    });

    if (!store) {
      throw new NotFoundException(`Store ${storeId} not found`);
    }

    return store;
  }
}
