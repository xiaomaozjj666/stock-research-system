/**
 * 组合 alpha 计算服务（单只股票，时间序列 IC 口径）
 * --------------------------------------------------------------------------
 * 把「拉 K 线 → 拉市场基准收益 → 算量价因子时间序列预测力 → 合成方向性组合 alpha」
 * 封装为一个可独立调用的服务，供 `/api/quant/factor/composite` 端点使用。它与
 * `/api/quant/analyze` 共享同一套底层原语（fetchOHLCVData / fetchBenchmarkReturns /
 * evaluatePriceVolumeFactorPredictability / computeCompositeAlpha），但只产出因子预测力
 * 与组合 alpha，不跑回测 / 数据质量 / 审计 / 优化，适合批量测算单只标的的方向性信号。
 *
 * 市场基准按 `marketOf` 选对应宽基（A 股沪深300 / 美股标普500 / 港股恒生）；拉取失败
 * 优雅降级为「无市场收益」（Beta 类因子仍按 NaN 处理，不参与组合加权）。
 */

import {
  fetchOHLCVData,
  fetchBenchmarkReturns,
  marketOf,
  benchmarkSecidForMarket,
  type Market,
} from './dataProvider.js';
import {
  evaluatePriceVolumeFactorPredictability,
  type FactorPredictability,
} from './factorPredictability.js';
import { computeCompositeAlpha, type CompositeAlpha } from './compositeAlpha.js';
import type { OHLCVData } from './types.js';

/** 组合 alpha 计算结果（单只股票） */
export interface CompositeAlphaResult {
  stockCode: string;
  /** 识别出的市场（A / HK / US） */
  market: Market;
  /** 实际使用的基准指数 secid */
  benchmarkSecid: string;
  /** 持有期（交易日） */
  horizons: number[];
  /** 跨持有期组合 alpha（综合方向 / 显著因子数 / 方向一致率） */
  compositeAlpha: CompositeAlpha;
  /** 逐因子时间序列预测力（组合 alpha 的构建块，供调用方透明审视） */
  factorPredictability: FactorPredictability[];
  /** K 线条数 */
  bars: number;
  /** 数据区间 */
  dataRange: { start: string; end: string };
  /** 市场基准收益是否成功获取（false 时 Beta 类因子未参与加权） */
  benchmarkAvailable: boolean;
}

/**
 * 计算单只股票的多因子加权组合 alpha。
 *
 * @throws 当 K 线数据为空（无法计算）时抛错，由调用方转 422
 */
export async function computeCompositeAlphaForStrategy(
  stockCode: string,
  startDate: string,
  endDate: string,
  horizons: number[] = [21, 63],
): Promise<CompositeAlphaResult> {
  const ohlcv = await fetchOHLCVData(stockCode, startDate, endDate);
  if (!ohlcv || ohlcv.length === 0) {
    throw new Error(`无法获取股票 ${stockCode} 的K线数据`);
  }
  const market = marketOf(stockCode);
  const benchmarkSecid = benchmarkSecidForMarket(market);

  let marketReturns: number[] | undefined;
  let benchmarkAvailable = false;
  try {
    const mr = await fetchBenchmarkReturns(
      ohlcv.map((b: OHLCVData) => b.date),
      startDate,
      endDate,
      benchmarkSecid,
    );
    if (mr) {
      marketReturns = mr;
      benchmarkAvailable = true;
    }
  } catch {
    // 基准拉取失败 → 降级为无市场收益，不拖垮组合计算
    marketReturns = undefined;
  }

  const factorPredictability = evaluatePriceVolumeFactorPredictability(
    { bars: ohlcv, marketReturns },
    horizons,
  );
  const compositeAlpha = computeCompositeAlpha(factorPredictability, horizons);

  return {
    stockCode,
    market,
    benchmarkSecid,
    horizons,
    compositeAlpha,
    factorPredictability,
    bars: ohlcv.length,
    dataRange: { start: ohlcv[0].date, end: ohlcv[ohlcv.length - 1].date },
    benchmarkAvailable,
  };
}

/** 批量结果项：单只股票成功或失败——失败只影响该项，不拖垮整批 */
export type CompositeAlphaBatchItem =
  | { stockCode: string; ok: true; result: CompositeAlphaResult }
  | { stockCode: string; ok: false; error: string };

/** 批量组合 alpha 结果 */
export interface CompositeAlphaBatchResult {
  /** 去重后的请求代码数 */
  requested: number;
  /** 成功数 */
  succeeded: number;
  /** 失败数 */
  failed: number;
  /** 按输入顺序（去重后）排列的结果项 */
  items: CompositeAlphaBatchItem[];
  /** 批次公共参数回显，便于前端核对与复现 */
  startDate: string;
  endDate: string;
  horizons: number[];
}

/** 默认并发度：受限于上游行情接口的稳定性，不做无节制并发 */
const DEFAULT_BATCH_CONCURRENCY = 4;
/** 并发度硬上限，防止调用方传超大值打满上游 */
const MAX_BATCH_CONCURRENCY = 8;

/**
 * 批量计算多只股票的组合 alpha。
 *
 * - 代码按「首次出现顺序」去重，重复代码不重复请求；
 * - 并发度受限（默认 4，上限 8）：既避免 N 只串行过慢，也不无节制冲击上游；
 * - 单只失败（无 K 线 / 网络异常）只标记该项 `ok:false`，其余照常返回——
 *   批量场景下「一只拉不到就整批失败」是最差的失败模式；
 * - 结果严格按输入顺序返回，便于前端逐行对齐。
 */
export async function computeCompositeAlphaBatch(
  stockCodes: string[],
  startDate: string,
  endDate: string,
  horizons: number[] = [21, 63],
  concurrency: number = DEFAULT_BATCH_CONCURRENCY,
): Promise<CompositeAlphaBatchResult> {
  const codes = [...new Set(stockCodes.map((c) => String(c ?? '').trim()).filter(Boolean))];
  const limit = Math.max(
    1,
    Math.min(MAX_BATCH_CONCURRENCY, Math.floor(concurrency) || DEFAULT_BATCH_CONCURRENCY),
  );

  const slots: (CompositeAlphaBatchItem | undefined)[] = new Array(codes.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= codes.length) return;
      const code = codes[i];
      try {
        const result = await computeCompositeAlphaForStrategy(code, startDate, endDate, horizons);
        slots[i] = { stockCode: code, ok: true, result };
      } catch (e) {
        slots[i] = {
          stockCode: code,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, codes.length) }, () => worker());
  await Promise.all(workers);

  const items = slots.filter((x): x is CompositeAlphaBatchItem => x !== undefined);
  const succeeded = items.filter((it) => it.ok).length;
  return {
    requested: codes.length,
    succeeded,
    failed: items.length - succeeded,
    items,
    startDate,
    endDate,
    horizons,
  };
}
