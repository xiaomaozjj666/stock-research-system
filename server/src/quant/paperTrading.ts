import * as fs from 'fs';
import * as path from 'path';

/**
 * 自建 A 股模拟盘撮合引擎（PaperAccount）
 * ----------------------------------------------------------------------------
 * 为无实盘资金的量化研究提供「日 K 收盘价撮合 + 记账」闭环：策略信号 → 模拟下单 →
 * 日终按收盘价撮合 → 记录每日净值 → 统计绩效（累计收益 / 最大回撤 / 夏普）。
 *
 * 撮合规则（参考调研方案 E，做必要简化）：
 *  - 市价单按当日收盘价成交；
 *  - 限价买单：收盘价 ≤ 限价 成交，限价卖单：收盘价 ≥ 限价 成交，均按收盘价成交；
 *  - 限价单当日收盘未成交则自动过期；
 *  - 整手约束：下单数量向下取整到 100 股整数倍；
 *  - 交易成本：佣金默认万三（可配），卖出加收印花税 0.1%；
 *  - A 股硬规则：T+1（当日买入次日才可卖）、涨跌停拒单（主板 ±10%，可配）、停牌/无收盘价拒单。
 *
 * 持久化方案选型说明：
 *  项目当前无任何 sqlite 依赖；Node 24 的 node:sqlite 仍标记为实验性（API 可能变动），
 *  better-sqlite3 则是原生模块需新增依赖。为求「零第三方依赖、最稳妥」，沿用项目现有
 *  services/watchlistService.ts 的 JSON 文件存储模式，并升级为「临时文件 + 原子 rename」
 *  写入，保证任何时刻磁盘上要么是旧快照要么是新快照，不会出现半写状态。
 *  数据仅在日终 settleDay 后（或显式 save()）落盘，属低频快照，JSON 完全够用。
 */

// 默认交易参数
const DEFAULTS = {
  commissionRate: 0.0003, // 佣金率：万三
  stampDutyRate: 0.0005, // 卖出印花税：万5（2023-08-28 起，与 costModel A_SHARE_COST_MODEL 一致）
  limitPct: 0.1, // 涨跌停幅度：主板 ±10%
};

// 默认持久化文件（测试可通过构造参数或 PAPER_TRADING_FILE 重定向）
const DEFAULT_FILE = path.join(import.meta.dirname, '..', 'data', 'paperTrading.json');

/** 持仓（单代码一档：最近一次买入日用于 T+1 校验） */
export interface Position {
  code: string;
  quantity: number; // 股数（100 整数倍）
  avgCost: number; // 摊薄成本（含买入佣金）
  buyDate: string; // 最近一次买入日期 YYYY-MM-DD
}

/** 订单（含成交/过期/拒绝的完整审计记录） */
export interface PaperOrder {
  id: string;
  code: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  price?: number; // 限价单的申报价
  quantity: number; // 委托数量（已按整手取整）
  placedDate: string; // 下单日期 YYYY-MM-DD
  status: 'pending' | 'filled' | 'expired' | 'rejected';
  fillDate?: string;
  fillPrice?: number;
  filledQuantity?: number;
  commission?: number;
  stampDuty?: number; // 仅卖出产生
  rejectReason?: string;
}

/** 每日净值记录 */
export interface EquityPoint {
  date: string; // YYYY-MM-DD
  value: number; // 现金 + 持仓市值
}

/**
 * 净值序列的累计统计（不随 equityHistory 截断而丢失历史）。
 * ----------------------------------------------------------------------------
 * 为什么要有它：equityHistory 有容量上限（PAPER_MAX_EQUITY_POINTS，默认 2000 点），
 * 而绩效统计（累计天数 / 最大回撤 / 夏普）在语义上依赖**完整序列**——直接截断会让
 * 总天数缩水、让"窗口外的历史峰值"消失从而低估最大回撤。故每记录一个净值点就把
 * 不可从窗口内重建的量累计在这里，截断后 computeStats 仍与截断前逐项一致。
 */
export interface EquitySummary {
  /** 已记录净值点总数（含已被淘汰的）→ totalDays */
  settledDays: number;
  /** 全部净值点的历史最高值（用于最大回撤的起点，截断后仍需保留） */
  peak: number;
  /** 全部历史的最大回撤 %（逐点增量计算，与"全序列重算"等价） */
  maxDrawdownPct: number;
  /** 上一个净值点（用于下一日收益；即使该点已被淘汰也要留着） */
  prevEquity: number;
  /** 逐日收益率的累计一阶/二阶和与个数（用于全历史夏普） */
  returnCount: number;
  returnSum: number;
  returnSumSquares: number;
}

/** 默认订单流水的内存保留条数（PAPER_MAX_ORDERS 可覆盖）：超出即淘汰最旧 */
const ORDERS_MAX_DEFAULT = 2000;
/** 默认净值点保留条数（PAPER_MAX_EQUITY_POINTS 可覆盖）：约 8 年交易日 */
const EQUITY_POINTS_MAX_DEFAULT = 2000;

/**
 * 订单流水保留上限：每次调用时解析（便于测试与运行期调整）。
 * 非法值（非数字 / 小于 1）回退默认——与 watchlistBatchMax() 同一 env 解析口径。
 */
export function paperMaxOrders(): number {
  const raw = Number(process.env.PAPER_MAX_ORDERS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : ORDERS_MAX_DEFAULT;
}

/** 净值点保留上限：解析口径同 paperMaxOrders；统计口径不受其影响（见 EquitySummary） */
export function paperMaxEquityPoints(): number {
  const raw = Number(process.env.PAPER_MAX_EQUITY_POINTS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : EQUITY_POINTS_MAX_DEFAULT;
}

/** 账户绩效统计 */
export interface PaperStats {
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number | null; // 累计收益率 %
  maxDrawdownPct: number | null; // 最大回撤 %
  sharpeRatio: number | null; // 年化夏普（按日收益，无风险利率 2.5%），净值点不足时为 null
  totalDays: number; // 已结算交易天数（净值点数）
  dailyReturns: number[]; // 逐日收益率
}

/** 构造参数 */
export interface PaperTradingOptions {
  filePath?: string; // 持久化文件路径；缺省用 env PAPER_TRADING_FILE 或默认文件
  commissionRate?: number; // 佣金率，默认万三
  stampDutyRate?: number; // 卖出印花税率，默认 0.1%
  limitPct?: number; // 涨跌停幅度，默认 0.1
  initialDate?: string; // 初始交易日 YYYY-MM-DD
  autoSave?: boolean; // 每次 settleDay 后自动落盘（默认 false）
}

/** 下单入参 */
export interface PlaceOrderInput {
  code: string; // 6 位 A 股代码
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  price?: number; // 限价单必填
  quantity: number; // 股数，自动向下取整到整手
}

/** 解析持久化文件路径：显式参数 > 环境变量 > 默认路径 */
function storeFile(filePath?: string): string {
  if (filePath && filePath.length > 0) return filePath;
  if (process.env.PAPER_TRADING_FILE && process.env.PAPER_TRADING_FILE.length > 0) {
    return process.env.PAPER_TRADING_FILE;
  }
  return DEFAULT_FILE;
}

/** 金额保留 2 位小数（分） */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 空白的净值累计统计（新账户 / 旧快照回填起点） */
function emptyEquitySummary(): EquitySummary {
  return {
    settledDays: 0,
    peak: 0,
    maxDrawdownPct: 0,
    prevEquity: 0,
    returnCount: 0,
    returnSum: 0,
    returnSumSquares: 0,
  };
}

/**
 * 只保留最近 limit 条（从头部淘汰最旧）。
 * 订单流水/净值序列都是"追加 + 时间升序"，故头部即最旧；
 * 二者均有容量上限，避免长期运行把内存与落盘快照一起撑大。
 */
function keepRecent<T>(arr: T[], limit: number): void {
  if (arr.length > limit) arr.splice(0, arr.length - limit);
}

/**
 * 把一个净值点并入累计统计（单调增量，与"全序列重算"等价）。
 * 逐日收益率的一阶/二阶矩用 Welford 之外的朴素累计：Σ(r-avg)² = Σr² - n·avg²，
 * 可仅凭 (n, Σr, Σr²) 还原全历史均值/标准差——这正是截断后仍能算对夏普的关键。
 */
function accumulateEquity(s: EquitySummary, value: number): void {
  if (s.settledDays > 0 && s.prevEquity > 0) {
    const r = (value - s.prevEquity) / s.prevEquity;
    s.returnCount += 1;
    s.returnSum += r;
    s.returnSumSquares += r * r;
  }
  if (value > s.peak) s.peak = value;
  // peak 在首个点之后必为正（净值 = 现金 + 市值，恒 > 0），此处仅防御异常快照
  if (s.peak > 0) {
    const dd = ((s.peak - value) / s.peak) * 100;
    if (dd > s.maxDrawdownPct) s.maxDrawdownPct = dd;
  }
  s.settledDays += 1;
  s.prevEquity = value;
}

export class PaperAccount {
  readonly initialCapital: number;
  /** 可用现金 */
  cash: number;
  /** 持仓：code → Position */
  readonly positions: Map<string, Position>;
  /** 完整订单流水（含已成交/过期/拒绝），供审计；只保留最近 paperMaxOrders() 条 */
  readonly orders: PaperOrder[];
  /** 每日净值记录；只保留最近 paperMaxEquityPoints() 条，统计走 equitySummary */
  readonly equityHistory: EquityPoint[];
  /** 净值累计统计（截断安全，随快照落盘） */
  equitySummary: EquitySummary;

  private readonly opts: {
    filePath: string;
    commissionRate: number;
    stampDutyRate: number;
    limitPct: number;
    autoSave: boolean;
  };
  /** 最近收盘价，用于次日涨跌停判断与停牌持仓估值 */
  private lastClose: Map<string, number>;
  private currentDate: string | null;
  private seq = 0;

  constructor(initialCapital: number, options: PaperTradingOptions = {}) {
    if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
      throw new Error('初始资金必须为正数');
    }
    this.initialCapital = initialCapital;
    this.cash = initialCapital;
    this.positions = new Map();
    this.orders = [];
    this.equityHistory = [];
    this.equitySummary = emptyEquitySummary();
    this.opts = {
      filePath: storeFile(options.filePath),
      commissionRate: options.commissionRate ?? DEFAULTS.commissionRate,
      stampDutyRate: options.stampDutyRate ?? DEFAULTS.stampDutyRate,
      limitPct: options.limitPct ?? DEFAULTS.limitPct,
      autoSave: options.autoSave ?? false,
    };
    this.lastClose = new Map();
    this.currentDate = options.initialDate ?? null;
  }

  /** 当前交易日 */
  get currentTradingDate(): string | null {
    return this.currentDate;
  }

  /** 设置当前交易日（日终结算 / 下单均以它为基准） */
  setCurrentDate(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`日期格式应为 YYYY-MM-DD：${date}`);
    }
    this.currentDate = date;
  }

  /** 每日净值序列（返回副本，防外部改动） */
  getDailyEquity(): EquityPoint[] {
    return this.equityHistory.map((p) => ({ ...p }));
  }

  /**
   * 下单：基础校验通过后进入挂单（pending）；校验失败记录为 rejected（入流水）。
   * 卖出的 T+1 与持仓校验在此完成；买方的资金校验留待日终（收盘价未知）。
   */
  placeOrder(input: PlaceOrderInput): PaperOrder {
    const date = this.requireDate();
    const { code, side, type, price } = input;

    const order: PaperOrder = {
      id: `PT-${Date.now()}-${++this.seq}`,
      code,
      side,
      type,
      price: type === 'limit' ? price : undefined,
      quantity: input.quantity,
      placedDate: date,
      status: 'pending',
    };

    // 枚举校验必须前置：非法 side 会跳过下方卖出分支（只判 === 'sell'），
    // 并在结算时落入 else 被当成卖出处理，从而绕过 T+1 约束；
    // 非法 type 则会被当作限价单走错误的撮合路径。路由层已校验，此处兜底防直连引擎。
    if (String(side) !== 'buy' && String(side) !== 'sell') {
      return this.reject(order, '买卖方向无效（应为 buy / sell）');
    }
    if (String(type) !== 'market' && String(type) !== 'limit') {
      return this.reject(order, '订单类型无效（应为 market / limit）');
    }
    if (!/^\d{6}$/.test(code)) return this.reject(order, '股票代码需为 6 位数字');
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      return this.reject(order, '数量必须为正整数');
    }
    if (type === 'limit' && (price === undefined || !Number.isFinite(price) || price <= 0)) {
      return this.reject(order, '限价单需提供正价格');
    }
    // 整手约束：向下取整到 100 股整数倍
    const board = Math.floor(input.quantity / 100) * 100;
    if (board <= 0) return this.reject(order, '数量不足一手（100 股）');
    order.quantity = board;

    if (side === 'sell') {
      const pos = this.positions.get(code);
      if (!pos || pos.quantity <= 0) return this.reject(order, '无持仓，无法卖出');
      if (pos.quantity < board) return this.reject(order, '持仓不足');
      // T+1：当日买入的股票次日才可卖出
      if (pos.buyDate === date) {
        return this.reject(order, `T+1 限制：当日买入（${pos.buyDate}）不可当日卖出`);
      }
    }

    this.recordOrder(order);
    return order;
  }

  /**
   * 日终结算：按收盘价撮合当日所有挂单，追加当日净值，更新昨收。
   * @param closePrices 当日收盘价（缺省的代码视为停牌 → 拒单）
   * @param prevClosePrices 前收盘价（涨跌停判断用）；缺省回退到引擎内部记录
   */
  settleDay(closePrices: Map<string, number>, prevClosePrices?: Map<string, number>): void {
    const date = this.requireDate();
    const pending = this.orders.filter((o) => o.status === 'pending');

    for (const order of pending) {
      const close = closePrices.get(order.code);
      if (close === undefined) {
        this.rejectAt(order, '无收盘价（可能停牌），无法成交');
        continue;
      }
      const prevClose = prevClosePrices?.get(order.code) ?? this.lastClose.get(order.code);

      // 涨跌停拒单：涨停拒买、跌停拒卖
      if (prevClose !== undefined && prevClose > 0) {
        const limitUp = Math.round(prevClose * (1 + this.opts.limitPct) * 100) / 100;
        const limitDown = Math.round(prevClose * (1 - this.opts.limitPct) * 100) / 100;
        if (order.side === 'buy' && close >= limitUp - 1e-9) {
          this.rejectAt(order, '涨停拒买：收盘价触及涨停');
          continue;
        }
        if (order.side === 'sell' && close <= limitDown + 1e-9) {
          this.rejectAt(order, '跌停拒卖：收盘价触及跌停');
          continue;
        }
      }

      // 撮合判定
      let fillPrice: number | null = null;
      if (order.type === 'market') {
        fillPrice = close;
      } else if (order.price !== undefined) {
        if (order.side === 'buy' && close <= order.price + 1e-9) fillPrice = close;
        else if (order.side === 'sell' && close >= order.price - 1e-9) fillPrice = close;
      }
      if (fillPrice === null) continue; // 限价单未触发，日终统一过期

      const fprice = Math.round(fillPrice * 100) / 100;
      const commission = round2(order.quantity * fprice * this.opts.commissionRate);

      if (order.side === 'buy') {
        const cost = round2(order.quantity * fprice + commission);
        if (this.cash + 1e-9 < cost) {
          this.rejectAt(order, '资金不足');
          continue;
        }
        this.cash = round2(this.cash - cost);
        const pos = this.positions.get(order.code);
        if (pos) {
          const newQty = pos.quantity + order.quantity;
          pos.avgCost = round2(
            (pos.quantity * pos.avgCost + order.quantity * fprice + commission) / newQty,
          );
          pos.quantity = newQty;
          pos.buyDate = date;
        } else {
          this.positions.set(order.code, {
            code: order.code,
            quantity: order.quantity,
            avgCost: round2((order.quantity * fprice + commission) / order.quantity),
            buyDate: date,
          });
        }
        Object.assign(order, {
          status: 'filled',
          fillDate: date,
          fillPrice: fprice,
          filledQuantity: order.quantity,
          commission,
        });
      } else {
        // 卖出：成交时复核持仓（防多笔卖单同日集中成交导致超卖）
        const pos = this.positions.get(order.code);
        if (!pos || pos.quantity < order.quantity) {
          this.rejectAt(order, '成交时持仓不足');
          continue;
        }
        const stampDuty = round2(order.quantity * fprice * this.opts.stampDutyRate);
        const revenue = round2(order.quantity * fprice - commission - stampDuty);
        this.cash = round2(this.cash + revenue);
        pos.quantity -= order.quantity;
        if (pos.quantity <= 0) this.positions.delete(order.code);
        Object.assign(order, {
          status: 'filled',
          fillDate: date,
          fillPrice: fprice,
          filledQuantity: order.quantity,
          commission,
          stampDuty,
        });
      }
    }

    // 日终：剩余未成交限价单过期
    for (const order of pending) {
      if (order.status === 'pending') {
        order.status = 'expired';
        order.rejectReason = '限价单当日收盘未成交，已过期';
      }
    }

    // 记录当日净值（停牌持仓以最近收盘价/成本兜底估值）
    const equity = this.markToMarket(closePrices);
    this.recordEquity(date, round2(equity));

    // 更新昨收
    for (const [code, close] of closePrices) this.lastClose.set(code, close);

    if (this.opts.autoSave) this.save();
  }

  /** 计算当日净值 = 现金 + Σ 持仓市值 */
  private markToMarket(closePrices: Map<string, number>): number {
    let total = this.cash;
    for (const [code, pos] of this.positions) {
      const price = closePrices.get(code) ?? this.lastClose.get(code) ?? pos.avgCost;
      total += pos.quantity * price;
    }
    return total;
  }

  /**
   * 绩效统计：累计收益 / 最大回撤 / 简单年化夏普。
   * ------------------------------------------------------------------
   * 统计口径**不受 equityHistory 容量上限影响**：
   *  - totalDays 取累计净值点数（settledDays）；
   *  - 最大回撤用逐点增量算好的累计值（保留"窗口外的历史峰值"）；
   *  - 夏普用全历史逐日收益的 (n, Σr, Σr²) 累计量；
   *  - 只有 dailyReturns 是"保留窗口内"的逐日收益（有界数组，供前端画图）。
   */
  computeStats(): PaperStats {
    const { equityHistory, initialCapital, equitySummary } = this;
    const finalEquity =
      equityHistory.length > 0 ? equityHistory[equityHistory.length - 1].value : initialCapital;

    if (equitySummary.settledDays === 0) {
      return {
        initialCapital,
        finalEquity,
        totalReturnPct: null,
        maxDrawdownPct: null,
        sharpeRatio: null,
        totalDays: 0,
        dailyReturns: [],
      };
    }

    const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

    // 逐日收益率（保留窗口内；跨窗口的那一天由 prevEquity 兜住，见 recordEquity）
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityHistory.length; i++) {
      const prev = equityHistory[i - 1].value;
      if (prev > 0) dailyReturns.push((equityHistory[i].value - prev) / prev);
    }

    // 简单年化夏普（无风险利率按 2.5%）；至少 3 个净值点（≥2 个日收益）才有意义。
    // 用累计量算全历史均值/标准差：Σ(r-avg)² = Σr² - n·avg²（截断后仍与全序列一致）
    let sharpeRatio: number | null = null;
    const n = equitySummary.returnCount;
    if (n >= 2) {
      const riskFreeDaily = 0.025 / 252;
      const avg = equitySummary.returnSum / n;
      const excess = avg - riskFreeDaily;
      const variance = Math.max(0, equitySummary.returnSumSquares / n - avg * avg);
      const std = Math.sqrt(variance);
      sharpeRatio = std > 0 ? (excess / std) * Math.sqrt(252) : 0;
    }

    return {
      initialCapital,
      finalEquity: round2(finalEquity),
      totalReturnPct: round2(totalReturnPct),
      maxDrawdownPct: round2(equitySummary.maxDrawdownPct),
      sharpeRatio: sharpeRatio === null ? null : round2(sharpeRatio),
      totalDays: equitySummary.settledDays,
      dailyReturns,
    };
  }

  /**
   * 原子化落盘：先写临时文件再 rename，避免半写快照。
   * 仍是"全量重写"，但订单/净值序列都有容量上限（paperMaxOrders / paperMaxEquityPoints），
   * 故单次写入量有界，不会随运行时长无限膨胀。
   */
  save(): void {
    const file = this.opts.filePath;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = {
      version: 1,
      initialCapital: this.initialCapital,
      cash: this.cash,
      currentDate: this.currentDate,
      options: {
        commissionRate: this.opts.commissionRate,
        stampDutyRate: this.opts.stampDutyRate,
        limitPct: this.opts.limitPct,
      },
      positions: Object.fromEntries(this.positions),
      orders: this.orders,
      equityHistory: this.equityHistory,
      // 累计统计随快照落盘：否则"存盘→读盘"会把截断后的窗口当成全历史，
      // 总天数/最大回撤/夏普会在重启后静默缩水
      equitySummary: this.equitySummary,
      lastClose: Object.fromEntries(this.lastClose),
    };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件清理失败不影响主流程 */
      }
      throw e;
    }
  }

  /** 从磁盘快照恢复账户（缺文件/坏文件将抛错） */
  static load(filePath: string): PaperAccount {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as {
      initialCapital: number;
      cash: number;
      currentDate: string | null;
      options?: Partial<PaperTradingOptions>;
      positions?: Record<string, Position>;
      orders?: PaperOrder[];
      equityHistory?: EquityPoint[];
      /** 累计统计（新快照带；旧快照缺省时由完整序列重建） */
      equitySummary?: EquitySummary;
      lastClose?: Record<string, number>;
    };
    const acct = new PaperAccount(data.initialCapital, {
      filePath,
      commissionRate: data.options?.commissionRate,
      stampDutyRate: data.options?.stampDutyRate,
      limitPct: data.options?.limitPct,
      initialDate: data.currentDate ?? undefined,
    });
    acct.cash = data.cash;
    acct.currentDate = data.currentDate ?? null;
    acct.lastClose = new Map(Object.entries(data.lastClose ?? {}));
    acct.positions.clear();
    for (const [code, pos] of Object.entries(data.positions ?? {})) acct.positions.set(code, pos);
    acct.orders.length = 0;
    acct.orders.push(...(data.orders ?? []));
    acct.equityHistory.length = 0;
    acct.equityHistory.push(...(data.equityHistory ?? []));
    // 顺序：先定累计统计（旧快照用完整序列重建），再套用容量上限截断，
    // 否则旧快照的历史峰值/天数会在截断后永久丢失
    if (data.equitySummary) acct.equitySummary = { ...emptyEquitySummary(), ...data.equitySummary };
    else acct.rebuildEquitySummary();
    keepRecent(acct.orders, paperMaxOrders());
    keepRecent(acct.equityHistory, paperMaxEquityPoints());
    return acct;
  }

  private requireDate(): string {
    if (!this.currentDate) {
      throw new Error('未设置交易日：请先调用 setCurrentDate()');
    }
    return this.currentDate;
  }

  /** 下单校验失败：记录 rejected 并纳入订单流水 */
  private reject(order: PaperOrder, reason: string): PaperOrder {
    order.status = 'rejected';
    order.rejectReason = reason;
    this.recordOrder(order);
    return order;
  }

  /** 撮合期拒单：仅改状态（订单已在流水里） */
  private rejectAt(order: PaperOrder, reason: string): void {
    order.status = 'rejected';
    order.rejectReason = reason;
  }

  /**
   * 订单入流水（唯一入口）：超上限即淘汰最旧。
   * 淘汰安全性：pending 单的生命周期不超过一个交易日（settleDay 结束时会全部成交或过期），
   * 而默认上限 2000 条——同一交易日内先挂 2000 单以上才会把尚未结算的挂单挤掉。
   */
  private recordOrder(order: PaperOrder): void {
    this.orders.push(order);
    keepRecent(this.orders, paperMaxOrders());
  }

  /**
   * 净值入序列（唯一入口）：先累计统计、再追加与截断。
   * 顺序很重要——累计量必须在截断前更新，且跨窗口的那一天要靠 prevEquity 兜住，
   * 否则截断后第一天的收益会被当成"没有前一天"而丢失。
   */
  private recordEquity(date: string, value: number): void {
    accumulateEquity(this.equitySummary, value);
    this.equityHistory.push({ date, value });
    keepRecent(this.equityHistory, paperMaxEquityPoints());
  }

  /**
   * 由完整净值序列重建累计统计（旧快照没有 equitySummary 字段时用）。
   * 旧快照保存的是**未截断**的完整序列，故重建结果与历史口径一致。
   */
  private rebuildEquitySummary(): void {
    const summary = emptyEquitySummary();
    for (const p of this.equityHistory) accumulateEquity(summary, p.value);
    this.equitySummary = summary;
  }
}
