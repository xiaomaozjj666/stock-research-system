import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PaperAccount } from '../paperTrading.js';
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
