/**
 * 因子组合回测（Portfolio Backtest）
 * ============================================================================
 * IC / 分层 / OOS 回答「因子有没有区分力」，本模块回答最后一问：
 * **如果真的按这个因子交易，能拿到什么？** —— 调仓日按因子值排序持有 top-N
 * 等权组合、持有 holdDays 个交易日后换仓，A 股双边成本按换手计提，基准为
 * 同宇宙等权组合。这是从「统计显著」到「可交易」之间的桥。
 *
 * 口径与诚实边界：
 *  - **T+1 次日开盘撮合**：t 日收盘计算因子并决策，t+1 开盘价成交建仓/换仓，
 *    持有至 t+1+holdDays 开盘卖出（下一期的建仓日与本期平仓日是同一天——
 *    开盘一笔换仓，与实盘节奏一致）。这同时消除两处乐观偏差：① 同 bar 决策-
 *    成交前视（收盘信号不可能以同一收盘价成交）；② A 股 T+1 卖出约束
 *    （当日买入次日才可卖——本口径天然满足）；
 *  - 成本：**双边成交额占比** × costBps（含留任名额的等权再平衡；候选缩水、
 *    清仓与首期建仓都按真实成交额计提）。costBps 默认 30（佣金
 *    万2.5 双边 + 印花税卖出万5 + 滑点余量），可用参数覆盖；
 *  - 涨跌停/停牌不撮合：候选池只含当日有因子观测的股票（停牌/数据缺失自然出局），
 *    开盘涨停无法买入 / 开盘跌停无法卖出未单独建模（对突破/涨停类因子偏乐观，
 *    如实告知——按板块阈值误判创业板 20% 涨跌幅的代价大于不建模）；
 *  - 成交日缺开盘价（停牌/数据缺失）的持仓按 0 收益剔除出分母；
 *  - 候选不足 topN 时持有实际数量；候选为空 → 当期空仓（现金收益 0）；
 *  - 基准 = 每期候选宇宙的等权组合（因子中性对照），**与组合同一 T+1 开盘
 *    撮合口径**——回答的是「因子选股是否跑赢不选股」，与截面 IC 的语义严格一致。
 *
 * 全部纯函数、确定性、无第三方依赖。
 */
import type { OHLCVData } from './types.js';
import type { FactorObservation } from './factorEvaluation.js';

/** 单次调仓记录 */
export interface RebalanceRecord {
  /** 决策日（t 日收盘计算因子） */
  date: string;
  /** 建仓成交日（t+1 开盘撮合） */
  fillDate: string;
  /** 平仓成交日（t+1+holdDays 开盘撮合；与下一期建仓同日） */
  exitDate: string;
  /** 期末日期（决策网格上下一调仓日前一交易日 / 数据末日） */
  endDate: string;
  /** 持仓代码（按因子值降序） */
  holdings: string[];
  /** 换手率 ∈ [0,1]：与上期持仓相比变动的名额占比（首期为 1） */
  turnover: number;
  /** 本期组合收益（扣费前，小数；按建仓/平仓开盘价计） */
  grossReturn: number;
  /** 本期成本拖累（小数，负收益形式给出） */
  costDrag: number;
  /** 本期基准（候选宇宙等权，同 T+1 开盘撮合口径）收益（小数） */
  benchmarkReturn: number;
}

export interface PortfolioBacktestResult {
  /** 组合净值曲线（每个调仓期平仓成交日一个点，起始 1） */
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
  /** symbol → { date → open }（T+1 开盘撮合的成交价来源） */
  opens: Map<string, Map<string, number>>;
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
  const opens = new Map<string, Map<string, number>>();
  const calSet = new Set<string>();
  for (const [symbol, bars] of barsBySymbol) {
    const om = new Map<string, number>();
    for (const b of bars) {
      if (b.open > 0) om.set(b.date, b.open);
      calSet.add(b.date);
    }
    opens.set(symbol, om);
  }
  return { byDate, opens, calendar: [...calSet].sort((a, b) => a.localeCompare(b)) };
}

/**
 * 因子组合回测主入口。
 *
 * @param observations  因子截面面板（date / symbol / value；价值方向由研究者保证，
 *                      值越大越看多——反向因子请在 DSL 里取负）
 * @param barsBySymbol  逐股 K 线（t+1 开盘成交价与交易日历的取数来源）
 * @param opts          holdDays / topN / costBps
 * @returns 候选观测不足以构成任何一个调仓期时返回 null（如实拒绝，不出空报告）
 */
export function runPortfolioBacktest(
  observations: FactorObservation[],
  barsBySymbol: Map<string, OHLCVData[]>,
  opts: PortfolioBacktestOptions = {},
): PortfolioBacktestResult | null {
  // 参数卫生：NaN 会穿透 Math.max/floor 污染整条净值曲线，非法值一律回落默认
  const sanitizeInt = (v: number | undefined, dflt: number, min: number): number => {
    const n = v !== undefined && Number.isFinite(v) ? Math.floor(v) : dflt;
    return Math.max(min, n);
  };
  const holdDays = sanitizeInt(opts.holdDays, 21, 1);
  const topN = sanitizeInt(opts.topN, 5, 1);
  const costBps =
    opts.costBps !== undefined && Number.isFinite(opts.costBps) ? Math.max(0, opts.costBps) : 30;

  const panel = buildPanel(observations, barsBySymbol);
  const calendar = panel.calendar;
  // 一个完整调仓期需要：决策日 + 次日建仓 + holdDays 后平仓 → 至少 holdDays+2 根 K 线
  if (calendar.length < holdDays + 2) return null;

  const rebalances: RebalanceRecord[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  const benchmarkCurve: { date: string; value: number }[] = [];
  let equity = 1;
  let bench = 1;
  let prevHoldings: string[] = [];

  for (let start = 0; start + holdDays + 1 < calendar.length; start += holdDays) {
    const date = calendar[start];
    const fillDate = calendar[start + 1]; // t+1 开盘建仓
    const endDate = calendar[start + holdDays];
    const exitDate = calendar[start + holdDays + 1]; // t+1+holdDays 开盘平仓
    const candidates = panel.byDate.get(date) ?? [];

    // 排序取 topN（值降序）；并列按 symbol 字典序稳定排序（可复现）
    const ranked = [...candidates].sort(
      (a, b) => b.value - a.value || a.symbol.localeCompare(b.symbol),
    );
    const holdings = ranked.slice(0, topN).map((c) => c.symbol);

    // 换手率（名额占比口径，展示用）：与上期持仓的名额变动占比；首期为满仓建仓（1）
    const keep = holdings.filter((s) => prevHoldings.includes(s)).length;
    const turnover =
      prevHoldings.length === 0 ? 1 : (holdings.length - keep) / Math.max(holdings.length, 1);

    // 成本按**双边成交额占比**计提（等权内部再平衡同样占用成交额）：
    //   卖出 = 被剔除名额 × 1/|上期| + 留任名额权重下降部分（1/|上期| − 1/|当期|）
    //   买入 = 新进名额 × 1/|当期| + 留任名额权重上升部分
    // 等额持仓的常规换仓与「名额换手 × 单边 bps × 2」严格等价；候选缩水/清仓期
    // 名额口径会漏掉「卖出被剔名额」的成交额（此前少计成本），这里按权重补齐；
    // 首期只有买入（此前多计一次卖出），口径更诚实
    const prevW = prevHoldings.length > 0 ? 1 / prevHoldings.length : 0;
    const curW = holdings.length > 0 ? 1 / holdings.length : 0;
    let soldNotional = 0;
    let boughtNotional = 0;
    for (const s of prevHoldings) {
      if (!holdings.includes(s)) soldNotional += prevW;
      else if (curW < prevW) soldNotional += prevW - curW;
    }
    for (const s of holdings) {
      if (!prevHoldings.includes(s)) boughtNotional += curW;
      else if (curW > prevW) boughtNotional += curW - prevW;
    }
    const costDrag = -((soldNotional + boughtNotional) * costBps) / 10_000;

    // 本期收益：等权、t+1 开盘买 / t+1+h 开盘卖；成交日缺开盘价（停牌/数据缺失）
    // 的持仓按 0 收益剔除出分母
    let gross = 0;
    let counted = 0;
    for (const sym of holdings) {
      const om = panel.opens.get(sym);
      const p0 = om?.get(fillDate);
      const p1 = om?.get(exitDate);
      if (p0 === undefined || p1 === undefined) continue;
      gross += p1 / p0 - 1;
      counted += 1;
    }
    const grossReturn = counted > 0 ? gross / counted : 0;
    const netReturn = grossReturn + costDrag;

    // 基准：候选宇宙等权（有成交日开盘价者），与组合同一 T+1 撮合口径
    let bSum = 0;
    let bCount = 0;
    for (const c of candidates) {
      const om = panel.opens.get(c.symbol);
      const p0 = om?.get(fillDate);
      const p1 = om?.get(exitDate);
      if (p0 === undefined || p1 === undefined) continue;
      bSum += p1 / p0 - 1;
      bCount += 1;
    }
    const benchReturn = bCount > 0 ? bSum / bCount : 0;

    equity *= 1 + netReturn;
    bench *= 1 + benchReturn;
    equityCurve.push({ date: exitDate, value: Math.round(equity * 10_000) / 10_000 });
    benchmarkCurve.push({ date: exitDate, value: Math.round(bench * 10_000) / 10_000 });
    rebalances.push({
      date,
      fillDate,
      endDate,
      exitDate,
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
