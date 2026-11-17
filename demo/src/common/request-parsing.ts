import { BadRequestException } from '@nestjs/common';

/**
 * Parsers for the edge of the application. Each turns part of the `unknown`
 * an HTTP request carries into a typed value, or answers with a 400 that
 * names the field and says what was wrong with it. Services trust what these
 * return and never check its shape again.
 */

interface FieldRules {
  /** How the field is named in an error; the key itself by default. */
  readonly label?: string;
}

interface TextRules extends FieldRules {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Strip surrounding whitespace first; on unless a value keeps it, like a password. */
  readonly trim?: boolean;
}

interface IntegerRules extends FieldRules {
  readonly min: number;
  readonly max: number;
}

interface ArrayRules extends FieldRules {
  readonly minLength: number;
  readonly maxLength: number;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A JSON value that must be an object, such as a request body. */
export function parseJsonObject(
  value: unknown,
  label = 'Request body',
): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be a JSON object`);
  }

  return value;
}

/** A required string, trimmed unless `rules.trim` is `false`. */
export function requireText(
  source: object,
  key: string,
  rules: TextRules = {},
): string {
  const label = rules.label ?? key;
  const value = readField(source, key);

  if (typeof value !== 'string') {
    throw new BadRequestException(`${label} must be a string`);
  }

  return checkText(label, rules.trim === false ? value : value.trim(), rules);
}

/** An optional string, trimmed; `undefined` when the field is absent. */
export function optionalText(
  source: object,
  key: string,
  rules: TextRules = {},
): string | undefined {
  return readField(source, key) === undefined
    ? undefined
    : requireText(source, key, rules);
}

/**
 * A string that may also be cleared: `undefined` when the field is absent,
 * `null` when it is sent as `null`.
 */
export function optionalNullableText(
  source: object,
  key: string,
  rules: TextRules = {},
): string | null | undefined {
  return readField(source, key) === null
    ? null
    : optionalText(source, key, rules);
}

/** A required email address, trimmed and lower-cased. */
export function requireEmail(source: object, key = 'email'): string {
  const email = requireText(source, key, { maxLength: 254 }).toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    throw new BadRequestException(`${key} must be an email address`);
  }

  return email;
}

/** A required whole number within `[min, max]`. */
export function requireInteger(
  source: object,
  key: string,
  rules: IntegerRules,
): number {
  const label = rules.label ?? key;
  const value = readField(source, key);

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestException(`${label} must be a whole number`);
  }

  if (value < rules.min || value > rules.max) {
    throw new BadRequestException(
      `${label} must be between ${rules.min} and ${rules.max}`,
    );
  }

  return value;
}

/** An optional whole number within `[min, max]`. */
export function optionalInteger(
  source: object,
  key: string,
  rules: IntegerRules,
): number | undefined {
  return readField(source, key) === undefined
    ? undefined
    : requireInteger(source, key, rules);
}

/** A required value that must be one of `allowed`. */
export function requireOneOf<T extends string>(
  source: object,
  key: string,
  allowed: readonly T[],
  rules: FieldRules = {},
): T {
  return oneOf(readField(source, key), rules.label ?? key, allowed);
}

/** An optional value that must be one of `allowed` when present. */
export function optionalOneOf<T extends string>(
  source: object,
  key: string,
  allowed: readonly T[],
): T | undefined {
  return readField(source, key) === undefined
    ? undefined
    : requireOneOf(source, key, allowed);
}

/** A query-string value that must be one of `allowed` when present. */
export function parseOptionalQuery<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
): T | undefined {
  return value === undefined ? undefined : oneOf(value, key, allowed);
}

/** A query-string whole number within `[min, max]` when present. */
export function parseOptionalIntegerQuery(
  value: unknown,
  key: string,
  rules: IntegerRules,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed =
    typeof value === 'string' && /^\d{1,9}$/.test(value)
      ? Number(value)
      : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < rules.min || parsed > rules.max) {
    throw new BadRequestException(
      `${key} must be a whole number between ${rules.min} and ${rules.max}`,
    );
  }

  return parsed;
}

/** A required array with a length within `[minLength, maxLength]`. */
export function requireArray(
  source: object,
  key: string,
  rules: ArrayRules,
): readonly unknown[] {
  const label = rules.label ?? key;
  const value = readField(source, key);

  if (!Array.isArray(value)) {
    throw new BadRequestException(`${label} must be an array`);
  }

  const items: readonly unknown[] = value;
  if (items.length < rules.minLength || items.length > rules.maxLength) {
    throw new BadRequestException(
      `${label} must hold between ${rules.minLength} and ${rules.maxLength} entries`,
    );
  }

  return items;
}

function oneOf<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  const match = allowed.find((option) => option === value);

  if (match === undefined) {
    throw new BadRequestException(
      `${label} must be one of: ${allowed.join(', ')}`,
    );
  }

  return match;
}

function checkText(label: string, text: string, rules: TextRules): string {
  const { minLength = 1, maxLength = 200 } = rules;

  if (text.length < minLength) {
    throw new BadRequestException(
      minLength === 1
        ? `${label} must not be empty`
        : `${label} must be at least ${minLength} characters`,
    );
  }

  if (text.length > maxLength) {
    throw new BadRequestException(
      `${label} must be at most ${maxLength} characters`,
    );
  }

  return text;
}

/** An own property of a parsed JSON object; inherited ones are ignored. */
function readField(source: object, key: string): unknown {
  if (!Object.hasOwn(source, key)) {
    return undefined;
  }

  const value: unknown = Reflect.get(source, key);

  return value;
}
