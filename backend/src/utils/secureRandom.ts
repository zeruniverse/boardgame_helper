import { randomBytes, randomInt } from 'crypto';

// crypto.randomInt() requires the requested range to be strictly below 2^48.
const MAX_RANDOM_INT_EXCLUSIVE = (2 ** 48) - 1;
const UNIT_INTERVAL_SIZE = 2 ** 48;

/**
 * Return a uniformly distributed integer in [0, maxExclusive) using Node's
 * cryptographically secure random source. Hidden-role/card assignment and
 * server-side random adjudication must not depend on Math.random().
 */
export function secureRandomIndex(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > MAX_RANDOM_INT_EXCLUSIVE) {
    throw new RangeError(`maxExclusive must be a positive safe integer <= ${MAX_RANDOM_INT_EXCLUSIVE}`);
  }
  return randomInt(maxExclusive);
}

/** Return one random item, or undefined for an empty collection. */
export function secureRandomItem<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[secureRandomIndex(items.length)];
}

/** Return a cryptographically secure random boolean. */
export function secureRandomBoolean(): boolean {
  return secureRandomIndex(2) === 1;
}

/**
 * Return a random number in [0, 1). Six random bytes provide an exact 48-bit
 * integer, which is then scaled into the unit interval without modulo bias.
 */
export function secureRandomUnit(): number {
  return randomBytes(6).readUIntBE(0, 6) / UNIT_INTERVAL_SIZE;
}

/** Fisher-Yates shuffle backed by crypto.randomInt(). */
export function secureShuffle<T>(array: readonly T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureRandomIndex(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Generate an opaque random string from an explicit alphabet. */
export function secureRandomString(length: number, alphabet: string): string {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('length must be a non-negative safe integer');
  }
  if (!alphabet) {
    throw new RangeError('alphabet must not be empty');
  }

  let result = '';
  for (let i = 0; i < length; i++) {
    result += alphabet[secureRandomIndex(alphabet.length)];
  }
  return result;
}
