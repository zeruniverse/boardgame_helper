/**
 * Return the first explicitly supplied configuration value. Unlike `??`, an
 * explicit `null` is preserved so callers can use it for values such as
 * "unlimited" phase timers.
 */
export function getOwnConfigValue(
  config: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      return config[key];
    }
  }
  return undefined;
}

/**
 * Normalize a phase timer supplied by an untrusted Socket.IO payload.
 * `null` and `0` mean unlimited; only real finite numbers are accepted.
 */
export function normalizeDurationSeconds(
  value: unknown,
  fallback: number,
  maxSeconds = 3600
): number {
  const boundedFallback = Number.isFinite(fallback) && fallback >= 0
    ? Math.min(maxSeconds, Math.floor(fallback))
    : 0;
  if (value === undefined) return boundedFallback;
  if (value === null || value === 0) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return boundedFallback;
  }
  return Math.min(maxSeconds, Math.floor(value));
}

/** Normalize an integer without coercing strings, booleans, or null. */
export function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const clamp = (candidate: number): number => Math.max(min, Math.min(max, Math.floor(candidate)));
  const boundedFallback = Number.isFinite(fallback) ? clamp(fallback) : min;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return boundedFallback;
  }
  return clamp(value);
}

/** Only actual booleans are accepted from network configuration payloads. */
export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
