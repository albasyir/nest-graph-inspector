/**
 * A typed in-memory table: the storage engine behind every repository in the
 * demo.
 *
 * Every operation first awaits the latency the table was built with — one
 * simulated database round trip — and then runs synchronously. A read
 * therefore sees one consistent moment, and an `update` whose change function
 * checks the current row writes without anything slipping in between, the
 * way a conditional `UPDATE … WHERE` does.
 *
 * Stored rows are frozen: whatever a caller gets back cannot be changed
 * behind the table's back, only replaced through `update`.
 */

/** The columns every row carries and the table manages. */
export interface RowMetadata {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Columns whose combined values must be distinct across a table, like a
 * unique index: `['email']`, or `['storeId', 'productId']`.
 */
export type UniqueKey<T> = readonly (keyof T & string)[];

export interface InMemoryTableOptions<T extends RowMetadata> {
  /** The table's name, quoted in errors. */
  readonly name: string;
  /** Prefix of generated ids: `prd` makes `prd_1`, `prd_2`, … */
  readonly idPrefix: string;
  /** Awaited before every operation: the simulated round trip. */
  readonly latency: () => Promise<void>;
  readonly uniqueKeys?: readonly UniqueKey<T>[];
  /** Rows the table starts with. Their ids must follow `<idPrefix>_<n>`. */
  readonly seed?: readonly T[];
}

/** Raised when a write would give two rows the same value for a unique key. */
export class UniqueConstraintViolationError extends Error {
  constructor(
    readonly table: string,
    readonly columns: readonly string[],
  ) {
    super(`Duplicate value for ${table} (${columns.join(', ')})`);
    this.name = new.target.name;
  }
}

export class InMemoryTable<T extends RowMetadata> {
  private readonly rows = new Map<string, T>();
  private lastSequence = 0;

  constructor(private readonly options: InMemoryTableOptions<T>) {
    for (const row of options.seed ?? []) {
      if (this.rows.has(row.id)) {
        throw new Error(`${options.name}: seed id "${row.id}" appears twice`);
      }

      this.lastSequence = Math.max(this.lastSequence, this.sequenceOf(row.id));
      this.assertUnique(row);
      this.rows.set(row.id, deepFreeze(row));
    }
  }

  /** The row with this id, or `null`. */
  async findById(id: string): Promise<T | null> {
    await this.options.latency();

    return this.rows.get(id) ?? null;
  }

  /** The first row, in insertion order, that the predicate accepts. */
  async findOne(predicate: (row: T) => boolean): Promise<T | null> {
    await this.options.latency();

    for (const row of this.rows.values()) {
      if (predicate(row)) {
        return row;
      }
    }

    return null;
  }

  /**
   * Every row the predicate accepts — every row without one — in insertion
   * order. A type-guard predicate narrows the rows it returns.
   */
  findMany<S extends T>(predicate: (row: T) => row is S): Promise<S[]>;
  findMany(predicate?: (row: T) => boolean): Promise<T[]>;
  async findMany(predicate: (row: T) => boolean = () => true): Promise<T[]> {
    await this.options.latency();

    return [...this.rows.values()].filter(predicate);
  }

  /**
   * Inserts the row `build` makes, under a newly generated id and the current
   * time; whatever `build` puts in those columns is overwritten. The row keeps
   * the type `build` returned, so inserting one variant of a union hands back
   * that variant.
   *
   * @throws UniqueConstraintViolationError when a unique key is already taken
   */
  async insert<N extends T>(build: (metadata: RowMetadata) => N): Promise<N> {
    await this.options.latency();

    const now = new Date().toISOString();
    const metadata: RowMetadata = {
      id: `${this.options.idPrefix}_${this.lastSequence + 1}`,
      createdAt: now,
      updatedAt: now,
    };
    const row: N = { ...build(metadata), ...metadata };

    this.assertUnique(row);
    this.lastSequence += 1;
    this.rows.set(row.id, deepFreeze(row));

    return row;
  }

  /**
   * Replaces a row with what `change` makes of it, keeping its id and
   * creation time and stamping `updatedAt`. The check and the write happen
   * together: throw from `change` to refuse the update, and nothing is
   * written. The stored row keeps the type `change` returned, so a change
   * that moves a row to one variant of a union hands back that variant.
   *
   * @returns the stored row, or `null` when no row has this id
   * @throws UniqueConstraintViolationError when a unique key is already taken
   */
  async update<N extends T>(
    id: string,
    change: (current: T) => N,
  ): Promise<N | null> {
    await this.options.latency();

    const current = this.rows.get(id);
    if (!current) {
      return null;
    }

    const next: N = {
      ...change(current),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.assertUnique(next);
    this.rows.set(id, deepFreeze(next));

    return next;
  }

  /** Deletes the row with this id; `false` when there was none. */
  async delete(id: string): Promise<boolean> {
    await this.options.latency();

    return this.rows.delete(id);
  }

  private sequenceOf(id: string): number {
    const prefix = `${this.options.idPrefix}_`;
    const sequence = Number(id.slice(prefix.length));

    if (
      !id.startsWith(prefix) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      throw new Error(
        `${this.options.name}: seed id "${id}" must look like ${prefix}<n>`,
      );
    }

    return sequence;
  }

  private assertUnique(candidate: T): void {
    for (const columns of this.options.uniqueKeys ?? []) {
      const value = uniqueValue(candidate, columns);

      for (const row of this.rows.values()) {
        if (row.id !== candidate.id && uniqueValue(row, columns) === value) {
          throw new UniqueConstraintViolationError(this.options.name, columns);
        }
      }
    }
  }
}

function uniqueValue<T>(row: T, columns: UniqueKey<T>): string {
  return JSON.stringify(columns.map((column) => row[column]));
}

function deepFreeze<V>(value: V): V {
  freezeNested(value);

  return value;
}

function freezeNested(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    freezeNested(nested);
  }
}
