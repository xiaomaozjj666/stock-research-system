import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger.js';

/**
 * 量化模块磁盘缓存：JSON 文件 + 逐条 TTL + 容量上限淘汰。
 *
 * 存在的理由（2026-09-05 截面拉宽审计）：截面框架的统计功效随横截面宽度增长，
 * 要从板块内 30 只扩到全市场几百只，网络调用数是唯一硬约束——每只股票一次运行
 * 要拉 K线 + 年报 + 季度财报。本模块把「K线之外的低频数据」也纳入缓存，
 * 并提供 prune 防止缓存目录无界增长（此前 quant/cache 完全没有清理）。
 *
 * 设计要点：
 * - 目录走 DATA_CACHE_DIR 惰性解析（与 services/dataService 同口径），测试可隔离到临时目录；
 * - 每条记录自带 ttlMs 与 kind 标记，prune 逐文件判断是否过期（K线合并历史与财报的 TTL
 *   差两个数量级，不能用一个全局 TTL 判定），且**只清理本类条目**——DATA_CACHE_DIR 把两套
 *   缓存指向同一目录时，dataService 的 24h pruner 与本模块的逐条 TTL 不会互相删对方的条目；
 * - 所有 IO 失败静默降级：缓存是加速器，不是数据源，读不到就当未命中。
 */
const DEFAULT_QUANT_CACHE_DIR = path.join(import.meta.dirname, 'cache');

/** 本模块条目的归属标记 */
const QUANT_KIND = 'quant';
/** 对侧（services/dataService）股票缓存的归属标记：只识别，不写 */
const STOCK_KIND = 'stocks';
/**
 * dataService 股票缓存的命名形态（`<6 位代码>.json`）。
 * 旧格式（升级前写入）既没有 kind 也没有 ttlMs，与「缺 ttlMs 的旧量化分片」无法靠字段区分，
 * 只能按命名收敛：6 位纯数字文件名一律视为 dataService 所有。
 */
const STOCK_FILE_RE = /^\d{6}\.json$/;

/** 缓存目录（DATA_CACHE_DIR 可重定向；惰性解析以便测试在 beforeEach 中切换） */
export function getQuantCacheDir(): string {
  return process.env.DATA_CACHE_DIR && process.env.DATA_CACHE_DIR.length > 0
    ? process.env.DATA_CACHE_DIR
    : DEFAULT_QUANT_CACHE_DIR;
}

/** 缓存 key 白名单清洗：防路径穿越（与 dataProvider 原 sanitizeCacheToken 同口径） */
export function sanitizeCacheKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

function cacheFilePath(key: string): string {
  return path.join(getQuantCacheDir(), `${sanitizeCacheKey(key)}.json`);
}

interface CacheFile<T> {
  /** 条目归属标记：prune/读取据此区分本类与 dataService 股票缓存 */
  kind: typeof QUANT_KIND;
  data: T;
  timestamp: number;
  /** 该条目的有效时长，供 prune 逐文件判断是否过期 */
  ttlMs: number;
}

/**
 * 条目归属判定：'own' 本类（按自身 ttlMs 判过期）/ 'foreign' 异类（prune 一律跳过，不删不计数）。
 * 兼容历史格式：无 kind 但带 ttlMs 的是升级前的量化条目；6 位代码命名的是 dataService 股票缓存。
 */
export function classifyCacheEntry(
  parsed: { kind?: unknown; ttlMs?: unknown } | null | undefined,
  fileName: string,
): 'own' | 'foreign' {
  if (parsed?.kind === QUANT_KIND) return 'own';
  if (parsed?.kind === STOCK_KIND) return 'foreign';
  if (parsed?.kind !== undefined) return 'foreign'; // 未来新增类型：同样不认领
  if (typeof parsed?.ttlMs === 'number') return 'own';
  if (STOCK_FILE_RE.test(fileName)) return 'foreign';
  // 其余旧格式量化分片：保持既有自愈行为（缺 ttlMs 视为过期删除）
  return 'own';
}

/**
 * 读取缓存条目。不判断新鲜度——调用方按自身 TTL 语义决定（K线合并历史要读出来
 * 增量补尾，即使整体已「过期」也要读）。损坏/不可读/异类条目一律返回 null（异类由对侧 pruner 负责）。
 */
export function readCacheEntry<T>(key: string): { data: T; timestamp: number } | null {
  try {
    const file = cacheFilePath(key);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CacheFile<T>>;
    if (typeof parsed?.timestamp !== 'number' || !('data' in parsed)) return null;
    if (classifyCacheEntry(parsed, path.basename(file)) !== 'own') return null;
    return { data: parsed.data as T, timestamp: parsed.timestamp };
  } catch {
    return null;
  }
}

/**
 * 删除缓存条目（供测试隔离 / 显式失效）。不存在或 IO 失败静默降级。
 */
export function deleteCacheEntry(key: string): void {
  try {
    const file = cacheFilePath(key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // 静默降级
  }
}

/** 判断某条记录在其 TTL 内是否仍新鲜 */
export function isCacheFresh(timestamp: number, ttlMs: number): boolean {
  return Number.isFinite(timestamp) && Date.now() - timestamp < ttlMs;
}

/** 写入缓存。IO 失败静默降级（缓存写不进不应影响主流程）。 */
export function writeCacheEntry<T>(key: string, data: T, ttlMs: number): void {
  try {
    const dir = getQuantCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload: CacheFile<T> = { kind: QUANT_KIND, data, timestamp: Date.now(), ttlMs };
    // 先写临时文件再 rename（同分区原子替换）：同 key 并发写时，
    // 直接 writeFileSync 会让读者读到半截 JSON，缓存静默失效并反复全量重拉。
    // 与 services/historyService.ts 的落盘方式一致。
    const file = cacheFilePath(key);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  } catch (error) {
    logger.warn('写入量化缓存失败', { key, err: error });
  }
}

/**
 * 同 key 并发去重：miss 时多个调用方共享同一个 producer Promise，
 * 只打一次上游（全市场初筛/批量路由下同一股票会被并发请求）。
 * producer 失败时该 key 的 Promise 落定后即清除，后续调用可重试。
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * 带缓存地执行 producer：命中且新鲜则零网络返回，否则执行并回写。
 * producer 抛错时不写缓存，错误原样上抛（降级由调用方决定）。
 */
export async function withQuantCache<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  // ttlMs <= 0 视为「关闭缓存」：直接执行 producer，不读不写。
  // 用途：① 测试逐用例 mock 返回值，缓存会让后序用例读到前序数据；② 线上排障旁路。
  if (!(ttlMs > 0)) return producer();
  const hit = readCacheEntry<T>(key);
  if (hit && isCacheFresh(hit.timestamp, ttlMs)) return hit.data;
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    const data = await producer();
    writeCacheEntry(key, data, ttlMs);
    return data;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 清理量化缓存目录：
 * 1. 逐文件按自身 ttlMs 判断是否过期（缺失 ttlMs 的旧量化分片视为过期，自愈式淘汰）；
 * 2. **异类条目（services/dataService 的股票缓存）一律跳过**：它们没有 ttlMs，
 *    若按本规则判定会被整批删除，导致共享 DATA_CACHE_DIR 时股票缓存静默失效、反复全量重拉；
 * 3. 损坏/不可解析文件直接删除（无法判定归属，且对两侧都无价值）；
 * 4. 存活数量超过上限时按写入时间从最旧开始淘汰（只统计本类）。
 * best-effort：任何 IO 失败静默降级，不影响主流程。
 */
export async function pruneQuantCache(
  options: { maxFiles?: number } = {},
): Promise<{ removed: number }> {
  const rawMax = options.maxFiles ?? Number(process.env.QUANT_CACHE_MAX_FILES);
  const maxFiles =
    Number.isFinite(rawMax) && (rawMax as number) > 0 ? (rawMax as number) : DEFAULT_MAX_FILES;
  let removed = 0;
  try {
    const dir = getQuantCacheDir();
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json'));
    const alive: { file: string; timestamp: number }[] = [];
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const parsed = JSON.parse(await fs.promises.readFile(full, 'utf-8')) as Partial<
          CacheFile<unknown>
        >;
        if (classifyCacheEntry(parsed, f) === 'foreign') continue; // 异类：交给对侧 pruner
        const expired =
          typeof parsed?.timestamp !== 'number' ||
          typeof parsed?.ttlMs !== 'number' ||
          Date.now() - parsed.timestamp > parsed.ttlMs;
        if (expired) {
          await fs.promises.unlink(full);
          removed += 1;
        } else {
          alive.push({ file: full, timestamp: parsed.timestamp as number });
        }
      } catch {
        // 损坏/不可读：直接删除
        await fs.promises.unlink(full).catch(() => {});
        removed += 1;
      }
    }
    if (alive.length > maxFiles) {
      alive.sort((a, b) => a.timestamp - b.timestamp);
      for (const entry of alive.slice(0, alive.length - maxFiles)) {
        await fs.promises.unlink(entry.file).catch(() => {});
        removed += 1;
      }
    }
  } catch {
    // 目录不存在或 IO 失败：静默降级
  }
  return { removed };
}

/**
 * 启动定期清理（对齐 services/dataService 的 H-05 模式）：启动清一次 + 每小时兜底。
 * 测试环境（NODE_ENV=test）不起定时器，避免改动测试隔离目录。
 * 由 server/src/index.ts 显式调用，模块导入本身无副作用。
 */
export function startQuantCachePruner(intervalMs = DEFAULT_PRUNE_INTERVAL_MS): void {
  if (process.env.NODE_ENV === 'test') return;
  void pruneQuantCache();
  const timer = setInterval(() => void pruneQuantCache(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}
