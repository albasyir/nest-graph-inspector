import { Injectable } from '@nestjs/common';
import type { StoreRow } from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';
import type { NewStore } from './store.dto';

/** Reads and writes the stores table. */
@Injectable()
export class StoreRepository {
  private readonly stores: InMemoryTable<StoreRow>;

  constructor(database: DatabaseService) {
    this.stores = database.stores;
  }

  findById(storeId: string): Promise<StoreRow | null> {
    return this.stores.findById(storeId);
  }

  listOpen(): Promise<StoreRow[]> {
    return this.stores.findMany((store) => store.closedAt === null);
  }

  insert(store: NewStore): Promise<StoreRow> {
    return this.stores.insert((metadata) => ({
      ...metadata,
      ...store,
      closedAt: null,
    }));
  }

  /** Replaces a store with what `change` makes of it; `null` when there is none. */
  update<N extends StoreRow>(
    storeId: string,
    change: (current: StoreRow) => N,
  ): Promise<N | null> {
    return this.stores.update(storeId, change);
  }
}
