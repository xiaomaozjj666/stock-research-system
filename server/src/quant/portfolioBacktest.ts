/**
 * 因子组合回测（Portfolio Backtest）
 * ============================================================================
 * IC / 分层 / OOS 回答「因子有没有区分力」，本模块回答最后一问：
 * **如果真的按这个因子交易，能拿到什么？** —— 调仓日按因子值排序持有 top-N
 * 等权组合、持有 holdDays 个交易日后换仓，A 股双边成本按换手计提，基准为
 * 同宇宙等权组合。这是从「统计显著」到「可交易」之间的桥。
 *
 * 口径与诚实边界：
 *  - 收盘价撮合：调仓日以收盘价建仓/平仓（A股 T+1 下实际次日才能卖，未建模——
 *    对 h ≥ 5 的周期影响有限，对 h = 1 偏乐观）；
 *  - 成本：换手率 × costBps（单边，买卖各计一次）。costBps 默认 30（佣金
 *    万2.5 双边 + 印花税卖出万5 + 滑点余量），可用参数覆盖；
 *  - 涨跌停/停牌不撮合：候选池只含当日有因子观测的股票（停牌/数据缺失自然出局），
 *    涨停无法买入未单独建模（对突破/涨停类因子偏乐观，如实告知）；
 *  - 候选不足 topN 时持有实际数量；候选为空 → 当期空仓（现金收益 0）；
 *  - 基准 = 每期候选宇宙的等权组合（因子中性对照），而非宽基指数——
 *    回答的是「因子选股是否跑赢不选股」，与截面 IC 的语义严格一致。
 *
 * 全部纯函数、确定性、无第三方依赖。
 */
import type { OHLCVData } from './types.js';
import type { FactorObservation } from './factorEvaluation.js';

/** 单次调仓记录 */
export interface RebalanceRecord {
  /** 调仓日 */
  date: string;
  /** 期末日期（下一调仓日前一交易日 / 数据末日） */
  endDate: string;
  /** 持仓代码（按因子值降序） */
  holdings: string[];
  /** 换手率 ∈ [0,1]：与上期持仓相比变动的名额占比（首期为 1） */
  turnover: number;
  /** 本期组合收益（扣费前，小数） */
  grossReturn: number;
  /** 本期成本拖累（小数，负收益形式给出） */
  costDrag: number;
  /** 本期基准（候选宇宙等权）收益（小数） */
  benchmarkReturn: number;
}

export interface PortfolioBacktestResult {
  /** 组合净值曲线（每个调仓期末一个点，起始 1） */
  equityCurve: { date: string; value: number }[];
  /** 基准净值曲线（同口径） */
  benchmarkCurve: { date: string; value: number }[];
  rebalances: RebalanceRecord[];
  /** 总收益（%，扣费后） */
  totalReturn: number;
  /** 年化收益（%，扣费后；按 252/holdDays 期/年复利折算） */
  annualizedReturn: number;
  /** 夏普（期收益 → 年化：×√(252/holdDays)；std=0 时为 0） */
  sharpe: number;
  /** 最大回撤（%，扣费后净值口径） */
  maxDrawdown: number;
  /** 周期胜率（%：跑赢基准的调仓期占比） */
  winRate: number;
  /** 平均换手率 ∈ [0,1] */
  avgTurnover: number;
  /** 调仓期数 */
  periods: number;
}

export interface PortfolioBacktestOptions {
  /** 调仓周期（交易日），默认 21 */
  holdDays?: number;
  /** 持仓只数（等权），默认 5 */
  topN?: number;
  /** 单边成本（基点 bps）：每次换仓按换手率 × costBps 计提（买+卖各一次） */
  costBps?: number;
}

interface Panel {
  /** date → 该日候选观测（symbol → value） */
  byDate: Map<string, { symbol: string; value: number }[]>;
  /** symbol → { date → close } */
  closes: Map<string, Map<string, number>>;
  /** 全体 bars 的交易日历（并集，升序） */
  calendar: string[];
}

function buildPanel(
  observations: FactorObservation[],
  barsBySymbol: Map<string, OHLCVData[]>,
): Panel {
  const byDate = new Map<string, { symbol: string; value: number }[]>();
  for (const o of observations) {
    if (!o.symbol || !Number.isFinite(o.value)) continue;
    const list = byDate.get(o.date);
    if (list) list.push({ symbol: o.symbol, value: o.value });
    else byDate.set(o.date, [{ symbol: o.symbol, value: o.value }]);
  }
  const closes = new Map<string, Map<string, number>>();
  const calSet = new Set<string>();
  for (const [symbol, bars] of barsBySymbol) {
    const m = new Map<string, number>();
    for (const b of bars) {
      if (b.close > 0) m.set(b.date, b.close);
      calSet.add(b.date);
    }
    closes.set(symbol, m);
  }
  return { byDate, closes, calendar: [...calSet].sort((a, b) => a.localeCompare(b)) };
}

/**
 * 因子组合回测主入口。
 *
 * @param observations  因子截面面板（date / symbol / value；价值方向由研究者保证，
 *                      值越大越看多——反向因子请在 DSL 里取负）
 * @param barsBySymbol  逐股 K 线（调仓期起止收盘价的取数来源）
 * @param opts          holdDays / topN / costBps
 * @returns 候选观测不足以构成任何一个调仓期时返回 null（如实拒绝，不出空报告）
 */
export function runPortfolioBacktest(
  observations: FactorObservation[],
  barsBySymbol: Map<string, OHLCVData[]>,
  opts: PortfolioBacktestOptions = {},
): PortfolioBacktestResult | null {
  const holdDays = Math.max(1, Math.floor(opts.holdDays ?? 21));
  const topN = Math.max(1, Math.floor(opts.topN ?? 5));
  const costBps = Math.max(0, opts.costBps ?? 30);

  const panel = buildPanel(observations, barsBySymbol);
  const calendar = panel.calendar;
  if (calendar.length < holdDays * 2) return null; // 连一个完整调仓期都凑不出

  const rebalances: RebalanceRecord[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  const benchmarkCurve: { date: string; value: number }[] = [];
  let equity = 1;
  let bench = 1;
  let prevHoldings: string[] = [];

  for (let start = 0; start + holdDays < calendar.length; start += holdDays) {
    const date = calendar[start];
    const endDate = calendar[start + holdDays];
    const candidates = panel.byDate.get(date) ?? [];

    // 排序取 topN（值降序）；并列按 symbol 字典序稳定排序（可复现）
    const ranked = [...candidates].sort(
      (a, b) => b.value - a.value || a.symbol.localeCompare(b.symbol),
    );
    const holdings = ranked.slice(0, topN).map((c) => c.symbol);

    // 换手率：与上期持仓的名额变动占比；首期为满仓建仓（1）
    const keep = holdings.filter((s) => prevHoldings.includes(s)).length;
    const turnover =
      prevHoldings.length === 0 ? 1 : (holdings.length - keep) / Math.max(holdings.length, 1);

    // 本期收益：等权、期初买期末卖；缺收盘价的持仓按 0 收益剔除出分母
    let gross = 0;
    let counted = 0;
    for (const sym of holdings) {
      const m = panel.closes.get(sym);
      const p0 = m?.get(date);
      const p1 = m?.get(endDate);
      if (p0 === undefined || p1 === undefined) continue;
      gross += p1 / p0 - 1;
      counted += 1;
    }
    const grossReturn = counted > 0 ? gross / counted : 0;
    // 成本：换手 × 单边 bps ×（卖旧 + 买新各一次）
    const costDrag = -(turnover * costBps * 2) / 10_000;
    const netReturn = grossReturn + costDrag;

    // 基准：候选宇宙等权（有首尾收盘价者）
    let bSum = 0;
    let bCount = 0;
    for (const c of candidates) {
      const m = panel.closes.get(c.symbol);
      const p0 = m?.get(date);
      const p1 = m?.get(endDate);
      if (p0 === undefined || p1 === undefined) continue;
      bSum += p1 / p0 - 1;
      bCount += 1;
    }
    const benchReturn = bCount > 0 ? bSum / bCount : 0;

    equity *= 1 + netReturn;
    bench *= 1 + benchReturn;
    equityCurve.push({ date: endDate, value: Math.round(equity * 10_000) / 10_000 });
    benchmarkCurve.push({ date: endDate, value: Math.round(bench * 10_000) / 10_000 });
    rebalances.push({
      date,
      endDate,
      holdings,
      turnover: Math.round(turnover * 10_000) / 10_000,
      grossReturn,
      costDrag,
      benchmarkReturn: benchReturn,
    });
    prevHoldings = holdings;
  }

  if (rebalances.length === 0) return null;

  const periodReturns = rebalances.map((r) => r.grossReturn + r.costDrag);
  const n = periodReturns.length;
  const mean = periodReturns.reduce((a, b) => a + b, 0) / n;
  const std =
    n >= 2 ? Math.sqrt(periodReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const periodsPerYear = 252 / holdDays;
  const total = equity - 1;
  const annualized = Math.pow(equity, periodsPerYear / n) - 1;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
  let peak = 1;
  let maxDd = 0;
  for (const pt of equityCurve) {
    peak = Math.max(peak, pt.value);
    maxDd = Math.max(maxDd, (peak - pt.value) / peak);
  }
  const wins = rebalances.filter((r) => r.grossReturn + r.costDrag > r.benchmarkReturn).length;

  return {
    equityCurve,
    benchmarkCurve,
    rebalances,
    totalReturn: Math.round(total * 10_000) / 100,
    annualizedReturn: Math.round(annualized * 10_000) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    maxDrawdown: Math.round(maxDd * 10_000) / 100,
    winRate: Math.round((wins / n) * 1000) / 10,
    avgTurnover: Math.round((rebalances.reduce((s, r) => s + r.turnover, 0) / n) * 10_000) / 10_000,
    periods: n,
  };
}
