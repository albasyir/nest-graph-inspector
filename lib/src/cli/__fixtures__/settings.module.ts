import { Global, Module } from "@nestjs/common";

export const FIXTURE_SETTINGS = "FIXTURE_SETTINGS";

export type FixtureSettings = { region: string };

/**
 * Application-wide settings, available to every module without an import.
 */
@Global()
@Module({
  providers: [{ provide: FIXTURE_SETTINGS, useValue: { region: "eu-west-1" } }],
  exports: [FIXTURE_SETTINGS],
})
export class FixtureSettingsModule {}
