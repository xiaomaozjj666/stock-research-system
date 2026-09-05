/**
 * 行业成分股 universe provider（东方财富板块接口）
 * --------------------------------------------------------------------------
 * 截面因子评估的统计功效取决于横截面宽度：手输 2-8 只同行业股票的截面
 * 每日只有 2-8 个样本，逐日 IC 噪声极大。本模块从东方财富公开 clist 接口
 * 拉取「行业板块列表」与「板块成分股（按总市值降序）」，把截面自动拉宽到
 * 10-30 只，让逐日截面 IC 有足够样本量。
 *
 * 数据源（与 K 线同一家的公开行情接口，无鉴权）：
 *   - 行业板块列表：fs=m:90+t:2（t:2 = 行业板块，t:3 = 概念板块）
 *   - 板块成分股：fs=b:BKxxxx（按 f20 总市值降序取前 N）
 *
 * 板块/成分股都是低频变化数据，内存缓存（默认 24h/6h）避免重复打远端；
 * clearUniverseCache() 供测试重置。远端失败抛错由调用方转 HTTP 状态，
 * 绝不编造成分股列表——错误的 universe 会让整份截面报告失真。
 */

import { fetchJson } from '../utils/http.js';
import logger from '../utils/logger.js';

export interface IndustryBoard {
  /** 板块代码（BK0475 等） */
  code: string;
  /** 板块名称（如 白酒） */
  name: string;
}

export interface UniverseStock {
  code: string;
  name: string;
  /** 总市值（亿元）；接口未返回时为 undefined */
  marketCap?: number;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const BOARDS_TTL_MS = 24 * 60 * 60 * 1000;
const CONSTITUENTS_TTL_MS = 6 * 60 * 60 * 1000;

const boardsCache = new Map<string, CacheEntry<IndustryBoard[]>>();
const constituentsCache = new Map<string, CacheEntry<UniverseStock[]>>();

/** 清空 universe 缓存（供测试重置） */
export function clearUniverseCache(): void {
  boardsCache.clear();
  constituentsCache.clear();
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

/**
 * 拉取东方财富行业板块列表（约 86 个一级行业板块）。
 * 请求失败 / 返回为空时抛错（调用方转 502），不降级为编造列表。
 */
export async function fetchIndustryBoards(): Promise<IndustryBoard[]> {
  const cached = boardsCache.get('all');
  if (cached && Date.now() - cached.at < BOARDS_TTL_MS) return cached.value;

  const rows = await fetchBoardList('m:90+t:2', 500, '行业板块列表');
  const boards: IndustryBoard[] = [];
  for (const r of rows) {
    const code = String(r.f12 ?? '').trim();
    const name = String(r.f14 ?? '').trim();
    if (/^BK\d{4,6}$/.test(code) && name) boards.push({ code, name });
  }
  if (boards.length === 0) throw new Error('行业板块列表解析为空');
  boardsCache.set('all', { at: Date.now(), value: boards });
  return boards;
}

/**
 * 拉取某行业板块的成分股，按总市值降序取前 limit 只。
 *
 * 按市值取头部而非全量：截面评估是 CPU 计算，成分股上限由路由层控制（≤30）；
 * 市值头部是流动性与代表性的自然代理（与大票指数口径一致），且小市值长尾
 * 对截面 IC 的边际贡献远低于其数据成本。
 *
 * @throws 板块代码非法（参数错误）/ 远端失败或成分股为空
 */
export async function fetchBoardConstituents(
  boardCode: string,
  limit = 30,
): Promise<UniverseStock[]> {
  const code = boardCode.trim().toUpperCase();
  if (!isValidBoardCode(code)) {
    throw new Error(`无效的板块代码：${boardCode}`);
  }
  const capped = Math.max(1, Math.min(100, Math.floor(limit) || 30));

  const cached = constituentsCache.get(`${code}:${capped}`);
  if (cached && Date.now() - cached.at < CONSTITUENTS_TTL_MS) return cached.value;

  const rows = await fetchBoardList(`b:${code}`, capped, `板块 ${code} 成分股`);
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
    throw new Error(`板块 ${code} 无有效 A 股成分股`);
  }
  constituentsCache.set(`${code}:${capped}`, { at: Date.now(), value: stocks });
  logger.debug('板块成分股获取完成', { board: code, count: stocks.length });
  return stocks;
}
