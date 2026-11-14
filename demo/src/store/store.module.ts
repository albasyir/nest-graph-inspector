import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreRepository } from './store.repository';
import { StoreService } from './store.service';

/**
 * Store locations. Imports no other feature module; StoreProduct builds on it
 * to know where a product is sold.
 */
@Module({
  controllers: [StoreController],
  providers: [StoreRepository, StoreService],
  exports: [StoreService],
})
export class StoreModule {}
