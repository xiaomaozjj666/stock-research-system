/**
 * 结构化 JSON Logger（零依赖）
 * ----------------------------------------------------------------------------
 * 自建最小化 logger：每条日志序列化为一行 JSON，包含 level / time / msg / pid，
 * 以及可选的 context 对象。info/warn/debug 写入 stdout，error 写入 stderr，
 * 与原生 console.* 的流向保持一致，便于 shell 按流分离与结构化采集。
 *
 * 用法：
 *   import logger from './logger.js';
 *   logger.info('分析完成', { stockCode: '600519', durationMs: 1200 });
 *   logger.error('分析失败', { route: '/api/analyze', err }); // err 自动规范化为 { name, message, stack }
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 当前最低输出级别，低于该级别的日志被丢弃。默认 info。 */
const envLevel = process.env.LOG_LEVEL;
let currentLevel: LogLevel = envLevel && envLevel in LEVEL_RANK ? (envLevel as LogLevel) : 'info';

/** 设置最低输出级别（debug < info < warn < error），用于运行时切换日志详细度。 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** 把 Error 等非常规值规范化为可 JSON 序列化的结构，避免序列化出 "{}" 或抛错。 */
function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    const err: Record<string, unknown> = { name: value.name, message: value.message };
    if (value.stack) err.stack = value.stack;
    return err;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

/** 将日志 payload 序列化为一行 JSON（含 context 中 Error 的规范化）。 */
function jsonLine(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, (_key, value) => normalize(value));
  } catch {
    // context 含循环引用等导致序列化失败时，退化为不含 context 的安全输出
    return JSON.stringify({
      level: payload.level,
      time: payload.time,
      pid: payload.pid,
      msg: payload.msg,
      context: '<unserializable context>',
    });
  }
}

function write(level: LogLevel, msg: string, context?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;
  const payload: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    pid: process.pid,
    msg,
  };
  if (context !== undefined) payload.context = context;
  const line = jsonLine(payload) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (msg: string, context?: unknown) => write('debug', msg, context),
  info: (msg: string, context?: unknown) => write('info', msg, context),
  warn: (msg: string, context?: unknown) => write('warn', msg, context),
  error: (msg: string, context?: unknown) => write('error', msg, context),
};

export default logger;
