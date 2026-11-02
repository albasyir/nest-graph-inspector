import {
  ConfigurableModuleBuilder,
  DynamicModule,
  Inject,
  Injectable,
  Module,
} from "@nestjs/common";
import { recordFixtureCall } from "./fixture-calls";
import { FIXTURE_SETTINGS, FixtureSettings } from "./settings.module";

export const FIXTURE_DATABASE = "FIXTURE_DATABASE";
export const FIXTURE_STORAGE_DEFAULTS = "FIXTURE_STORAGE_DEFAULTS";
export const FIXTURE_STORAGE_ALIAS = "FIXTURE_STORAGE_ALIAS";

/**
 * A database connection: opening one is what an export must never do.
 */
export class FixtureDatabaseConnection {
  constructor(readonly region: string) {
    recordFixtureCall("FixtureDatabaseConnection.constructor");
  }

  query(sql: string): string[] {
    return [`${this.region}: ${sql}`];
  }
}

/** Opens the connection `FIXTURE_DATABASE` provides. */
export function connectFixtureDatabase(
  settings: FixtureSettings,
): FixtureDatabaseConnection {
  recordFixtureCall("connectFixtureDatabase");
  return new FixtureDatabaseConnection(settings.region);
}

export type FixtureStorageOptions = { bucket: string };

export const {
  ConfigurableModuleClass: FixtureStorageConfigurableModule,
  MODULE_OPTIONS_TOKEN: FIXTURE_STORAGE_OPTIONS,
} = new ConfigurableModuleBuilder<FixtureStorageOptions>()
  .setClassMethodName("forRoot")
  .build();

/**
 * Uploads files to the configured bucket.
 */
@Injectable()
export class FixtureStorageClient {
  constructor(
    @Inject(FIXTURE_STORAGE_OPTIONS)
    private readonly options: FixtureStorageOptions,
  ) {
    recordFixtureCall("FixtureStorageClient.constructor");
  }

  upload(key: string, body: string): string {
    return `${this.options.bucket}/${key}:${body.length}`;
  }
}

/** Where stored files physically go. */
export abstract class FixtureStorageGateway {
  abstract put(key: string): string;
}

/**
 * Puts files in S3.
 */
@Injectable()
export class FixtureS3StorageGateway extends FixtureStorageGateway {
  constructor() {
    super();
    recordFixtureCall("FixtureS3StorageGateway.constructor");
  }

  put(key: string): string {
    return `s3://${key}`;
  }
}

/**
 * Stores files: a dynamic module built with `ConfigurableModuleBuilder` that
 * adds a provider of every custom kind to what its `forRoot()` registers.
 */
@Module({})
export class FixtureStorageModule extends FixtureStorageConfigurableModule {
  static forRoot(options: FixtureStorageOptions): DynamicModule {
    const dynamicModule = super.forRoot(options);

    return {
      ...dynamicModule,
      providers: [
        ...(dynamicModule.providers ?? []),
        FixtureStorageClient,
        { provide: FIXTURE_STORAGE_DEFAULTS, useValue: { retries: 3 } },
        {
          provide: FIXTURE_DATABASE,
          useFactory: connectFixtureDatabase,
          inject: [FIXTURE_SETTINGS],
        },
        { provide: FixtureStorageGateway, useClass: FixtureS3StorageGateway },
        { provide: FIXTURE_STORAGE_ALIAS, useExisting: FixtureStorageClient },
      ],
      exports: [
        FixtureStorageClient,
        FixtureStorageGateway,
        FIXTURE_DATABASE,
        FIXTURE_STORAGE_ALIAS,
      ],
    };
  }
}
