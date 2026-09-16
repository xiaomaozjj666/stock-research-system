import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PaperAccount, paperMaxOrders, paperMaxEquityPoints } from '../paperTrading.js';
import type { PlaceOrderInput } from '../paperTrading.js';

/** 构造一个初始资金 10 万、交易日 2025-01-02 的账户 */
function makeAccount(opts: ConstructorParameters<typeof PaperAccount>[1] = {}): PaperAccount {
  const acct = new PaperAccount(100000, opts);
  acct.setCurrentDate('2025-01-02');
  return acct;
}

/** 默认买单参数，便于各用例覆盖部分字段 */
function order(over: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return { code: '600519', side: 'buy', type: 'market', quantity: 100, ...over };
}

/** 把 Map 字面量转成 Map<string, number>（用例可读性） */
function closes(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe('PaperAccount 撮合与记账', () => {
  it('市价买单按收盘价成交，扣现金、记持仓、含佣金', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 500 }));
    acct.settleDay(closes({ '600519': 100 }));

    // 成本 = 500*100 + 佣金 15 = 50015
    expect(acct.cash).toBeCloseTo(49985, 2);
    const pos = acct.positions.get('600519')!;
    expect(pos.quantity).toBe(500);
    expect(pos.avgCost).toBeCloseTo(100.03, 2); // 50015/500
    expect(pos.buyDate).toBe('2025-01-02');
    expect(acct.orders[0].status).toBe('filled');
    expect(acct.orders[0].fillPrice).toBe(100);
    expect(acct.orders[0].commission).toBeCloseTo(15, 2);
  });

  it('限价买单：收盘价 ≤ 限价 成交，未触发则当日过期', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ type: 'limit', price: 101, quantity: 500 })); // 触发
    acct.placeOrder(order({ type: 'limit', price: 99, quantity: 500 })); // 不触发
    acct.settleDay(closes({ '600519': 100 }));

    expect(acct.orders[0].status).toBe('filled');
    expect(acct.orders[0].fillPrice).toBe(100);
    expect(acct.orders[1].status).toBe('expired');
    expect(acct.orders[1].rejectReason).toContain('过期');
  });

  it('限价卖单：收盘价 ≥ 限价 成交，未触发则当日过期', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 500 }));
    acct.settleDay(closes({ '600519': 100 })); // 买入 500 @100
    acct.setCurrentDate('2025-01-03');
    acct.placeOrder(order({ side: 'sell', type: 'limit', price: 99, quantity: 200 })); // 触发
    acct.placeOrder(order({ side: 'sell', type: 'limit', price: 101, quantity: 200 })); // 不触发
    acct.settleDay(closes({ '600519': 100 }));

    expect(acct.orders[1].status).toBe('filled');
    expect(acct.orders[1].fillPrice).toBe(100);
    expect(acct.orders[2].status).toBe('expired');
    expect(acct.positions.get('600519')!.quantity).toBe(300);
  });

  it('T+1：当日买入不可当日卖出，次日可卖', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 100 }));
    acct.settleDay(closes({ '600519': 100 })); // 当日买入

    const sellToday = acct.placeOrder(order({ side: 'sell', quantity: 100 }));
    expect(sellToday.status).toBe('rejected');
    expect(sellToday.rejectReason).toContain('T+1');

    acct.setCurrentDate('2025-01-03');
    const sellNext = acct.placeOrder(order({ side: 'sell', quantity: 100 }));
    expect(sellNext.status).toBe('pending');
    acct.settleDay(closes({ '600519': 110 }));
    expect(sellNext.status).toBe('filled');
  });

  it('涨跌停拒单：涨停拒买、跌停拒卖', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 500 }));
    acct.settleDay(closes({ '600519': 10 }), closes({ '600519': 10 })); // 昨收 10

    // 次日收盘 11 = 10*1.1 → 涨停，买单被拒
    acct.setCurrentDate('2025-01-03');
    acct.placeOrder(order({ quantity: 500 }));
    acct.settleDay(closes({ '600519': 11 }), closes({ '600519': 10 }));
    expect(acct.orders[1].status).toBe('rejected');
    expect(acct.orders[1].rejectReason).toContain('涨停');

    // 再次日收盘 9 = 10*0.9 → 跌停，卖单被拒
    acct.setCurrentDate('2025-01-04');
    acct.placeOrder(order({ side: 'sell', quantity: 100 }));
    acct.settleDay(closes({ '600519': 9 }), closes({ '600519': 11 }));
    expect(acct.orders[2].status).toBe('rejected');
    expect(acct.orders[2].rejectReason).toContain('跌停');
  });

  it('停牌/无收盘价拒单', () => {
    const acct = makeAccount();
    const o = acct.placeOrder(order({ quantity: 100 }));
    acct.settleDay(new Map()); // 无任何收盘价
    expect(o.status).toBe('rejected');
    expect(o.rejectReason).toContain('无收盘价');
  });

  it('整手取整：数量向下取整到 100 整数倍，不足一手拒单', () => {
    const acct = makeAccount();
    const o1 = acct.placeOrder(order({ quantity: 250 }));
    expect(o1.status).toBe('pending');
    expect(o1.quantity).toBe(200); // 250 → 200

    const o2 = acct.placeOrder(order({ quantity: 50 }));
    expect(o2.status).toBe('rejected');
    expect(o2.rejectReason).toContain('一手');
  });

  it('卖出收佣金 + 印花税，平仓后现金/持仓正确', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 500 }));
    acct.settleDay(closes({ '600519': 100 })); // 买 500 @100，佣金 15

    acct.setCurrentDate('2025-01-03');
    acct.placeOrder(order({ side: 'sell', quantity: 500 }));
    acct.settleDay(closes({ '600519': 110 }));

    const sell = acct.orders[1];
    expect(sell.fillPrice).toBe(110);
    expect(sell.commission).toBeCloseTo(16.5, 2); // 500*110*0.0003
    expect(sell.stampDuty).toBeCloseTo(27.5, 2); // 500*110*0.0005（2023-08-28 起万5）
    // 现金 = 100000 - 50015 + (55000 - 16.5 - 27.5)
    expect(acct.cash).toBeCloseTo(104941, 2);
    expect(acct.positions.get('600519')).toBeUndefined();
  });

  it('资金不足时买单拒绝成交', () => {
    const acct = makeAccount();
    const o = acct.placeOrder(order({ quantity: 2000 })); // 成本 ≈ 20 万 > 10 万
    acct.settleDay(closes({ '600519': 100 }));
    expect(o.status).toBe('rejected');
    expect(o.rejectReason).toContain('资金不足');
  });

  it('每日净值序列与绩效统计（累计收益 / 最大回撤 / 夏普）', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 800 }));
    acct.settleDay(closes({ '600519': 100 })); // 现金 19976 + 80000 = 99976
    acct.setCurrentDate('2025-01-03');
    acct.settleDay(closes({ '600519': 120 })); // 峰值 115976
    acct.setCurrentDate('2025-01-04');
    acct.settleDay(closes({ '600519': 90 })); // 回撤 91976

    const eq = acct.getDailyEquity();
    expect(eq).toHaveLength(3);
    expect(eq[0]).toEqual({ date: '2025-01-02', value: 99976 });
    expect(eq[1].value).toBe(115976);
    expect(eq[2].value).toBe(91976);

    const stats = acct.computeStats();
    expect(stats.totalDays).toBe(3);
    expect(stats.totalReturnPct).toBeCloseTo(-8.02, 2); // (91976-100000)/100000
    expect(stats.maxDrawdownPct).toBeCloseTo(20.69, 1); // 24000/115976
    expect(stats.sharpeRatio).toBeTypeOf('number'); // 净值点充足时给出夏普
    expect(stats.dailyReturns).toHaveLength(2);
  });

  it('净值点不足时夏普与累计收益为 null', () => {
    const acct = makeAccount();
    const stats = acct.computeStats();
    expect(stats.totalReturnPct).toBeNull();
    expect(stats.maxDrawdownPct).toBeNull();
    expect(stats.sharpeRatio).toBeNull();
    expect(stats.totalDays).toBe(0);
  });
});

describe('PaperAccount 持久化 round-trip', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `paper-trading-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      /* 清理失败不影响用例 */
    }
  });

  it('save/load 后账户状态（现金/持仓/流水/净值/交易日）一致', () => {
    const acct = new PaperAccount(100000, { filePath: tmpFile });
    acct.setCurrentDate('2025-01-02');
    acct.placeOrder(order({ quantity: 500 }));
    acct.settleDay(closes({ '600519': 100 })); // 买 500 @100
    acct.setCurrentDate('2025-01-03');
    acct.placeOrder(order({ side: 'sell', type: 'limit', price: 105, quantity: 200 }));
    acct.settleDay(closes({ '600519': 110 })); // 卖 200 @110
    acct.save();

    const loaded = PaperAccount.load(tmpFile);
    expect(loaded.initialCapital).toBe(100000);
    expect(loaded.currentTradingDate).toBe('2025-01-03');
    expect(loaded.cash).toBeCloseTo(acct.cash, 2);
    expect(loaded.positions.get('600519')!.quantity).toBe(300);
    expect(loaded.orders).toEqual(acct.orders);
    expect(loaded.equityHistory).toEqual(acct.equityHistory);
    expect(loaded.getDailyEquity()).toHaveLength(2);

    // 恢复后的账户可继续撮合
    loaded.setCurrentDate('2025-01-06');
    loaded.placeOrder(order({ side: 'sell', quantity: 300 }));
    loaded.settleDay(closes({ '600519': 120 }));
    expect(loaded.positions.get('600519')).toBeUndefined();
    expect(loaded.getDailyEquity()).toHaveLength(3);
  });
});

describe('PaperAccount 枚举校验（防绕过 T+1 与错误撮合路径）', () => {
  it('非法 side 被拒单，且不会在结算时被当作卖出扣持仓', () => {
    const acct = makeAccount();
    // 先建仓：100 股 @100
    acct.placeOrder(order({ quantity: 100 }));
    acct.settleDay(closes({ '600519': 100 }));
    expect(acct.positions.get('600519')!.quantity).toBe(100);

    // 同日用一个非法 side 试图卖出：修复前它会跳过 T+1 校验（只判 === 'sell'），
    // 并在 settleDay 的 else 分支按卖出处理，从而绕过 T+1。
    const bogus = acct.placeOrder(
      order({ side: 'SELL' as unknown as PlaceOrderInput['side'], quantity: 100 }),
    );
    expect(bogus.status).toBe('rejected');
    expect(bogus.rejectReason).toContain('买卖方向');

    acct.settleDay(closes({ '600519': 105 }));
    // 持仓不变、没有因非法订单被卖出
    expect(acct.positions.get('600519')!.quantity).toBe(100);
  });

  it('非法 type 被拒单，不会进入限价撮合分支', () => {
    const acct = makeAccount();
    const bogus = acct.placeOrder(order({ type: 'LIMIT' as unknown as PlaceOrderInput['type'] }));
    expect(bogus.status).toBe('rejected');
    expect(bogus.rejectReason).toContain('订单类型');
    expect(acct.orders[0].status).toBe('rejected');
  });
});

// ============================================================================
// 容量上限与"截断安全"的绩效统计（审计：orders / equityHistory 无界增长，
// 且每次 save 全量写盘）。要点：
//   - 两个序列都有容量上限（env 可覆盖，非法值回退默认）；
//   - 净值序列截断**不得**改变统计口径：累计天数 / 最大回撤 / 夏普走累计值，
//     save/load 往返也把累计值带上，重启不缩水。
// ============================================================================
describe('PaperAccount 容量上限与截断安全的绩效统计', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    delete process.env.PAPER_MAX_ORDERS;
    delete process.env.PAPER_MAX_EQUITY_POINTS;
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  /** 依次结算 5 个交易日：与既有用例同一组净值（峰值在第 2 天，回撤 20.69%） */
  function settleFiveDays(acct: PaperAccount): void {
    acct.placeOrder(order({ quantity: 800 }));
    acct.settleDay(closes({ '600519': 100 })); //  99976
    acct.setCurrentDate('2025-01-03');
    acct.settleDay(closes({ '600519': 120 })); // 115976（峰值）
    acct.setCurrentDate('2025-01-06');
    acct.settleDay(closes({ '600519': 90 })); //  91976（回撤）
    acct.setCurrentDate('2025-01-07');
    acct.settleDay(closes({ '600519': 95 })); //  95976
    acct.setCurrentDate('2025-01-08');
    acct.settleDay(closes({ '600519': 110 })); // 107976
  }

  it('paperMaxOrders / paperMaxEquityPoints：非法值回退默认', () => {
    delete process.env.PAPER_MAX_ORDERS;
    delete process.env.PAPER_MAX_EQUITY_POINTS;
    const defOrders = paperMaxOrders();
    const defEquity = paperMaxEquityPoints();
    expect(defOrders).toBeGreaterThan(100);
    expect(defEquity).toBeGreaterThan(100);

    for (const bad of ['abc', '0', '-5', '']) {
      process.env.PAPER_MAX_ORDERS = bad;
      process.env.PAPER_MAX_EQUITY_POINTS = bad;
      expect(paperMaxOrders(), `非法值 ${JSON.stringify(bad)}`).toBe(defOrders);
      expect(paperMaxEquityPoints(), `非法值 ${JSON.stringify(bad)}`).toBe(defEquity);
    }

    process.env.PAPER_MAX_ORDERS = '7.9';
    expect(paperMaxOrders()).toBe(7);
  });

  it('PAPER_MAX_ORDERS 上限：只保留最近 N 条订单（淘汰最旧）', () => {
    process.env.PAPER_MAX_ORDERS = '2';
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 100 }));
    acct.settleDay(closes({ '600519': 100 })); // 第 1 单：成交
    acct.setCurrentDate('2025-01-03');
    acct.placeOrder(order({ side: 'sell', quantity: 100 }));
    acct.settleDay(closes({ '600519': 110 })); // 第 2 单：成交
    acct.setCurrentDate('2025-01-06');
    acct.placeOrder(order({ quantity: 100 }));
    acct.settleDay(closes({ '600519': 100 })); // 第 3 单：成交

    expect(acct.orders).toHaveLength(2);
    expect(acct.orders.map((o) => o.side)).toEqual(['sell', 'buy']); // 最旧的买单被淘汰
    expect(acct.orders.map((o) => o.placedDate)).toEqual(['2025-01-03', '2025-01-06']);
  });

  it('未设上限时订单流水不截断（默认上限远大于样本）', () => {
    const acct = makeAccount();
    acct.placeOrder(order({ quantity: 100 }));
    acct.placeOrder(order({ quantity: 100 }));
    acct.placeOrder(order({ quantity: 100 }));
    expect(acct.orders).toHaveLength(3);
  });

  it('PAPER_MAX_EQUITY_POINTS：净值序列截断，但 totalDays/回撤/夏普与全量口径一致', () => {
    const full = makeAccount();
    settleFiveDays(full);

    process.env.PAPER_MAX_EQUITY_POINTS = '3';
    const capped = makeAccount();
    settleFiveDays(capped);

    // 序列本身有界：只留最近 3 个点
    const points = capped.getDailyEquity();
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.date)).toEqual(['2025-01-06', '2025-01-07', '2025-01-08']);
    expect(full.getDailyEquity()).toHaveLength(5);

    // 统计口径不受截断影响：天数=全历史 5 天；峰值在窗口外（第 2 天）仍被计入回撤
    const cappedStats = capped.computeStats();
    const fullStats = full.computeStats();
    expect(cappedStats.totalDays).toBe(5);
    expect(cappedStats.finalEquity).toBe(fullStats.finalEquity);
    expect(cappedStats.totalReturnPct).toBe(fullStats.totalReturnPct);
    expect(cappedStats.maxDrawdownPct).toBeCloseTo(20.69, 1); // 24000/115976
    expect(cappedStats.maxDrawdownPct).toBe(fullStats.maxDrawdownPct);
    expect(cappedStats.sharpeRatio).toBeCloseTo(fullStats.sharpeRatio as number, 6);

    // 逐日收益是"保留窗口内"的有界数组（跨窗口那天由 prevEquity 兜住，不丢）
    expect(cappedStats.dailyReturns).toHaveLength(2);
    expect(fullStats.dailyReturns).toHaveLength(4);
  });

  it('截断后 save/load 往返：累计统计随快照落盘，重启后不缩水', () => {
    process.env.PAPER_MAX_EQUITY_POINTS = '3';
    const tmpFile = path.join(
      os.tmpdir(),
      `paper-cap-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
    );
    try {
      const acct = new PaperAccount(100000, { filePath: tmpFile });
      acct.setCurrentDate('2025-01-02');
      settleFiveDays(acct);
      acct.save();

      const loaded = PaperAccount.load(tmpFile);
      expect(loaded.getDailyEquity()).toHaveLength(3);
      const stats = loaded.computeStats();
      expect(stats.totalDays).toBe(5);
      expect(stats.maxDrawdownPct).toBeCloseTo(20.69, 1);
      expect(stats.sharpeRatio).toBeCloseTo(acct.computeStats().sharpeRatio as number, 6);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('旧快照（无 equitySummary）由完整净值序列重建累计统计，且先重建后截断', () => {
    process.env.PAPER_MAX_EQUITY_POINTS = '2';
    const tmpFile = path.join(
      os.tmpdir(),
      `paper-legacy-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
    );
    try {
      // 模拟"旧版本写出的完整序列快照"：没有 equitySummary 字段
      fs.writeFileSync(
        tmpFile,
        JSON.stringify({
          version: 1,
          initialCapital: 100000,
          cash: 100000,
          currentDate: '2025-01-08',
          options: {},
          positions: {},
          orders: [],
          equityHistory: [
            { date: '2025-01-02', value: 100000 },
            { date: '2025-01-03', value: 115976 },
            { date: '2025-01-06', value: 91976 },
            { date: '2025-01-07', value: 107976 },
          ],
          lastClose: {},
        }),
        'utf-8',
      );

      const loaded = PaperAccount.load(tmpFile);
      expect(loaded.getDailyEquity()).toHaveLength(2); // 已按上限截断
      const stats = loaded.computeStats();
      expect(stats.totalDays).toBe(4); // 但天数来自重建后的累计值
      expect(stats.maxDrawdownPct).toBeCloseTo(20.69, 1); // 峰值 115976 在窗口外仍有效
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});
