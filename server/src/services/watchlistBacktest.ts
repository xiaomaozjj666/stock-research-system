import { fetchOHLCVData } from '../quant/dataProvider.js';
import { extractNewsSignal } from '../quant/newsSignal.js';
import { generateStrategyList } from './strategyListEngine.js';
import { loadStockMaster } from './stockMaster.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { withTimeout } from '../utils/timeout.js';
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
 * 对一组自选股批量运行"含最新消息回测"。
 * 每只独立 try/catch，单只失败不影响其余（结果带 error 字段）。
 * 多只之间并发执行（有界并发，见 mapWithConcurrency），缩短整体耗时。
 */
export async function runWatchlistNewsBacktest(
  codes: string[],
): Promise<WatchlistNewsBacktestReport> {
  const valid = codes.filter((c) => /^\d{6}$/.test(c));
  if (valid.length === 0) {
    return { generatedAt: new Date().toISOString(), count: 0, withNewsCount: 0, results: [] };
  }

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 365 * 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const limit = Math.max(1, Number(process.env.WATCHLIST_CONCURRENCY) || WATCHLIST_CONCURRENCY);
  const results = await mapWithConcurrency(valid, limit, (code) =>
    processCode(code, startDate, endDate),
  );

  const withNewsCount = results.filter((r) => r.newsSentiment).length;
  return {
    generatedAt: new Date().toISOString(),
    count: results.length,
    withNewsCount,
    results,
  };
}

async function processCode(
  code: string,
  startDate: string,
  endDate: string,
): Promise<WatchlistNewsBacktestRow> {
  try {
    const ohlcv = await fetchOHLCVData(code, startDate, endDate);
    const simulatedKline = Array.isArray(ohlcv) && ohlcv.some((d) => d.isSimulated);

    let newsSignal: WatchlistNewsBacktestRow['newsSentiment'] = null;
    try {
      const fetched = await withTimeout(extractNewsSignal(code), 5000);
      newsSignal = fetched.signal;
    } catch {
      newsSignal = null;
    }

    const strategyList = await generateStrategyList(
      code,
      ohlcv,
      newsSignal?.hasNews ? { polarity: newsSignal.polarity } : null,
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
