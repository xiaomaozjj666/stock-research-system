/**
 * 截面因子编排器（Cross-Section Builder）
 * --------------------------------------------------------------------------
 * 把「多只股票的真实行情/财务数据」装配成 factorEvaluation 的 FactorObservation
 * 面板，让既有的截面 IC 评估器（dailyIcSeries 按日跨股票 Spearman + Newey-West +
 * 分层收益）直接吃真实数据，而不是只能靠客户端手工喂 observations。
 *
 * 两类因子来源：
 *   1. 量价因子（priceVolumeFactors）：每股每日一个值，天然带时间变异；
 *   2. 基本面因子（财务快照：ROE / 毛利率 / 净利润增速 / 资产负债率）：
 *      每股在评估窗口内为常数——截面 IC 赌的是「横截面上谁高谁低」，时间不变
 *      并不影响其有效性（逐日截面排序不变，远期收益在变）。
 *
 * 诚实边界：截面框架的统计功效取决于横截面宽度（股票数）。同行业 peer group
 * 通常只有几只，样本 < minStocks 的日期会被丢弃，报告的 sampleSize 会如实反映。
 */
import type { OHLCVData } from './types.js';
import type { FinancialData } from '../types.js';
import {
  computePriceVolumeFactorSeries,
  type PriceVolumeFactorContext,
} from './priceVolumeFactors.js';
import type { FactorObservation } from './factorEvaluation.js';

/** 基本面截面因子名 → 取值函数（每股恒定，取最新一期） */
export type FundamentalFactorName =
  'cs_roe' | 'cs_gross_margin' | 'cs_net_profit_growth' | 'cs_debt_ratio';

/** 基本面因子经济方向：+1 = 值越高预期收益越高（评估器按原值计算 IC，方向由使用者解读） */
export const FUNDAMENTAL_FACTORS: Record<FundamentalFactorName, (f: FinancialData) => number> = {
  cs_roe: (f) => f.roe[f.roe.length - 1] ?? NaN,
  cs_gross_margin: (f) => f.grossMargin[f.grossMargin.length - 1] ?? NaN,
  cs_net_profit_growth: (f) => {
    const np = f.netProfit;
    if (np.length < 2 || !(np[np.length - 2] > 0)) return NaN;
    return ((np[np.length - 1] - np[np.length - 2]) / np[np.length - 2]) * 100;
  },
  cs_debt_ratio: (f) => f.debtRatio[f.debtRatio.length - 1] ?? NaN,
};

export interface StockPanelInput {
  code: string;
  bars: OHLCVData[];
  financial?: FinancialData | null;
}

export interface CrossSectionPanel {
  /** 量价因子面板（逐日时间变异） */
  priceVolume: Record<string, FactorObservation[]>;
  /** 基本面因子面板（每股常数）；无财务数据的股票不参与 */
  fundamental: Record<FundamentalFactorName, FactorObservation[]>;
  /** 参与组装的股票数与逐股状态（取数失败/数据不足的降级披露） */
  stocksIncluded: string[];
  stocksSkipped: { code: string; reason: string }[];
}

/**
 * 把多只股票的 bars（+ 可选财务快照）装配成截面观测面板。
 *
 * 前视纪律与 singleFactorPredictability 同一口径：日期 t 的观测携带
 * t → t+period 的远期收益；窗口尾部不足 period 天的行自然缺 returns 键，
 * 由评估器整行丢弃（绝不把未来数据提前填进来）。
 *
 * @param inputs   逐股行情（必填）与财务快照（可选）
 * @param horizons 持有期（交易日），默认 [21, 63]；决定面板 returns 的键
 * @param factorCtxOverride 量价因子上下文定制（测试注入用）；缺省按每股 bars 构建
 */
export function buildCrossSectionPanel(
  inputs: StockPanelInput[],
  horizons: number[] = [21, 63],
  factorCtxOverride?: (bars: OHLCVData[]) => PriceVolumeFactorContext,
): CrossSectionPanel {
  const priceVolume: Record<string, FactorObservation[]> = {};
  const fundamental: Record<FundamentalFactorName, FactorObservation[]> = {
    cs_roe: [],
    cs_gross_margin: [],
    cs_net_profit_growth: [],
    cs_debt_ratio: [],
  };
  const stocksIncluded: string[] = [];
  const stocksSkipped: { code: string; reason: string }[] = [];

  // 每股基本面快照（常数），供所有日期的截面共用
  const fundValue = new Map<string, Partial<Record<FundamentalFactorName, number>>>();

  for (const input of inputs) {
    const { code, bars } = input;
    if (!bars || bars.length < Math.max(...horizons) + 5) {
      stocksSkipped.push({ code, reason: `K线不足（${bars?.length ?? 0} 根）` });
      continue;
    }
    stocksIncluded.push(code);

    // 量价因子：逐日序列 → 观测
    const ctx = factorCtxOverride
      ? factorCtxOverride(bars)
      : ({ bars } as PriceVolumeFactorContext);
    const seriesList = computePriceVolumeFactorSeries(ctx);
    for (const s of seriesList) {
      const byDate = new Map(s.points.map((pt) => [pt.date, pt.value]));
      const obs: FactorObservation[] = [];
      for (let i = 0; i < bars.length; i++) {
        const value = byDate.get(bars[i].date);
        if (value === undefined || !Number.isFinite(value)) continue;
        const returns: Record<number, number> = {};
        let complete = true;
        for (const h of horizons) {
          if (i + h >= bars.length) {
            complete = false; // 窗口尾部：远期收益不足，评估器需要完整 returns 才收行
            break;
          }
          const base = bars[i].close;
          const ahead = bars[i + h].close;
          if (!(base > 0) || !(ahead > 0)) {
            complete = false;
            break;
          }
          returns[h] = ahead / base - 1;
        }
        if (!complete || Object.keys(returns).length === 0) continue;
        obs.push({ date: bars[i].date, symbol: code, value, returns });
      }
      (priceVolume[s.name] ??= []).push(...obs);
    }

    // 基本面快照：每股常数（有财务数据才参与）——单遍生成，用自己的 bars 算远期收益
    if (input.financial) {
      for (const [name, getter] of Object.entries(FUNDAMENTAL_FACTORS) as [
        FundamentalFactorName,
        (f: FinancialData) => number,
      ][]) {
        const v = getter(input.financial);
        if (!Number.isFinite(v)) continue;
        const obs: FactorObservation[] = [];
        for (let i = 0; i < bars.length; i++) {
          const returns: Record<number, number> = {};
          let complete = true;
          for (const h of horizons) {
            if (i + h >= bars.length) {
              complete = false;
              break;
            }
            const base = bars[i].close;
            const ahead = bars[i + h].close;
            if (!(base > 0) || !(ahead > 0)) {
              complete = false;
              break;
            }
            returns[h] = ahead / base - 1;
          }
          if (!complete) continue;
          obs.push({ date: bars[i].date, symbol: code, value: v, returns });
        }
        fundamental[name].push(...obs);
      }
    }
  }

  return {
    priceVolume,
    fundamental,
    stocksIncluded,
    stocksSkipped,
  };
}
