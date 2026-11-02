import {
  BeforeApplicationShutdown,
  forwardRef,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { FixtureAuditService } from "./audit.service";
import { recordFixtureCall } from "./fixture-calls";
import { FIXTURE_SETTINGS, FixtureSettings } from "./settings.module";
import {
  FIXTURE_DATABASE,
  FixtureDatabaseConnection,
  FixtureStorageClient,
} from "./storage.module";

/**
 * Keeps documents, and tells the audit trail about every change.
 */
@Injectable()
export class FixtureDocumentService
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  @Inject(FIXTURE_SETTINGS)
  private readonly settings!: FixtureSettings;

  constructor(
    private readonly storage: FixtureStorageClient,
    @Inject(FIXTURE_DATABASE)
    private readonly database: FixtureDatabaseConnection,
    @Inject(forwardRef(() => FixtureAuditService))
    private readonly audit: FixtureAuditService,
  ) {
    recordFixtureCall("FixtureDocumentService.constructor");
  }

  onModuleInit(): void {
    recordFixtureCall("FixtureDocumentService.onModuleInit");
  }

  onApplicationBootstrap(): void {
    recordFixtureCall("FixtureDocumentService.onApplicationBootstrap");
  }

  onModuleDestroy(): void {
    recordFixtureCall("FixtureDocumentService.onModuleDestroy");
  }

  beforeApplicationShutdown(): void {
    recordFixtureCall("FixtureDocumentService.beforeApplicationShutdown");
  }

  onApplicationShutdown(): void {
    recordFixtureCall("FixtureDocumentService.onApplicationShutdown");
  }

  save(name: string, content: string): string {
    this.audit.record(`save ${name} in ${this.settings.region}`);
    this.database.query(`insert ${name}`);
    return this.storage.upload(name, content);
  }
}
