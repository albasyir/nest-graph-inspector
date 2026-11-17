import { Injectable } from '@nestjs/common';
import type { CredentialRow, SessionRow } from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';

/** Reads and writes the credentials and sessions tables. */
@Injectable()
export class AuthRepository {
  private readonly credentials: InMemoryTable<CredentialRow>;
  private readonly sessions: InMemoryTable<SessionRow>;

  constructor(database: DatabaseService) {
    this.credentials = database.credentials;
    this.sessions = database.sessions;
  }

  findCredential(customerId: string): Promise<CredentialRow | null> {
    return this.credentials.findOne(
      (credential) => credential.customerId === customerId,
    );
  }

  /** @throws UniqueConstraintViolationError when the customer already has one */
  insertCredential(
    credential: Pick<CredentialRow, 'customerId' | 'passwordHash'>,
  ): Promise<CredentialRow> {
    return this.credentials.insert((metadata) => ({
      ...metadata,
      ...credential,
    }));
  }

  findSessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    return this.sessions.findOne((session) => session.tokenHash === tokenHash);
  }

  insertSession(
    session: Pick<SessionRow, 'customerId' | 'tokenHash' | 'expiresAt'>,
  ): Promise<SessionRow> {
    return this.sessions.insert((metadata) => ({ ...metadata, ...session }));
  }

  deleteSession(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }
}
