import { ConflictException } from '@nestjs/common';
import { UniqueConstraintViolationError } from '../database/in-memory-table';

/**
 * Awaits a write and answers a unique-key violation with a 409 carrying
 * `message`. Any other failure is rethrown untouched.
 */
export async function orConflict<T>(
  write: Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof UniqueConstraintViolationError) {
      throw new ConflictException(message);
    }

    throw error;
  }
}
