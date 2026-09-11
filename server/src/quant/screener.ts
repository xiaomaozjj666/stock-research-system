/**
 * 全市场初筛流水线（借鉴 Sequoia-X 的「收盘后扫全市场」）
 * ------------------------------------------------------------------
 * 本项目的截面评估 / 因子框架一直是「深度研究台」——但只研究被点名的东西
 * （板块 topN / 手选 codes / 自选股），其余 98% 的 A 股从未看过一眼。本模块
 * 补上「雷达层」：按股票主表扫全市场（可设上限），形态触发 + RPS 分位初筛，
 * 结果落盘；命中标的天然适合接入截面二次验证与研究队列。
 *
 * 规模策略：**默认扫全市场**。K 线走增量缓存（dataProvider 合并历史 + 尾部
 * 补齐），首扫冷启动是分钟级长任务，之后每个交易日只拉增量尾巴——全量扫描
 * 的边际成本与 500 只没有量级差别。设上限（显式 maxStocks / QUANT_SCREENER_MAX）
 * 时按代码排序**等步长采样**：确定性（同一批代码，缓存始终命中）且跨板块
 * 代表（沪主板/深主板/创业板/科创板都覆盖）——替代此前「取主表前 N 只」
 * 实际退化为沪市主板偏置的取法，RPS 分位的参照宇宙不再失真。
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadStockMaster, type SecurityMasterEntry } from '../services/stockMaster.js';
import { fetchOHLCVData } from './dataProvider.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { detectPatternEvents, PATTERN_NAMES } from './patternEvents.js';

export interface ScreenerHit {
  code: string;
  name?: string;
  /** pat_* 形态名 或 rps_250（250 日收益扫描宇宙分位 ≥ 0.87） */
  strategy: string;
  /** 触发日 / 信号说明 */
  detail: string;
}

export interface ScreenerRunResult {
  at: string;
  /** 实际扫描的股票数 */
  scanned: number;
  /** K 线可用、参与判定的股票数 */
  eligible: number;
  failed: number;
  strategies: string[];
  hits: ScreenerHit[];
  /** 宇宙披露：全市场总数与本次覆盖率（RPS 分位的参照范围） */
  universe: { total: number; coverage: number };
  /** 本次扫描耗时（毫秒），冷启动/增量运行的量级差如实可见 */
  durationMs: number;
}

const DEFAULT_RESULT_FILE = path.join(import.meta.dirname, '..', 'data', 'screenerLatest.json');
const RPS_THRESHOLD = 0.87;
const CONCURRENCY = 12;
/** 「最近触发」窗口：事件日落在最后 N 个交易日内才算当期命中 */
const RECENT_WINDOW = 5;

function getResultFile(): string {
  return process.env.QUANT_SCREENER_FILE && process.env.QUANT_SCREENER_FILE.length > 0
    ? process.env.QUANT_SCREENER_FILE
    : DEFAULT_RESULT_FILE;
}

export function readLatestScreenerRun(): ScreenerRunResult | null {
  try {
    const file = getResultFile();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as ScreenerRunResult;
    return parsed && Array.isArray(parsed.hits) ? parsed : null;
  } catch {
    return null;
  }
}

function saveLatestRun(result: ScreenerRunResult): void {
  try {
    const file = getResultFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    // 结果文件写失败不阻断：响应里已有完整数据
  }
}

/** 扫描上限：显式参数 > env > 全市场（undefined = 不设上限） */
function maxStocksLimit(explicit?: number): number | undefined {
  if (Number.isFinite(explicit) && (explicit as number) > 0) return Math.floor(explicit as number);
  const env = Number(process.env.QUANT_SCREENER_MAX);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : undefined;
}

/**
 * 确定性跨市场采样：按代码升序排序后等步长取样。
 * 固定 6 位数字代码的字典序 = 数值序，000/001/002/300/301/600/688 各板块段
 * 都按比例入选；同一上限每天得到同一批代码——增量缓存永远命中。
 */
export function selectScreenerUniverse(
  master: SecurityMasterEntry[],
  limit?: number,
): SecurityMasterEntry[] {
  const sorted = [...master].sort((a, b) => a.code.localeCompare(b.code));
  if (!limit || limit >= sorted.length) return sorted;
  const step = sorted.length / limit;
  const out: SecurityMasterEntry[] = [];
  for (let i = 0; i < limit; i++) out.push(sorted[Math.floor(i * step)]);
  return out;
}

/**
 * 执行一次全市场（可设上限）初筛。
 * 每只股票：拉 K 线（增量缓存补尾）→ 形态事件检测（近 5 个交易日触发）
 * → 250 日收益在本次扫描宇宙中的分位（RPS ≥ 0.87 视为强势）。
 */
export async function runMarketScreener(
  opts: {
    maxStocks?: number;
    startDate?: string;
    endDate?: string;
    signal?: AbortSignal;
  } = {},
): Promise<ScreenerRunResult> {
  const startedAt = Date.now();
  const end = opts.endDate ?? new Date().toISOString().slice(0, 10);
  const start =
    opts.startDate ?? new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const master = (await loadStockMaster()).filter((m) => /^\d{6}$/.test(m.code));
  const universe = selectScreenerUniverse(master, maxStocksLimit(opts.maxStocks));

  type Candidate = { code: string; name?: string; ret250: number; hits: ScreenerHit[] };
  const candidates: Candidate[] = [];
  let failed = 0;

  await mapWithConcurrency(
    universe,
    CONCURRENCY,
    async (m) => {
      const bars = await fetchOHLCVData(m.code, start, end, opts.signal).catch(() => []);
      if (opts.signal?.aborted) return;
      if (!bars || bars.length < 60) {
        failed += 1;
        return;
      }
      const hits: ScreenerHit[] = [];
      const recentStart = bars.length - RECENT_WINDOW;
      for (const name of PATTERN_NAMES) {
        const events = detectPatternEvents(name, bars);
        const recent = events.filter((ev) => {
          const idx = bars.findIndex((b) => b.date >= ev.eventDate);
          return idx >= recentStart;
        });
        const latest = recent.at(-1);
        if (latest) {
          hits.push({
            code: m.code,
            name: m.name,
            strategy: name,
            detail: `${latest.eventDate} 触发（强度 ${latest.value.toFixed(3)}）`,
          });
        }
      }
      // RPS：250 日收益（不足 250 根用可得区间，样本不足时为 NaN 不参与分位）
      const win = Math.min(250, bars.length - 1);
      const ret250 =
        bars[bars.length - 1 - win].close > 0
          ? bars[bars.length - 1].close / bars[bars.length - 1 - win].close - 1
          : NaN;
      candidates.push({
        code: m.code,
        name: m.name,
        ret250: Number.isFinite(ret250) ? ret250 : NaN,
        hits,
      });
    },
    { signal: opts.signal },
  );

  // RPS（欧奈尔相对强度）：250 日收益「严格高于宇宙中 ≥87% 的股票」视为强势。
  // 用排名而非阈值比较，并列值不会退化（横盘宇宙不会全体误报）。
  const rpsValues = candidates
    .map((c) => c.ret250)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (rpsValues.length >= 10) {
    for (const c of candidates) {
      if (!Number.isFinite(c.ret250)) continue;
      const below = rpsValues.filter((v) => v < c.ret250).length;
      const percentile = below / rpsValues.length;
      if (percentile >= RPS_THRESHOLD && c.hits.every((h) => h.strategy !== 'rps_250')) {
        c.hits.push({
          code: c.code,
          name: c.name,
          strategy: 'rps_250',
          detail: `250 日收益 ${((c.ret250 ?? 0) * 100).toFixed(1)}%（宇宙分位 ${percentile.toFixed(2)}）`,
        });
      }
    }
  }

  const hits = candidates.flatMap((c) => c.hits);
  const result: ScreenerRunResult = {
    at: new Date().toISOString(),
    scanned: universe.length,
    eligible: candidates.length,
    failed,
    strategies: [...PATTERN_NAMES, 'rps_250'],
    hits,
    universe: {
      total: master.length,
      coverage: master.length > 0 ? Math.round((universe.length / master.length) * 1000) / 1000 : 0,
    },
    durationMs: Date.now() - startedAt,
  };

  if (!opts.signal?.aborted) saveLatestRun(result);
  return result;
}
