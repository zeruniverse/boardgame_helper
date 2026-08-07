const MAX_GAME_CONFIG_BYTES = 64 * 1024;
const MAX_GAME_ACTION_BYTES = 64 * 1024;
const MAX_GAME_ACTION_TYPE_LENGTH = 64;
const MAX_CONFIG_DEPTH = 8;
const MAX_CONFIG_ENTRIES = 1024;
const MAX_CONFIG_ARRAY_LENGTH = 128;
const MAX_CONFIG_STRING_LENGTH = 4096;

const TRANSPORT_ONLY_CONFIG_KEYS = new Set([
  'nickname',
  'playerId',
  'userId',
  'sessionToken',
  'roomId',
  'roomName',
  'gameType',
  'isPrivate',
  'socketId'
]);

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type JsonPrimitive = string | number | boolean | null;
type SanitizedJsonValue = JsonPrimitive | SanitizedJsonValue[] | { [key: string]: SanitizedJsonValue };

export type SanitizedGameConfigResult =
  | { success: true; config: Record<string, SanitizedJsonValue> }
  | { success: false; error: string };

export type NormalizedGameActionTypeResult =
  | { valid: true; actionType: string }
  | { valid: false; error: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getJsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : 0;
  } catch {
    return null;
  }
}

/**
 * 限制 Socket.IO 游戏行动负载，避免超大对象在线程间 structured clone、日志和广播中被反复放大。
 */
export function validateGameActionPayloadSize(value: unknown): { valid: true } | { valid: false; error: string } {
  const byteLength = getJsonByteLength(value);
  if (byteLength === null) {
    return { valid: false, error: '操作数据格式无效' };
  }
  if (byteLength > MAX_GAME_ACTION_BYTES) {
    return { valid: false, error: '操作数据过大' };
  }
  return { valid: true };
}

/**
 * Normalize the small routing key that selects a Worker action. The payload
 * size limit does not include actionType, so it needs its own bound before the
 * value is logged, copied into a worker_threads task and interpolated into
 * error messages.
 */
export function normalizeGameActionType(value: unknown): NormalizedGameActionTypeResult {
  if (typeof value !== 'string') {
    return { valid: false, error: '无效的操作类型' };
  }

  const actionType = value.trim();
  if (!actionType || /[\u0000-\u001F\u007F]/.test(actionType)) {
    return { valid: false, error: '无效的操作类型' };
  }
  if (Array.from(actionType).length > MAX_GAME_ACTION_TYPE_LENGTH) {
    return { valid: false, error: '操作类型过长' };
  }

  return { valid: true, actionType };
}

/**
 * 只保留可安全持久化/广播的 JSON 配置字段，并移除创建房间时混在 gameConfig
 * 中的身份与传输字段。返回值使用 null prototype，避免原型污染键重新进入对象。
 */
export function sanitizeIncomingGameConfig(value: unknown): SanitizedGameConfigResult {
  if (value === undefined || value === null) {
    return { success: true, config: Object.create(null) as Record<string, SanitizedJsonValue> };
  }
  if (!isPlainRecord(value)) {
    return { success: false, error: '游戏配置必须是对象' };
  }

  let entryCount = 0;
  const ancestors = new WeakSet<object>();

  const sanitizeValue = (
    current: unknown,
    depth: number,
    topLevel: boolean
  ): SanitizedJsonValue | undefined => {
    if (depth > MAX_CONFIG_DEPTH) {
      throw new Error('游戏配置嵌套层级过深');
    }

    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('游戏配置包含无效数字');
      return current;
    }
    if (typeof current === 'string') {
      if (current.length > MAX_CONFIG_STRING_LENGTH) {
        throw new Error('游戏配置中的文本过长');
      }
      return current;
    }
    if (current === undefined) return undefined;

    if (Array.isArray(current)) {
      if (current.length > MAX_CONFIG_ARRAY_LENGTH) {
        throw new Error('游戏配置数组过长');
      }
      if (ancestors.has(current)) throw new Error('游戏配置不能包含循环引用');
      ancestors.add(current);
      try {
        const sanitizedArray: SanitizedJsonValue[] = [];
        for (const item of current) {
          entryCount++;
          if (entryCount > MAX_CONFIG_ENTRIES) throw new Error('游戏配置字段过多');
          const sanitizedItem = sanitizeValue(item, depth + 1, false);
          // JSON.stringify 会把数组中的 undefined 转成 null；这里显式保持同样语义。
          sanitizedArray.push(sanitizedItem === undefined ? null : sanitizedItem);
        }
        return sanitizedArray;
      } finally {
        ancestors.delete(current);
      }
    }

    if (!isPlainRecord(current)) {
      throw new Error('游戏配置仅支持普通 JSON 对象');
    }
    if (ancestors.has(current)) throw new Error('游戏配置不能包含循环引用');
    ancestors.add(current);
    try {
      const sanitizedObject = Object.create(null) as Record<string, SanitizedJsonValue>;
      const keys = Object.keys(current);
      for (const key of keys) {
        if (UNSAFE_OBJECT_KEYS.has(key) || (topLevel && TRANSPORT_ONLY_CONFIG_KEYS.has(key))) {
          continue;
        }
        entryCount++;
        if (entryCount > MAX_CONFIG_ENTRIES) throw new Error('游戏配置字段过多');
        const sanitizedValue = sanitizeValue(current[key], depth + 1, false);
        if (sanitizedValue !== undefined) sanitizedObject[key] = sanitizedValue;
      }
      return sanitizedObject;
    } finally {
      ancestors.delete(current);
    }
  };

  try {
    const config = sanitizeValue(value, 0, true);
    if (!config || Array.isArray(config) || typeof config !== 'object') {
      return { success: false, error: '游戏配置必须是对象' };
    }
    const byteLength = getJsonByteLength(config);
    if (byteLength === null || byteLength > MAX_GAME_CONFIG_BYTES) {
      return { success: false, error: '游戏配置过大' };
    }
    return { success: true, config };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '游戏配置格式无效'
    };
  }
}
