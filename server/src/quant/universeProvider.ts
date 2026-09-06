/**
 * 行业成分股 universe provider（东方财富板块接口）
 * --------------------------------------------------------------------------
 * 截面因子评估的统计功效取决于横截面宽度：手输 2-8 只同行业股票的截面
 * 每日只有 2-8 个样本，逐日 IC 噪声极大。本模块从东方财富公开 clist 接口
 * 拉取「行业板块列表」与「板块成分股（按总市值降序）」，把截面自动拉宽。
 *
 * 数据源（与 K 线同一家的公开行情接口，无鉴权）：
 *   - 行业板块列表：fs=m:90+t:2（t:2 = 行业板块，t:3 = 概念板块）
 *   - 板块成分股：fs=b:BKxxxx（按 f20 总市值降序取前 N）
 *
 * 缓存为四层（2026-09-06 加固）：
 *   1. 内存（进程内，最快）；2. 磁盘新鲜（跨进程复用，重启后不必重打）；
 *   3. 远端；4. 磁盘陈旧快照（上游失败时兜底，返回 stale=true）。
 *
 * 第 4 层的由来：板块/成分股是低频数据，但一次上游抖动就会让整份截面请求 502
 * ——即使该板块的 K线/事件/财报都已缓存。回落磁盘快照用的是**真实历史数据**，
 * 并不违反「绝不编造成分股列表」的原则（编造 = 凭空生成，陈旧 = 真实但稍旧），
 * 且 stale 标记会如实回传给调用方披露。四层皆无时才抛错（调用方转 502）。
 */

import { fetchJson } from '../utils/http.js';
import logger from '../utils/logger.js';
import { deleteCacheEntry, isCacheFresh, readCacheEntry, writeCacheEntry } from './quantCache.js';

export interface IndustryBoard {
  /** 板块代码（BK0475 等） */
  code: string;
  name: string;
}

export interface UniverseStock {
  code: string;
  name: string;
  /** 总市值（亿元）；接口未返回时为 undefined */
  marketCap?: number;
}

/** 带陈旧标记的返回（供路由如实披露「本次用的是历史快照」） */
export interface WithStaleness<T> {
  value: T;
  /** true = 远端本次失败，返回的是磁盘上的历史快照 */
  stale: boolean;
  /** 快照已存活时长（毫秒），仅 stale 时有值 */
  staleAgeMs?: number;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const BOARDS_TTL_MS = 24 * 60 * 60 * 1000;
const CONSTITUENTS_TTL_MS = 6 * 60 * 60 * 1000;

const BOARDS_DISK_KEY = 'universe_boards_all';
const constituentsDiskKey = (code: string, capped: number) => `universe_cons_${code}_${capped}`;

const boardsCache = new Map<string, CacheEntry<IndustryBoard[]>>();
const constituentsCache = new Map<string, CacheEntry<UniverseStock[]>>();
/** 已写入磁盘的 key 登记（供 clearUniverseCache 清理，保证测试隔离） */
const diskKeys = new Set<string>();

/**
 * 清空 universe 缓存（供测试重置）：内存 + 磁盘一并清除，
 * 否则磁盘快照会在用例间串扰（例如「远端返回空应抛错」被上一用例的快照兜底）。
 */
export function clearUniverseCache(): void {
  boardsCache.clear();
  constituentsCache.clear();
  for (const key of diskKeys) deleteCacheEntry(key);
  diskKeys.clear();
}

function persist(key: string, value: unknown, ttlMs: number): void {
  writeCacheEntry(key, value, ttlMs);
  diskKeys.add(key);
}

/** 板块代码合法性：BK + 4~6 位数字（东方财富当前为 BK0475 形态，放宽到 6 位防未来扩位） */
export function isValidBoardCode(code: string): boolean {
  return /^BK\d{4,6}$/i.test(code.trim());
}

/** clist 响应：np=1 时 diff 为数组；部分旧响应为「下标键对象」，两种都兼容 */
function parseDiff(json: unknown): Record<string, unknown>[] {
  const diff = (json as { data?: { diff?: unknown } } | null)?.data?.diff;
  if (Array.isArray(diff)) return diff as Record<string, unknown>[];
  if (diff && typeof diff === 'object') return Object.values(diff) as Record<string, unknown>[];
  return [];
}

async function fetchBoardList(
  boardFs: string,
  pz: number,
  what: string,
): Promise<Record<string, unknown>[]> {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${pz}&po=1&np=1&fltt=2` +
    `&fid=f20&fs=${encodeURIComponent(boardFs)}&fields=f12,f14,f20`;
  const json = await fetchJson(url, { timeoutMs: 10_000, retries: 1 });
  const rows = parseDiff(json);
  if (rows.length === 0) {
    throw new Error(`${what}数据为空（接口返回 ${rows.length} 行）`);
  }
  return rows;
}

function parseConstituents(rows: Record<string, unknown>[], capped: number): UniverseStock[] {
  const stocks: UniverseStock[] = [];
  for (const r of rows) {
    const stockCode = String(r.f12 ?? '').trim();
    const name = String(r.f14 ?? '').trim();
    if (!/^\d{6}$/.test(stockCode)) continue; // 只收 A 股 6 位代码（板块内可能混 B 股/其他）
    // fltt=2 时市值已是「元」；转亿元。缺值/非有限则不透出该字段
    const capYuan = Number(r.f20);
    stocks.push({
      code: stockCode,
      name,
      ...(Number.isFinite(capYuan) && capYuan > 0 ? { marketCap: capYuan / 1e8 } : {}),
    });
    if (stocks.length >= capped) break;
  }
  if (stocks.length === 0) {
    throw new Error('无有效 A 股成分股');
  }
  return stocks;
}

/**
 * 拉取东方财富行业板块列表（约 86 个一级行业板块）。
 *
 * @throws 远端失败**且**无磁盘快照 / 解析为空 —— 不降级为编造列表。
 */
export async function fetchIndustryBoardsWithMeta(): Promise<WithStaleness<IndustryBoard[]>> {
  const cached = boardsCache.get('all');
  if (cached && Date.now() - cached.at < BOARDS_TTL_MS) {
    return { value: cached.value, stale: false };
  }

  // 磁盘新鲜快照（跨进程复用：服务重启后无需重打远端）
  const persisted = readCacheEntry<IndustryBoard[]>(BOARDS_DISK_KEY);
  if (persisted && isCacheFresh(persisted.timestamp, BOARDS_TTL_MS)) {
    boardsCache.set('all', { at: persisted.timestamp, value: persisted.data });
    return { value: persisted.data, stale: false };
  }

  try {
    const rows = await fetchBoardList('m:90+t:2', 500, '行业板块列表');
    const boards: IndustryBoard[] = [];
    for (const r of rows) {
      const code = String(r.f12 ?? '').trim();
      const name = String(r.f14 ?? '').trim();
      if (/^BK\d{4,6}$/.test(code) && name) boards.push({ code, name });
    }
    if (boards.length === 0) throw new Error('行业板块列表解析为空');
    boardsCache.set('all', { at: Date.now(), value: boards });
    persist(BOARDS_DISK_KEY, boards, BOARDS_TTL_MS);
    return { value: boards, stale: false };
  } catch (err) {
    const stale = persisted;
    if (stale && Array.isArray(stale.data) && stale.data.length > 0) {
      logger.warn('行业板块列表远端失败，回落磁盘快照', {
        ageMs: Date.now() - stale.timestamp,
        err: (err as Error)?.message,
      });
      return { value: stale.data, stale: true, staleAgeMs: Date.now() - stale.timestamp };
    }
    throw err;
  }
}

/** 拉取行业板块列表（不带陈旧标记；语义与历史版本一致） */
export async function fetchIndustryBoards(): Promise<IndustryBoard[]> {
  return (await fetchIndustryBoardsWithMeta()).value;
}

/**
 * 拉取某行业板块的成分股，按总市值降序取前 limit 只。
 *
 * 按市值取头部而非全量：截面评估是 CPU 计算，成分股上限由路由层控制；
 * 市值头部是流动性与代表性的自然代理（与大票指数口径一致），且小市值长尾
 * 对截面 IC 的边际贡献远低于其数据成本。
 *
 * @throws 板块代码非法（参数错误）/ 远端失败且无磁盘快照 / 无有效 A 股成分股
 */
export async function fetchBoardConstituentsWithMeta(
  boardCode: string,
  limit = 30,
): Promise<WithStaleness<UniverseStock[]>> {
  const code = boardCode.trim().toUpperCase();
  if (!isValidBoardCode(code)) {
    throw new Error(`无效的板块代码：${boardCode}`);
  }
  const capped = Math.max(1, Math.min(100, Math.floor(limit) || 30));
  const key = `${code}:${capped}`;

  const cached = constituentsCache.get(key);
  if (cached && Date.now() - cached.at < CONSTITUENTS_TTL_MS) {
    return { value: cached.value, stale: false };
  }

  const persisted = readCacheEntry<UniverseStock[]>(constituentsDiskKey(code, capped));
  if (persisted && isCacheFresh(persisted.timestamp, CONSTITUENTS_TTL_MS)) {
    constituentsCache.set(key, { at: persisted.timestamp, value: persisted.data });
    return { value: persisted.data, stale: false };
  }

  try {
    const rows = await fetchBoardList(`b:${code}`, capped, `板块 ${code} 成分股`);
    const stocks = parseConstituents(rows, capped);
    constituentsCache.set(key, { at: Date.now(), value: stocks });
    persist(constituentsDiskKey(code, capped), stocks, CONSTITUENTS_TTL_MS);
    logger.debug('板块成分股获取完成', { board: code, count: stocks.length });
    return { value: stocks, stale: false };
  } catch (err) {
    if (persisted && Array.isArray(persisted.data) && persisted.data.length > 0) {
      logger.warn('板块成分股远端失败，回落磁盘快照', {
        board: code,
        ageMs: Date.now() - persisted.timestamp,
        err: (err as Error)?.message,
      });
      return {
        value: persisted.data,
        stale: true,
        staleAgeMs: Date.now() - persisted.timestamp,
      };
    }
    throw err;
  }
}

/** 拉取板块成分股（不带陈旧标记；语义与历史版本一致） */
export async function fetchBoardConstituents(
  boardCode: string,
  limit = 30,
): Promise<UniverseStock[]> {
  return (await fetchBoardConstituentsWithMeta(boardCode, limit)).value;
}
