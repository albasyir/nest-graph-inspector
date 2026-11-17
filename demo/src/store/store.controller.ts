import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { parseNewStore, parseStoreChanges, type Store } from './store.dto';
import { StoreService } from './store.service';

/**
 * Store locations. Anyone may browse them; changing them takes a signed-in
 * account — in a real shop this would be staff only, which the demo does not
 * model.
 */
@Controller('stores')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  /** `GET /stores` — every open store. */
  @Public()
  @Get()
  listStores(): Promise<Store[]> {
    return this.storeService.listStores();
  }

  /** `GET /stores/:storeId` — one store, open or closed. */
  @Public()
  @Get(':storeId')
  getStore(@Param('storeId') storeId: string): Promise<Store> {
    return this.storeService.getStore(storeId);
  }

  /** `POST /stores` — open a store. */
  @Post()
  createStore(@Body() body: unknown): Promise<Store> {
    return this.storeService.createStore(parseNewStore(body));
  }

  /** `PATCH /stores/:storeId` — rename a store or change its city. */
  @Patch(':storeId')
  updateStore(
    @Param('storeId') storeId: string,
    @Body() body: unknown,
  ): Promise<Store> {
    return this.storeService.updateStore(storeId, parseStoreChanges(body));
  }

  /** `DELETE /stores/:storeId` — close a store; it is kept, not erased. */
  @Delete(':storeId')
  closeStore(@Param('storeId') storeId: string): Promise<Store> {
    return this.storeService.closeStore(storeId);
  }
}
