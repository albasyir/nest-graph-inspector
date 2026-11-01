import {
  Body,
  Controller,
  forwardRef,
  Get,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestModule,
  Param,
  Post,
} from "@nestjs/common";
import { FixtureAccountsModule } from "./accounts.module";
import { FixtureAuditService } from "./audit.service";
import { FixtureDocumentService } from "./document.service";
import { recordFixtureCall } from "./fixture-calls";
import { FixtureStorageModule } from "./storage.module";

/**
 * Counts things. The inspector's `ignore` option leaves it out of the graph.
 */
@Injectable()
export class FixtureMetricsService {
  constructor() {
    recordFixtureCall("FixtureMetricsService.constructor");
  }

  increment(name: string): number {
    return name.length;
  }
}

/**
 * Serves documents over HTTP.
 */
@Controller("documents")
export class FixtureDocumentController {
  constructor(private readonly documents: FixtureDocumentService) {
    recordFixtureCall("FixtureDocumentController.constructor");
  }

  @Get(":name")
  find(@Param("name") name: string): string {
    return name;
  }

  @Post()
  create(@Body() body: { name: string; content: string }): string {
    return this.documents.save(body.name, body.content);
  }
}

function fixtureRequestLogger(
  _request: unknown,
  _response: unknown,
  next: () => void,
): void {
  recordFixtureCall("fixtureRequestLogger");
  next();
}

/**
 * Owns documents and their audit trail.
 */
@Module({
  imports: [
    forwardRef(() => FixtureAccountsModule),
    FixtureStorageModule.forRoot({ bucket: "documents" }),
  ],
  controllers: [FixtureDocumentController],
  providers: [FixtureDocumentService, FixtureAuditService, FixtureMetricsService],
  exports: [FixtureDocumentService],
})
export class FixtureDocumentsModule implements NestModule {
  constructor() {
    recordFixtureCall("FixtureDocumentsModule.constructor");
  }

  configure(consumer: MiddlewareConsumer): void {
    recordFixtureCall("FixtureDocumentsModule.configure");
    consumer.apply(fixtureRequestLogger).forRoutes(FixtureDocumentController);
  }
}
