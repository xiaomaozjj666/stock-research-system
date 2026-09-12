/**
 * 截面因子编排器（Cross-Section Builder）
 * --------------------------------------------------------------------------
 * 把「多只股票的真实行情/财务数据」装配成 factorEvaluation 的 FactorObservation
 * 面板，让既有的截面 IC 评估器（dailyIcSeries 按日跨股票 Spearman + Newey-West +
 * 分层收益）直接吃真实数据，而不是只能靠客户端手工喂 observations。
 *
 * 两类因子来源：
 *   1. 量价因子（priceVolumeFactors）：每股每日一个值，天然带时间变异；
 *   2. 基本面因子（cs_roe / cs_gross_margin / cs_net_profit_growth / cs_debt_ratio /
 *      cs_np_yoy_q / cs_roe_slope）：**PIT（point-in-time）口径**——按季度报告的
 *      公告日（NOTICE_DATE）门控，日期 t 的取值 = t 时点已公告的最新报告。
 *      因子在公告日跳变、其余日子保持。此前「今天的年报值投影回全窗口」的
 *      常数口径存在公告时点前视，已废弃；无季度数据的股票不参与基本面因子
 *      （参与情况由各因子 sampleSize 如实反映）。
 *   3. 两融因子（mg_balance_chg20 / mg_balance_pct，见 marginProvider）：**PIT
 *      且带 T+1 披露延迟**——交易所两融数据 T 日交易、T+1 盘前披露，t 日的因子
 *      值只允许使用严格早于 t 的两融行。无两融数据的股票不参与。
 *
 * 诚实边界：截面框架的统计功效取决于横截面宽度（股票数）。同行业 peer group
 * 通常只有几只，样本 < minStocks 的日期会被丢弃，报告的 sampleSize 会如实反映。
 */
import type { OHLCVData } from './types.js';
import type { FinancialData } from '../types.js';
import type { QuarterlySeries } from '../services/quarterlyFinancials.js';
import {
  computePriceVolumeFactorSeries,
  type PriceVolumeFactorContext,
} from './priceVolumeFactors.js';
import {
  buildPitSnapshots,
  type QuarterlyFactorName,
  type PitSnapshot,
} from './fundamentalDepth.js';
import type { FactorObservation } from './factorEvaluation.js';
import type { StockEventBundle } from './eventProvider.js';
import {
  marginFactorValues,
  MARGIN_FACTOR_NAMES,
  type MarginFactorName,
  type MarginRow,
} from './marginProvider.js';

/** 基本面截面因子名（全部为 PIT 口径，吃公告日门控的季度快照） */
export type FundamentalFactorName =
  'cs_roe' | 'cs_gross_margin' | 'cs_net_profit_growth' | 'cs_debt_ratio' | QuarterlyFactorName;

/** 年报口径因子（as-of 取最新已公告年报） */
export type AnnualFactorName = Exclude<FundamentalFactorName, QuarterlyFactorName>;

/** PIT 因子 → 快照取值器（null/NaN 的日期如实跳过该股该因子） */
const PIT_PICKERS: [FundamentalFactorName, (s: PitSnapshot) => number | null][] = [
  ['cs_roe', (s) => s.roe],
  ['cs_gross_margin', (s) => s.grossMargin],
  ['cs_net_profit_growth', (s) => s.netProfitGrowth],
  ['cs_debt_ratio', (s) => s.debtRatio],
  ['cs_np_yoy_q', (s) => s.npYoYQ],
  ['cs_roe_slope', (s) => s.roeSlope],
];

export interface StockPanelInput {
  code: string;
  bars: OHLCVData[];
  /** 年报快照（仅供不需要时点纪律的场景参考）；基本面面板不再使用（见 PIT 说明） */
  financial?: FinancialData | null;
  /**
   * 季度财报序列：基本面因子（PIT）的数据源。缺省/无公告的股票不参与基本面因子，
   * 量价与事件因子不受影响。
   */
  quarterly?: QuarterlySeries | null;
  /** 公司事件捆绑（分红/回购/解禁，可选）；缺省或 null 时事件族跳过该股 */
  events?: StockEventBundle | null;
  /**
   * 融资融券日度序列（两融因子源，可选）。缺省或空数组时该股不参与两融因子。
   * 注意 PIT 口径差异：两融数据 T+1 盘前披露，因子取值在 marginFactorValues
   * 内强制「只允许严格早于信号日的行」。
   */
  margin?: MarginRow[] | null;
}

/** 基本面面板的全部因子键 */
const FUNDAMENTAL_KEYS: FundamentalFactorName[] = [
  'cs_roe',
  'cs_gross_margin',
  'cs_net_profit_growth',
  'cs_debt_ratio',
  'cs_np_yoy_q',
  'cs_roe_slope',
];

export interface CrossSectionPanel {
  /** 量价因子面板（逐日时间变异） */
  priceVolume: Record<string, FactorObservation[]>;
  /** 基本面因子面板（PIT，公告日门控）；无季度数据的股票不参与 */
  fundamental: Record<FundamentalFactorName, FactorObservation[]>;
  /** 两融因子面板（PIT，T+1 披露延迟）；无两融数据的股票不参与 */
  margin: Record<MarginFactorName, FactorObservation[]>;
  /** 参与组装的股票数与逐股状态（取数失败/数据不足的降级披露） */
  stocksIncluded: string[];
  stocksSkipped: { code: string; reason: string }[];
}

/** 逐值因子（PIT 基本面）的观测序列：值随公告日跳变，null/NaN 日期整行跳过 */
function seriesObservations(
  bars: OHLCVData[],
  code: string,
  values: (number | null)[],
  horizons: number[],
): FactorObservation[] {
  const obs: FactorObservation[] = [];
  for (let i = 0; i < bars.length; i++) {
    const value = values[i];
    if (value === null || !Number.isFinite(value)) continue;
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
    obs.push({ date: bars[i].date, symbol: code, value, returns });
  }
  return obs;
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
  const fundamental = Object.fromEntries(FUNDAMENTAL_KEYS.map((k) => [k, []])) as unknown as Record<
    FundamentalFactorName,
    FactorObservation[]
  >;
  const margin = Object.fromEntries(MARGIN_FACTOR_NAMES.map((k) => [k, []])) as unknown as Record<
    MarginFactorName,
    FactorObservation[]
  >;
  const stocksIncluded: string[] = [];
  const stocksSkipped: { code: string; reason: string }[] = [];

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

    // 基本面因子（PIT）：按公告日门控的 as-of 取值，逐日带 t→t+h 远期收益。
    // 无季度数据的股票不参与基本面因子（量价/事件不受影响，参与度由 sampleSize 披露）
    if (input.quarterly && input.quarterly.reports.length > 0) {
      const barDates = bars.map((b) => b.date);
      const snaps = buildPitSnapshots(input.quarterly.reports, barDates);
      for (const [name, pick] of PIT_PICKERS) {
        fundamental[name].push(
          ...seriesObservations(
            bars,
            code,
            snaps.map((s) => pick(s)),
            horizons,
          ),
        );
      }
    }

    // 两融因子（PIT，T+1 披露延迟）：t 日只用严格早于 t 的两融行（marginProvider
    // 内强制）。无两融序列的股票不参与，参与度由各因子 sampleSize 如实披露。
    if (input.margin && input.margin.length > 0) {
      const values = marginFactorValues(
        input.margin,
        bars.map((b) => b.date),
      );
      for (const name of MARGIN_FACTOR_NAMES) {
        margin[name].push(...seriesObservations(bars, code, values[name], horizons));
      }
    }
  }

  return {
    priceVolume,
    fundamental,
    margin,
    stocksIncluded,
    stocksSkipped,
  };
}
