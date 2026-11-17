import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * The shop's storage: in-memory tables that start out holding the seed data,
 * with every read and write paying a simulated 100–200 ms round trip.
 *
 * Global, so each feature module's repository injects DatabaseService without
 * listing this module among its imports. There is no database server: the
 * application starts with nothing else running.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
