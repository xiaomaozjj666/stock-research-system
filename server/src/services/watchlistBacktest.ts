import { fetchOHLCVData } from '../quant/dataProvider.js';
import { extractNewsSignal } from '../quant/newsSignal.js';
import { generateStrategyList } from './strategyListEngine.js';
import { loadStockMaster } from './stockMaster.js';
import type {
  StrategyRecommendation,
  WatchlistNewsBacktestReport,
  WatchlistNewsBacktestRow,
} from '../types.js';

/** 限时包装：新闻抓取超时/失败即降级为 null，不阻塞批量回测 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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

/**
 * 对一组自选股批量运行"含最新消息回测"。
 * 每只独立 try/catch，单只失败不影响其余（结果带 error 字段）。
 */
export async function runWatchlistNewsBacktest(
  codes: string[],
): Promise<WatchlistNewsBacktestReport> {
  const valid = codes.filter((c) => /^\d{6}$/.test(c));
  const results: WatchlistNewsBacktestRow[] = [];

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 365 * 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  for (const code of valid) {
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

      results.push({
        code,
        name,
        newsSentiment: newsSignal?.hasNews ? newsSignal : null,
        strategyList,
        bestStrategy: pickBest(strategyList),
        simulatedKline,
      });
    } catch (err) {
      results.push({
        code,
        name: null,
        newsSentiment: null,
        strategyList: [],
        simulatedKline: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const withNewsCount = results.filter((r) => r.newsSentiment).length;

  return {
    generatedAt: new Date().toISOString(),
    count: results.length,
    withNewsCount,
    results,
  };
}
