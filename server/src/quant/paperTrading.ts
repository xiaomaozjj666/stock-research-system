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
  stampDutyRate: 0.001, // 卖出印花税：0.1%
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

export class PaperAccount {
  readonly initialCapital: number;
  /** 可用现金 */
  cash: number;
  /** 持仓：code → Position */
  readonly positions: Map<string, Position>;
  /** 完整订单流水（含已成交/过期/拒绝），供审计 */
  readonly orders: PaperOrder[];
  /** 每日净值记录 */
  readonly equityHistory: EquityPoint[];

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

    this.orders.push(order);
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
          pos.avgCost = round2((pos.quantity * pos.avgCost + order.quantity * fprice + commission) / newQty);
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
        Object.assign(order, { status: 'filled', fillDate: date, fillPrice: fprice, filledQuantity: order.quantity, commission });
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
        Object.assign(order, { status: 'filled', fillDate: date, fillPrice: fprice, filledQuantity: order.quantity, commission, stampDuty });
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
    this.equityHistory.push({ date, value: round2(equity) });

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

  /** 绩效统计：累计收益 / 最大回撤 / 简单年化夏普 */
  computeStats(): PaperStats {
    const { equityHistory, initialCapital } = this;
    const finalEquity = equityHistory.length > 0 ? equityHistory[equityHistory.length - 1].value : initialCapital;

    if (equityHistory.length === 0) {
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

    // 最大回撤
    let peak = equityHistory[0].value;
    let maxDrawdownPct = 0;
    for (const p of equityHistory) {
      if (p.value > peak) peak = p.value;
      const dd = ((peak - p.value) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    // 逐日收益率
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityHistory.length; i++) {
      const prev = equityHistory[i - 1].value;
      if (prev > 0) dailyReturns.push((equityHistory[i].value - prev) / prev);
    }

    // 简单年化夏普（无风险利率按 2.5%）；至少 3 个净值点（≥2 个日收益）才有意义
    let sharpeRatio: number | null = null;
    if (dailyReturns.length >= 2) {
      const riskFreeDaily = 0.025 / 252;
      const avg = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
      const excess = avg - riskFreeDaily;
      const std = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avg) ** 2, 0) / dailyReturns.length);
      sharpeRatio = std > 0 ? (excess / std) * Math.sqrt(252) : 0;
    }

    return {
      initialCapital,
      finalEquity: round2(finalEquity),
      totalReturnPct: round2(totalReturnPct),
      maxDrawdownPct: round2(maxDrawdownPct),
      sharpeRatio: sharpeRatio === null ? null : round2(sharpeRatio),
      totalDays: equityHistory.length,
      dailyReturns,
    };
  }

  /** 原子化落盘：先写临时文件再 rename，避免半写快照 */
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
    this.orders.push(order);
    return order;
  }

  /** 撮合期拒单：仅改状态（订单已在流水里） */
  private rejectAt(order: PaperOrder, reason: string): void {
    order.status = 'rejected';
    order.rejectReason = reason;
  }
}
