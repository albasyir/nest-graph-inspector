import {
  Controller,
  forwardRef,
  Get,
  Inject,
  Injectable,
  Module,
} from "@nestjs/common";
import { FixtureDocumentService } from "./document.service";
import { FixtureDocumentsModule } from "./documents.module";
import { recordFixtureCall } from "./fixture-calls";

/**
 * Decides who may read which document.
 */
@Injectable()
export class FixtureAccountService {
  constructor(
    @Inject(forwardRef(() => FixtureDocumentService))
    private readonly documents: FixtureDocumentService,
  ) {
    recordFixtureCall("FixtureAccountService.constructor");
  }

  canRead(accountId: number, name: string): boolean {
    return accountId > 0 && name.length > 0;
  }
}

/**
 * Back office routes. The inspector's `ignore.paths` leaves them out.
 */
@Controller("admin")
export class FixtureAdminController {
  constructor(private readonly accounts: FixtureAccountService) {
    recordFixtureCall("FixtureAdminController.constructor");
  }

  @Get()
  list(): boolean {
    return this.accounts.canRead(1, "all");
  }
}

/**
 * Owns accounts; imports documents, and is imported back by them.
 */
@Module({
  imports: [forwardRef(() => FixtureDocumentsModule)],
  controllers: [FixtureAdminController],
  providers: [FixtureAccountService],
  exports: [FixtureAccountService],
})
export class FixtureAccountsModule {
  constructor() {
    recordFixtureCall("FixtureAccountsModule.constructor");
  }
}
