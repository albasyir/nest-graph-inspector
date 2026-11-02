import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { FixtureDocumentService } from "./document.service";
import { recordFixtureCall } from "./fixture-calls";

/**
 * Remembers who changed which document.
 */
@Injectable()
export class FixtureAuditService {
  constructor(
    @Inject(forwardRef(() => FixtureDocumentService))
    private readonly documents: FixtureDocumentService,
  ) {
    recordFixtureCall("FixtureAuditService.constructor");
  }

  record(event: string): string {
    return event;
  }

  replay(name: string): string {
    return this.documents.save(name, "");
  }
}
