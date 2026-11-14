import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

interface ScryptParameters {
  /** CPU/memory cost, `N`. */
  readonly cost: number;
  /** Block size, `r`. */
  readonly blockSize: number;
  /** Parallelization, `p`. */
  readonly parallelization: number;
}

const DEFAULT_PARAMETERS: ScryptParameters = {
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
};
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/**
 * Hashes and checks passwords with scrypt from `node:crypto`, under a fresh
 * random salt per password.
 *
 * A stored hash names its own parameters — `scrypt$N$r$p$salt$hash`, salt
 * and hash in base64url — so it stays checkable after the defaults change.
 */
@Injectable()
export class PasswordHasher {
  /** A storable hash of `password`. */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(password, salt, KEY_BYTES, DEFAULT_PARAMETERS);

    return [
      'scrypt',
      DEFAULT_PARAMETERS.cost,
      DEFAULT_PARAMETERS.blockSize,
      DEFAULT_PARAMETERS.parallelization,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
  }

  /**
   * Whether `password` is the one `storedHash` was made from, compared in
   * constant time.
   *
   * @throws Error when `storedHash` is not in the format `hash` writes
   */
  async verify(password: string, storedHash: string): Promise<boolean> {
    const stored = parseStoredHash(storedHash);
    const key = await deriveKey(
      password,
      stored.salt,
      stored.key.length,
      stored.parameters,
    );

    return timingSafeEqual(key, stored.key);
  }
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function parseStoredHash(storedHash: string): {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly key: Buffer;
} {
  const [scheme, cost, blockSize, parallelization, salt, key, ...rest] =
    storedHash.split('$');
  const parameters: ScryptParameters = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
  };
  const parametersValid = Object.values(parameters).every(
    (value) => Number.isSafeInteger(value) && value > 0,
  );

  if (scheme !== 'scrypt' || !salt || !key || rest.length || !parametersValid) {
    throw new Error(
      'Stored password hash is not in the scrypt$N$r$p$salt$hash format',
    );
  }

  return {
    parameters,
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };
}
