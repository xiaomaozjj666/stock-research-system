/**
 * 全市场初筛流水线（借鉴 Sequoia-X 的「收盘后扫全市场」）
 * ------------------------------------------------------------------
 * 本项目的截面评估 / 因子框架一直是「深度研究台」——但只研究被点名的东西
 * （板块 topN / 手选 codes / 自选股），其余 98% 的 A 股从未看过一眼。本模块
 * 补上「雷达层」：按股票主表扫全市场（可设上限），形态触发 + RPS 分位初筛，
 * 结果落盘并可选推送到飞书；命中标的天然适合接入截面二次验证与研究队列。
 *
 * 规模策略（诚实边界）：首扫需要为每只股票拉 K 线，全市场 5200+ 只的冷启动
 * 是分钟级长任务；默认上限 500 只（QUANT_SCREENER_MAX 可调），配合磁盘缓存
 * 逐日增量——扫得越多，缓存越热，日常运行越快。
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadStockMaster } from '../services/stockMaster.js';
import { fetchOHLCVData } from './dataProvider.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { detectPatternEvents, PATTERN_NAMES } from './patternEvents.js';
import { isNotifyConfigured, pushNotify } from '../services/notify.js';

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
  pushed: boolean;
  pushReason?: string;
}

const DEFAULT_RESULT_FILE = path.join(import.meta.dirname, '..', 'data', 'screenerLatest.json');
const DEFAULT_MAX_STOCKS = 500;
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

function maxStocksLimit(explicit?: number): number {
  if (Number.isFinite(explicit) && (explicit as number) > 0) {
    return Math.floor(explicit as number);
  }
  const env = Number(process.env.QUANT_SCREENER_MAX);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : DEFAULT_MAX_STOCKS;
}

function renderNotifyText(result: ScreenerRunResult): string {
  const lines: string[] = [
    `【全市场初筛】扫描 ${result.scanned} / 有效 ${result.eligible}，命中 ${result.hits.length}（${result.at.slice(5, 16).replace('T', ' ')}）`,
  ];
  for (const s of result.strategies) {
    const hits = result.hits.filter((h) => h.strategy === s).slice(0, 10);
    if (hits.length === 0) continue;
    lines.push(`▍${s}`);
    for (const h of hits) {
      lines.push(`${h.code} ${h.name ?? ''} ${h.detail}`);
    }
  }
  if (result.hits.length === 0) lines.push('本轮无命中');
  return lines.join('\n');
}

/**
 * 执行一次全市场（可设上限）初筛。
 * 每只股票：拉 K 线（磁盘缓存增量补尾）→ 形态事件检测（近 5 个交易日触发）
 * → 250 日收益在本次扫描宇宙中的分位（RPS ≥ 0.87 视为强势）。
 */
export async function runMarketScreener(
  opts: {
    maxStocks?: number;
    startDate?: string;
    endDate?: string;
    signal?: AbortSignal;
    notify?: boolean;
  } = {},
): Promise<ScreenerRunResult> {
  const end = opts.endDate ?? new Date().toISOString().slice(0, 10);
  const start =
    opts.startDate ?? new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const master = await loadStockMaster();
  const universe = master
    .filter((m) => /^\d{6}$/.test(m.code))
    .slice(0, maxStocksLimit(opts.maxStocks));

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
    pushed: false,
  };

  if (opts.notify && !opts.signal?.aborted) {
    // 要求推送但未配置 webhook：如实给出原因，而不是静默跳过
    if (!isNotifyConfigured()) {
      result.pushReason = '未配置 FEISHU_WEBHOOK_URL';
    } else {
      const push = await pushNotify(renderNotifyText(result));
      result.pushed = push.sent;
      result.pushReason = push.reason;
    }
  }

  if (!opts.signal?.aborted) saveLatestRun(result);
  return result;
}
