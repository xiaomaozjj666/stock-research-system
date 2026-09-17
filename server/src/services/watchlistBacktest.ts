import { fetchOHLCVData } from '../quant/dataProvider.js';
import { earliestNewsDate, extractNewsSignal } from '../quant/newsSignal.js';
import { generateStrategyList } from './strategyListEngine.js';
import { loadStockMaster } from './stockMaster.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { withAbortableTimeout } from '../utils/timeout.js';
import { normalizeAShareCode } from '../utils/stockCode.js';
import type {
  StrategyRecommendation,
  WatchlistNewsBacktestReport,
  WatchlistNewsBacktestRow,
} from '../types.js';

/** 按代码反查股票名称（无主数据/沙箱降级时返回 null） */
async function resolveName(code: string): Promise<string | null> {
  try {
    const master = await loadStockMaster();
    const hit = master.find((m) => m.code === code);
    return hit?.name ?? null;
  } catch {
    return null;
  }
}

function pickBest(list: StrategyRecommendation[]): WatchlistNewsBacktestRow['bestStrategy'] {
  if (list.length === 0) return undefined;
  const best = [...list].sort((a, b) => b.sharpeRatio - a.sharpeRatio)[0];
  return {
    strategyType: best.strategyType,
    totalReturn: best.totalReturn,
    sharpeRatio: best.sharpeRatio,
    maxDrawdown: best.maxDrawdown,
    winRate: best.winRate,
    newsAware: best.newsAware,
  };
}

/** 批量回测的默认并发上限（可被环境变量 WATCHLIST_CONCURRENCY 覆盖） */
export const WATCHLIST_CONCURRENCY = 4;

/**
 * 并发硬上界（WATCHLIST_CONCURRENCY 的封顶值）。
 * 为什么必须封顶：一只自选股要拉 2 年 K 线 + 新闻，并发数被配成 100 会瞬时打满
 * 上游（东财）并长期占住事件循环——这是「可配置」变成「可被误配成拒绝服务」的经典口子。
 * 8 足以跑满单机带宽（实测 4 已是默认值），再高只增加上游压力与内存峰值。
 */
export const WATCHLIST_CONCURRENCY_MAX = 8;

/** 单次批量处理的自选股条数默认上限（WATCHLIST_MAX_CODES 可覆盖） */
export const WATCHLIST_BATCH_MAX = 20;

/**
 * 当前单次条数上限：每次调用时解析（便于测试与运行期调整）。
 * 与 news-backtest 路由的「>20 直接 400」同一数字——那条路是显式拒绝，
 * 这条路（monitor / 自治循环）是「处理前 N 只 + 如实披露跳过只数」，见 runWatchlistNewsBacktest。
 */
export function watchlistBatchMax(): number {
  const raw = Number(process.env.WATCHLIST_MAX_CODES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : WATCHLIST_BATCH_MAX;
}

/** 当前并发放行数（环境变量可调，但夹紧到 [1, WATCHLIST_CONCURRENCY_MAX]） */
export function watchlistConcurrency(): number {
  const raw = Number(process.env.WATCHLIST_CONCURRENCY);
  const configured = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : WATCHLIST_CONCURRENCY;
  return Math.min(Math.max(1, configured), WATCHLIST_CONCURRENCY_MAX);
}

/** 批量回测报告 + 上限裁剪信息（路由据此如实告知「本轮跳过了几只」） */
export type WatchlistBacktestResult = WatchlistNewsBacktestReport & {
  /** 本轮请求的原始只数（含被上限跳过与格式非法的） */
  requested: number;
  /** 因单次上限被跳过、本轮未取数的只数（0 = 全部处理） */
  skipped: number;
};

/** runWatchlistNewsBacktest 的可选项 */
export interface WatchlistBacktestOptions {
  /**
   * 客户端断开时的级联中止信号：置位后停止派发新任务，并在途 fetch 立即中止
   * （signal 一路传到 fetchOHLCVData → fetchKlineBySecid → fetch 的 AbortSignal）。
   */
  signal?: AbortSignal;
  /** 本次最多处理多少只（默认 watchlistBatchMax()）；超出的部分不取数、不计入 count */
  maxCodes?: number;
}

/**
 * 对一组自选股批量运行"含最新消息回测"。
 * 每只独立 try/catch，单只失败不影响其余（结果带 error 字段）。
 * 多只之间并发执行（有界并发，见 mapWithConcurrency），缩短整体耗时。
 *
 * 上限与取消（审计 P1 修复）：
 *  - 条数：默认只处理前 `watchlistBatchMax()`（20）只，其余计入 `skipped`。
 *    monitor 走的是「整张清单」入口，若在此静默截断等于悄悄缩小监控范围；
 *    因此把 requested/skipped 回传，由路由写进响应与快照，让用户看得见。
 *  - 并发：WATCHLIST_CONCURRENCY 夹紧到 ≤ WATCHLIST_CONCURRENCY_MAX（8）。
 *  - 取消：options.signal 传入 mapWithConcurrency 与每只的取数，客户端断开即停车。
 */
export async function runWatchlistNewsBacktest(
  codes: string[],
  options: WatchlistBacktestOptions = {},
): Promise<WatchlistBacktestResult> {
  const requested = codes.length;
  const valid: string[] = [];
  for (const c of codes) {
    const normalized = normalizeAShareCode(c);
    if (normalized !== null) valid.push(normalized);
  }

  const configuredMax = options.maxCodes;
  const max = Math.max(
    1,
    Math.floor(
      Number.isFinite(configuredMax) && Number(configuredMax) >= 1
        ? Number(configuredMax)
        : watchlistBatchMax(),
    ),
  );
  const selected = valid.slice(0, max);
  const skipped = requested - selected.length;
  const empty = (): WatchlistBacktestResult => ({
    generatedAt: new Date().toISOString(),
    count: 0,
    withNewsCount: 0,
    results: [],
    requested,
    skipped,
  });
  if (selected.length === 0) return empty();

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 365 * 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const limit = watchlistConcurrency();
  const results = await mapWithConcurrency(
    selected,
    limit,
    (code) => processCode(code, startDate, endDate, options.signal),
    { signal: options.signal },
  );

  const withNewsCount = results.filter((r) => r.newsSentiment).length;
  return {
    generatedAt: new Date().toISOString(),
    count: results.length,
    withNewsCount,
    results,
    requested,
    skipped,
  };
}

async function processCode(
  code: string,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<WatchlistNewsBacktestRow> {
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('批量回测已中止');
    const ohlcv = await fetchOHLCVData(code, startDate, endDate, signal);
    const simulatedKline = Array.isArray(ohlcv) && ohlcv.some((d) => d.isSimulated);

    let newsSignal: WatchlistNewsBacktestRow['newsSentiment'] = null;
    try {
      // 限时 5s（逐端点 8s + LLM 打分 30s，只 race 不取消会白跑满）；
      // signal 同时接批次信号：客户端断开时连在途新闻抓取一起断，而不是等它自己跑完。
      const fetched = await withAbortableTimeout(
        (s) => extractNewsSignal(code, { signal: s }),
        5000,
        { signal },
      );
      newsSignal = fetched.signal;
    } catch (err) {
      // 批次取消交给外层统一按「整批停车」处理（见下方 catch），
      // 否则会把取消吞成「这只股票没有新闻」，剩余每只都继续跑完。
      if (signal?.aborted) throw err;
      newsSignal = null;
    }

    const strategyList = await generateStrategyList(
      code,
      ohlcv,
      newsSignal?.hasNews
        ? {
            polarity: newsSignal.polarity,
            since: earliestNewsDate(newsSignal.items),
            timeline: newsSignal.timeline,
          }
        : null,
    );

    const name = await resolveName(code);

    return {
      code,
      name,
      newsSentiment: newsSignal?.hasNews ? newsSignal : null,
      strategyList,
      bestStrategy: pickBest(strategyList),
      simulatedKline,
    };
  } catch (err) {
    // 中止不是「这只股票取数失败」：向上抛出让整批停车，
    // 否则客户端已断开、服务端仍会把剩余每只都跑成一行 error（白烧上游配额）。
    if (signal?.aborted) throw err;
    return {
      code,
      name: null,
      newsSentiment: null,
      strategyList: [],
      simulatedKline: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
