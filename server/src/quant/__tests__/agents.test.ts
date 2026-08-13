import { describe, it, expect, vi } from 'vitest';
import { backtestAuditor } from '../agents/backtestAuditor.js';
import { dataEngineer } from '../agents/dataEngineer.js';
import { parseStrategyInput, orchestrate, generateSummary } from '../agents/orchestrator.js';
import { strategyOptimizer } from '../agents/strategyOptimizer.js';
import type {
  AuditReport,
  BacktestResult,
  DataQualityReport,
  OHLCVData,
  OptimizationReport,
  StrategyConfig,
  Trade,
} from '../types.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeBar(date: string, close = 100, volume = 1_000_000): OHLCVData {
  return { date, open: close, high: close, low: close, close, volume };
}

function makeStrategy(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    name: '测试策略',
    type: 'ma_cross',
    stockCode: '600519',
    params: { shortPeriod: 5, longPeriod: 20 },
    startDate: '2023-01-01',
    endDate: '2025-01-01',
    commission: 0.0003,
    slippage: 0.001,
    ...overrides,
  };
}

function makeTrade(date: string, type: Trade['type'], price: number): Trade {
  return { date, type, price, shares: 100, commission: 0, reason: '' };
}

function makeBacktest(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    totalReturn: 10,
    annualizedReturn: 15,
    sharpeRatio: 1.5,
    maxDrawdown: 10,
    winRate: 50,
    tradeCount: 50,
    profitFactor: 1.5,
    equityCurve: [{ date: '2024-01-02', value: 100 }],
    trades: [],
    benchmark: [],
    ...overrides,
  };
}

function makeAudit(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    riskScore: 80,
    futureFunctionRisk: 'low',
    overfittingRisk: 'low',
    survivorshipBias: 'low',
    checks: [],
    issues: [],
    reliability: '回测结果可信度较高，可作为参考依据',
    ...overrides,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 生成 count 个连续工作日（YYYY-MM-DD） */
function tradingWeekdays(count: number, start = '2024-01-02'): string[] {
  const out: string[] = [];
  const d = new Date(start + 'T00:00:00');
  while (out.length < count) {
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(fmt(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// backtestAuditor
// ---------------------------------------------------------------------------

describe('backtestAuditor', () => {
  it('全部检查通过时 riskScore=100、风险全 low、可靠性最高', () => {
    const report = backtestAuditor(makeBacktest(), makeStrategy());
    expect(report.riskScore).toBe(100);
    expect(report.futureFunctionRisk).toBe('low');
    expect(report.overfittingRisk).toBe('low');
    expect(report.survivorshipBias).toBe('low');
    expect(report.reliability).toBe('回测结果可信度较高，可作为参考依据');
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it('未来函数：乱序交易 → critical + 扣20分 + high 风险', () => {
    const trades = [makeTrade('2024-01-10', 'buy', 100), makeTrade('2024-01-05', 'sell', 110)];
    const report = backtestAuditor(makeBacktest({ trades }), makeStrategy());
    const check = report.checks.find((c) => c.name === '未来函数检查')!;
    expect(check.passed).toBe(false);
    expect(check.severity).toBe('critical');
    expect(check.detail).toBe('交易记录未按时间顺序排列，可能存在未来数据泄露');
    expect(report.futureFunctionRisk).toBe('high');
    expect(report.riskScore).toBe(80);
    expect(report.issues).toContain(check.detail);
  });

  it('未来函数：参数周期超过数据范围一半 → warning + 扣15分 + medium 风险', () => {
    const report = backtestAuditor(
      makeBacktest(),
      makeStrategy({
        startDate: '2023-06-01',
        endDate: '2025-01-01', // 约580天，参数500天 > 一半
        params: { shortPeriod: 5, longPeriod: 500 },
      }),
    );
    const check = report.checks.find((c) => c.name === '未来函数检查')!;
    expect(check.passed).toBe(false);
    expect(check.severity).toBe('warning');
    expect(check.detail).toBe('策略参数周期超过数据范围一半，可能使用了未来数据');
    expect(report.futureFunctionRisk).toBe('medium');
    expect(report.riskScore).toBe(85);
  });

  it('过拟合：交易少且收益高 → critical + 扣25分 + high 风险', () => {
    const report = backtestAuditor(
      makeBacktest({ tradeCount: 3, annualizedReturn: 60 }),
      makeStrategy(),
    );
    const check = report.checks.find((c) => c.name === '过拟合风险')!;
    expect(check.passed).toBe(false);
    expect(check.severity).toBe('critical');
    expect(check.detail).toBe('交易仅3次且年化收益60.0%异常高，过拟合风险极高');
    expect(report.overfittingRisk).toBe('high');
    expect(report.riskScore).toBe(67); // 过拟合(-25) + 统计不足(-8)
  });

  it('过拟合：仅交易次数少 → warning + 扣15分 + medium 风险', () => {
    const report = backtestAuditor(
      makeBacktest({ tradeCount: 5, annualizedReturn: 10 }),
      makeStrategy(),
    );
    const check = report.checks.find((c) => c.name === '过拟合风险')!;
    expect(check.severity).toBe('warning');
    expect(check.detail).toBe('交易仅5次，样本不足可能导致过拟合');
    expect(report.overfittingRisk).toBe('medium');
    expect(report.riskScore).toBe(77); // 过拟合(-15) + 统计不足(-8)
  });

  it('过拟合：仅收益异常高 → warning + 扣10分 + medium 风险', () => {
    const report = backtestAuditor(
      makeBacktest({ tradeCount: 20, annualizedReturn: 60 }),
      makeStrategy(),
    );
    const check = report.checks.find((c) => c.name === '过拟合风险')!;
    expect(check.severity).toBe('warning');
    expect(check.detail).toBe('年化收益60.0%异常高，可能存在过拟合');
    expect(report.overfittingRisk).toBe('medium');
    expect(report.riskScore).toBe(82); // 过拟合(-10) + 统计不足(-8)
  });

  it('幸存者偏差：总是 info 提示（含股票代码）', () => {
    const report = backtestAuditor(makeBacktest(), makeStrategy({ stockCode: '000001' }));
    const check = report.checks.find((c) => c.name === '幸存者偏差')!;
    expect(check.passed).toBe(true);
    expect(check.severity).toBe('info');
    expect(check.detail).toContain('000001');
    expect(report.survivorshipBias).toBe('low');
    expect(report.riskScore).toBe(100);
  });

  it('交易成本：佣金过低且无滑点 → warning + 扣10分', () => {
    const report = backtestAuditor(
      makeBacktest(),
      makeStrategy({ commission: 0.0001, slippage: 0 }),
    );
    const check = report.checks.find((c) => c.name === '交易成本假设')!;
    expect(check.passed).toBe(false);
    expect(check.severity).toBe('warning');
    expect(check.detail).toContain('1.0‱');
    expect(check.detail).toContain('交易成本假设不充分');
    expect(report.riskScore).toBe(90);
  });

  it('交易成本：仅佣金过低 → 扣10分', () => {
    const report = backtestAuditor(
      makeBacktest(),
      makeStrategy({ commission: 0.0001, slippage: 0.001 }),
    );
    const check = report.checks.find((c) => c.name === '交易成本假设')!;
    expect(check.detail).toContain('建议不低于万二');
    expect(report.riskScore).toBe(90);
  });

  it('交易成本：仅无滑点 → 扣5分', () => {
    const report = backtestAuditor(
      makeBacktest(),
      makeStrategy({ commission: 0.0003, slippage: 0 }),
    );
    const check = report.checks.find((c) => c.name === '交易成本假设')!;
    expect(check.detail).toContain('未考虑滑点成本');
    expect(report.riskScore).toBe(95);
  });

  it('统计可靠性：交易不足且回测不足1年 → 扣15分', () => {
    const report = backtestAuditor(
      makeBacktest({ tradeCount: 10, annualizedReturn: 20 }),
      makeStrategy({ startDate: '2024-03-01', endDate: '2024-12-31' }),
    );
    const check = report.checks.find((c) => c.name === '统计可靠性')!;
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('统计可靠性不足');
    expect(check.detail).toContain('建议≥30');
    expect(check.detail).toContain('建议≥1年');
    expect(report.riskScore).toBe(85);
  });

  it('统计可靠性：仅交易不足 → 扣8分', () => {
    const report = backtestAuditor(
      makeBacktest({ tradeCount: 20, annualizedReturn: 20 }),
      makeStrategy(),
    );
    const check = report.checks.find((c) => c.name === '统计可靠性')!;
    expect(check.detail).toContain('建议至少30次交易');
    expect(report.riskScore).toBe(92);
  });

  it('统计可靠性：仅回测年限不足 → 扣8分', () => {
    const report = backtestAuditor(
      makeBacktest({ tradeCount: 40, annualizedReturn: 20 }),
      makeStrategy({ startDate: '2024-03-01', endDate: '2024-12-31' }),
    );
    const check = report.checks.find((c) => c.name === '统计可靠性')!;
    expect(check.detail).toContain('建议至少覆盖1年');
    expect(report.riskScore).toBe(92);
  });

  it('可靠性分级：60~79 → 谨慎参考', () => {
    const trades = [makeTrade('2024-01-10', 'buy', 100), makeTrade('2024-01-05', 'sell', 110)];
    const report = backtestAuditor(
      makeBacktest({ trades, tradeCount: 10, annualizedReturn: 20 }),
      makeStrategy({
        startDate: '2024-12-01',
        endDate: '2024-12-31',
        slippage: 0,
      }),
    );
    // 未来(-20) + 滑点(-5) + 统计(-15) = 60
    expect(report.riskScore).toBe(60);
    expect(report.reliability).toBe('回测结果存在一定风险，建议谨慎参考');
  });

  it('可靠性分级：40~59 → 需要修正后重新验证', () => {
    const trades = [makeTrade('2024-01-10', 'buy', 100), makeTrade('2024-01-05', 'sell', 110)];
    const report = backtestAuditor(
      makeBacktest({ trades, tradeCount: 3, annualizedReturn: 60 }),
      makeStrategy(),
    );
    // 未来(-20) + 过拟合(-25) + 统计(-8) = 47
    expect(report.riskScore).toBe(47);
    expect(report.reliability).toBe('回测结果可信度较低，需要修正后重新验证');
  });

  it('可靠性分级：<40 → 不可信', () => {
    const trades = [makeTrade('2024-01-10', 'buy', 100), makeTrade('2024-01-05', 'sell', 110)];
    const report = backtestAuditor(
      makeBacktest({ trades, tradeCount: 3, annualizedReturn: 60 }),
      makeStrategy({
        startDate: '2024-12-01',
        endDate: '2024-12-31',
        params: { shortPeriod: 5, longPeriod: 500 },
        commission: 0.0001,
        slippage: 0,
      }),
    );
    // 未来(-20) + 过拟合(-25) + 成本(-10) + 统计(-15) = 30
    expect(report.riskScore).toBe(30);
    expect(report.reliability).toBe('回测结果不可信，存在严重方法论问题');
  });

  it('缺失 trades/tradeCount 字段时安全降级为默认值', () => {
    const { trades, tradeCount, ...rest } = makeBacktest();
    const report = backtestAuditor(rest as BacktestResult, makeStrategy());
    // tradeCount 默认 0 → 过拟合(-15) + 统计(-8) = 77
    expect(report.riskScore).toBe(77);
    expect(report.overfittingRisk).toBe('medium');
    expect(report.checks).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// dataEngineer
// ---------------------------------------------------------------------------

describe('dataEngineer', () => {
  it('空数组安全返回 100 分与空范围', () => {
    const report = dataEngineer([]);
    expect(report.overallScore).toBe(100);
    expect(report.totalRecords).toBe(0);
    expect(report.missingDates).toEqual([]);
    expect(report.outliers).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.issues).toEqual([]);
    expect(report.dataRange).toEqual({ start: '', end: '', tradingDays: 0 });
  });

  it('连续无重复的干净数据：100 分', () => {
    const data = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'].map((d) => makeBar(d));
    const report = dataEngineer(data);
    expect(report.overallScore).toBe(100);
    expect(report.totalRecords).toBe(4);
    expect(report.dataRange.tradingDays).toBe(4);
    expect(report.duplicates).toEqual([]);
    expect(report.missingDates).toEqual([]);
    expect(report.outliers).toEqual([]);
    expect(report.issues).toEqual([]);
    expect(report.dataRange.start).toBe('2024-01-02');
    expect(report.dataRange.end).toBe('2024-01-05');
  });

  it('重复日期：每个重复日期扣5分并提示', () => {
    const report = dataEngineer([
      makeBar('2024-01-02'),
      makeBar('2024-01-02'),
      makeBar('2024-01-03'),
    ]);
    expect(report.duplicates).toEqual(['2024-01-02']);
    expect(report.overallScore).toBe(95);
    expect(report.issues).toContain('发现 1 个重复日期: 2024-01-02');
    expect(report.suggestions).toContain('去除重复日期的数据记录');
  });

  it('重复日期超过5个：展示前5个并加省略号', () => {
    const dates = tradingWeekdays(7);
    const data = dates.flatMap((d) => [makeBar(d), makeBar(d)]);
    const report = dataEngineer(data);
    expect(report.duplicates).toHaveLength(7);
    expect(report.overallScore).toBe(100 - 7 * 5);
    const msg = report.issues.find((i) => i.includes('重复日期'))!;
    expect(msg).toContain('...');
  });

  it('乱序日期：扣10分', () => {
    const report = dataEngineer([
      makeBar('2024-01-03'),
      makeBar('2024-01-02'),
      makeBar('2024-01-04'),
    ]);
    expect(report.overallScore).toBe(90);
    expect(report.issues).toContain('日期未按升序排列');
    expect(report.suggestions).toContain('按日期升序重新排列数据');
  });

  it('缺失工作日（跳过周末）：每个缺失交易日扣2分', () => {
    const report = dataEngineer([makeBar('2024-01-02'), makeBar('2024-01-05')]);
    expect(report.missingDates).toHaveLength(2); // 01-03, 01-04
    expect(report.overallScore).toBe(96);
    expect(report.issues.some((i) => i.includes('发现 2 个缺失交易日'))).toBe(true);
    expect(report.suggestions).toContain('补充缺失交易日数据或确认停牌信息');
  });

  it('周末缺口不算缺失交易日', () => {
    // 周五 → 周一，中间周末不扣分
    const report = dataEngineer([makeBar('2024-01-05'), makeBar('2024-01-08')]);
    expect(report.missingDates).toEqual([]);
    expect(report.overallScore).toBe(100);
  });

  it('价格涨跌幅超 ±11% 记为异常值', () => {
    const report = dataEngineer([makeBar('2024-01-02', 100), makeBar('2024-01-03', 120)]);
    const outlier = report.outliers.find((o) => o.field === 'close')!;
    expect(outlier).toBeDefined();
    expect(outlier.value).toBe(20);
    expect(report.overallScore).toBe(97);
  });

  it('价格大跌同样触发异常值（负值）', () => {
    const report = dataEngineer([makeBar('2024-01-02', 100), makeBar('2024-01-03', 80)]);
    const outlier = report.outliers.find((o) => o.field === 'close')!;
    expect(outlier).toBeDefined();
    expect(outlier.value).toBe(-20);
  });

  it('成交量为 0 记为异常值', () => {
    const report = dataEngineer([
      makeBar('2024-01-02', 100, 1_000_000),
      makeBar('2024-01-03', 100, 0),
    ]);
    const outlier = report.outliers.find((o) => o.field === 'volume')!;
    expect(outlier).toBeDefined();
    expect(outlier.value).toBe(0);
    expect(report.overallScore).toBe(97);
  });

  it('前收盘价为0时跳过涨跌幅计算', () => {
    const report = dataEngineer([makeBar('2024-01-02', 0), makeBar('2024-01-03', 100)]);
    expect(report.outliers.some((o) => o.field === 'close')).toBe(false);
  });

  it('成交量超过平均值10倍记为异常值', () => {
    const dates = tradingWeekdays(11);
    const data = dates.map((d, i) => makeBar(d, 100, i === 10 ? 200_000_000 : 1_000_000));
    const report = dataEngineer(data);
    const outlier = report.outliers.find((o) => o.field === 'volume')!;
    expect(outlier).toBeDefined();
    expect(outlier.value).toBe(200_000_000);
    expect(outlier.expected).toContain('10倍以内');
    expect(report.overallScore).toBe(97);
  });

  it('评分下限为 0（大量重复日期）', () => {
    const dates = tradingWeekdays(21);
    const data = dates.flatMap((d) => [makeBar(d), makeBar(d)]);
    const report = dataEngineer(data);
    expect(report.duplicates).toHaveLength(21);
    expect(report.overallScore).toBe(0); // 100 - 21*5 = -5 → clamp 0
  });
});

// ---------------------------------------------------------------------------
// parseStrategyInput
// ---------------------------------------------------------------------------

describe('parseStrategyInput', () => {
  it('结构化配置原样返回', () => {
    const cfg = makeStrategy();
    expect(parseStrategyInput(cfg)).toBe(cfg);
  });

  it('无关键词时生成 ma_cross 默认配置', () => {
    const cfg = parseStrategyInput('随便分析一下');
    expect(cfg.type).toBe('ma_cross');
    expect(cfg.name).toBe('自定义策略');
    expect(cfg.stockCode).toBe('600519');
    expect(cfg.params).toEqual({ shortPeriod: 5, longPeriod: 20 });
  });

  it('动量关键词（中文/英文）', () => {
    expect(parseStrategyInput('帮我分析动量策略').type).toBe('momentum');
    expect(parseStrategyInput('momentum strategy').type).toBe('momentum');
    const cfg = parseStrategyInput('动量策略');
    expect(cfg.name).toBe('动量策略');
    expect(cfg.params).toEqual({ lookback: 20, buyThreshold: 5, sellThreshold: -3 });
  });

  it('均值回归关键词（中文/英文）', () => {
    expect(parseStrategyInput('均值回归策略').type).toBe('mean_reversion');
    expect(parseStrategyInput('mean reversion').type).toBe('mean_reversion');
    const cfg = parseStrategyInput('均值回归');
    expect(cfg.name).toBe('均值回归策略');
    expect(cfg.params).toEqual({
      maPeriod: 20,
      buyDeviation: -3,
      sellDeviation: 3,
    });
  });

  it('均线交叉 + 日数后跟短/长 提取参数', () => {
    const cfg = parseStrategyInput('5日短均线，20日长均线');
    expect(cfg.type).toBe('ma_cross');
    expect(cfg.name).toBe('均线交叉策略');
    expect(cfg.params.shortPeriod).toBe(5);
    expect(cfg.params.longPeriod).toBe(20);
  });

  it('均线交叉 + 短/长 前缀 提取参数', () => {
    const cfg = parseStrategyInput('快速5日均线，慢速20日均线');
    expect(cfg.params.shortPeriod).toBe(5);
    expect(cfg.params.longPeriod).toBe(20);
  });

  it('提取6位股票代码', () => {
    const cfg = parseStrategyInput('分析600519的双均线策略');
    expect(cfg.stockCode).toBe('600519');
    expect(cfg.type).toBe('ma_cross');
  });
});

// ---------------------------------------------------------------------------
// orchestrate
// ---------------------------------------------------------------------------

describe('orchestrate', () => {
  it('依次执行 数据检查→审计→优化 并汇报进度', async () => {
    const onProgress = vi.fn();
    const data = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'].map((d) => makeBar(d));
    const res = await orchestrate(makeStrategy(), data, makeBacktest(), onProgress);

    expect(res.dataQuality.overallScore).toBe(100);
    expect(res.audit.riskScore).toBe(100);
    expect(res.optimization.performanceScore).toBe(100);
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      'data_check',
      'audit',
      'optimization',
      'complete',
    ]);
    expect(onProgress.mock.calls.map((c) => c[1])).toEqual([40, 70, 90, 100]);
  });

  it('onProgress 可选，缺省时正常完成', async () => {
    const res = await orchestrate(makeStrategy(), [], makeBacktest());
    expect(res.dataQuality).toBeDefined();
    expect(res.audit).toBeDefined();
    expect(res.optimization).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// generateSummary
// ---------------------------------------------------------------------------

describe('generateSummary', () => {
  const dq = (overallScore: number) => ({ overallScore }) as DataQualityReport;
  const opt = (count: number) =>
    ({ suggestions: Array.from({ length: count }, () => ({})) }) as unknown as OptimizationReport;

  it('正收益 + 高质量数据 + 低风险审计', () => {
    const summary = generateSummary(
      makeStrategy(),
      dq(90),
      makeBacktest({ totalReturn: 10, maxDrawdown: -18 }),
      makeAudit({ riskScore: 80 }),
      opt(2),
    );
    expect(summary).toContain('正收益10.0%');
    expect(summary).toContain('年化15.0%');
    expect(summary).toContain('夏普比率1.50');
    expect(summary).toContain('最大回撤-18.0%');
    expect(summary).toContain('数据质量良好');
    expect(summary).toContain('风险可控');
    expect(summary).toContain('发现2项优化建议。');
  });

  it('亏损 + 数据质量问题 + 高风险审计（无优化建议文案）', () => {
    const summary = generateSummary(
      makeStrategy(),
      dq(70),
      makeBacktest({
        totalReturn: -5,
        annualizedReturn: -2,
        sharpeRatio: 0.3,
        maxDrawdown: 25,
      }),
      makeAudit({ riskScore: 45 }),
      opt(0),
    );
    expect(summary).toContain('亏损5.0%');
    expect(summary).toContain('数据存在质量问题');
    expect(summary).toContain('风险较高');
    expect(summary).not.toContain('优化建议');
  });

  it('风险评分 50~69 显示“存在一定风险”，评分80边界为“数据质量良好”', () => {
    const summary = generateSummary(
      makeStrategy(),
      dq(80),
      makeBacktest(),
      makeAudit({ riskScore: 60 }),
      opt(0),
    );
    expect(summary).toContain('存在一定风险');
    expect(summary).toContain('数据质量良好');
  });
});

// ---------------------------------------------------------------------------
// strategyOptimizer
// ---------------------------------------------------------------------------

describe('strategyOptimizer', () => {
  describe('性能评分', () => {
    it('优秀指标 → 满分 100', () => {
      const { performanceScore } = strategyOptimizer(
        makeBacktest({
          annualizedReturn: 15,
          sharpeRatio: 1.5,
          maxDrawdown: 10,
          winRate: 50,
          profitFactor: 1.5,
        }),
        makeAudit(),
        makeStrategy(),
      );
      expect(performanceScore).toBe(100);
    });

    it('全面亏损指标 → 0 分', () => {
      const { performanceScore } = strategyOptimizer(
        makeBacktest({
          annualizedReturn: -10,
          sharpeRatio: -0.5,
          maxDrawdown: 60,
          winRate: 0,
          profitFactor: 0,
        }),
        makeAudit(),
        makeStrategy(),
      );
      expect(performanceScore).toBe(0);
    });

    it('回撤在 15%~40% 区间线性扣分，15% 满分、40% 零分', () => {
      const run = (maxDrawdown: number) =>
        strategyOptimizer(
          makeBacktest({
            annualizedReturn: 0,
            sharpeRatio: 0,
            maxDrawdown,
            winRate: 0,
            profitFactor: 0,
          }),
          makeAudit(),
          makeStrategy(),
        ).performanceScore;
      expect(run(15)).toBe(25); // 满分
      expect(run(25)).toBe(15);
      expect(run(40)).toBe(0);
      expect(run(60)).toBe(0);
    });

    it('各分项封顶，总分不会超过 100', () => {
      const { performanceScore } = strategyOptimizer(
        makeBacktest({
          annualizedReturn: 100,
          sharpeRatio: 5,
          maxDrawdown: 5,
          winRate: 100,
          profitFactor: 5,
        }),
        makeAudit(),
        makeStrategy(),
      );
      expect(performanceScore).toBe(100);
    });
  });

  describe('优化建议', () => {
    it('全部触发条件命中', () => {
      const { suggestions } = strategyOptimizer(
        makeBacktest({
          maxDrawdown: 30,
          winRate: 30,
          tradeCount: 15,
          sharpeRatio: 0.3,
          annualizedReturn: 5,
          profitFactor: 1.0,
        }),
        makeAudit({ overfittingRisk: 'high', futureFunctionRisk: 'high' }),
        makeStrategy(),
      );
      const categories = suggestions.map((s) => s.category);
      expect(categories).toContain('risk');
      expect(categories).toContain('entry');
      expect(categories).toContain('parameter');
      expect(categories).toContain('position');
      expect(categories).toContain('exit');
      expect(suggestions.some((s) => s.title === '增加止损机制' && s.impact === 'high')).toBe(true);
      expect(suggestions.some((s) => s.title === '排查未来函数')).toBe(true);
      expect(suggestions.some((s) => s.title === '降低参数精确度')).toBe(true);
    });

    it('无触发条件时返回空建议', () => {
      const { suggestions } = strategyOptimizer(
        makeBacktest({
          maxDrawdown: 10,
          winRate: 60,
          tradeCount: 50,
          sharpeRatio: 2,
          annualizedReturn: 10,
          profitFactor: 2,
        }),
        makeAudit(),
        makeStrategy(),
      );
      expect(suggestions).toEqual([]);
    });
  });

  describe('参数敏感性', () => {
    it('四类参数分别给出建议区间与灵敏度', () => {
      const { parameterSensitivity } = strategyOptimizer(
        makeBacktest({ winRate: 80, sharpeRatio: 0.3 }),
        makeAudit(),
        makeStrategy({
          params: { shortPeriod: 20, longPeriod: 20, buyThreshold: 5, someParam: 10 },
        }),
      );
      const byParam = new Map(parameterSensitivity.map((p) => [p.param, p]));
      // 短期周期：winRate 偏离 50 大于 15 → high
      expect(byParam.get('shortPeriod')).toMatchObject({
        currentValue: 20,
        sensitivity: 'high',
        suggestedRange: { min: 12, max: 30, optimal: 20 },
      });
      // 长期周期：sharpe<=0.5 → high
      expect(byParam.get('longPeriod')).toMatchObject({
        currentValue: 20,
        sensitivity: 'high',
        suggestedRange: { min: 14, max: 28, optimal: 20 },
      });
      // 阈值类：恒 medium
      expect(byParam.get('buyThreshold')).toMatchObject({
        currentValue: 5,
        sensitivity: 'medium',
        suggestedRange: { min: 2.5, max: 9, optimal: 5 },
      });
      // 通用参数：low
      expect(byParam.get('someParam')).toMatchObject({
        currentValue: 10,
        sensitivity: 'low',
        suggestedRange: { min: 7, max: 13, optimal: 10 },
      });
    });

    it('短期周期灵敏度随 winRate 偏离程度分级', () => {
      const sens = (winRate: number) =>
        strategyOptimizer(
          makeBacktest({ winRate }),
          makeAudit(),
          makeStrategy({ params: { shortPeriod: 20 } }),
        ).parameterSensitivity[0].sensitivity;
      expect(sens(58)).toBe('low'); // |8| 不 >8
      expect(sens(59)).toBe('medium'); // 9
      expect(sens(66)).toBe('high'); // 16
    });

    it('长期周期灵敏度随 sharpe 分级', () => {
      const sens = (sharpe: number) =>
        strategyOptimizer(
          makeBacktest({ sharpeRatio: sharpe }),
          makeAudit(),
          makeStrategy({ params: { longPeriod: 20 } }),
        ).parameterSensitivity[0].sensitivity;
      expect(sens(1.2)).toBe('low');
      expect(sens(0.8)).toBe('medium');
      expect(sens(0.3)).toBe('high');
    });
  });

  it('缺失可选字段时安全降级（?? 回退 + 买卖配对失败分支）', () => {
    // 去掉 maxDrawdown / sharpeRatio / winRate，触发 ?? 0 回退；
    // 交易只有两笔 buy，找不到配对 sell → maxConsecutiveLoss 保持 0
    const { trades, maxDrawdown, sharpeRatio, winRate, ...rest } = makeBacktest();
    const report = strategyOptimizer(
      {
        ...rest,
        trades: [makeTrade('2024-01-02', 'buy', 100), makeTrade('2024-01-05', 'buy', 100)],
      } as BacktestResult,
      makeAudit(),
      makeStrategy(),
    );
    expect(report.performanceScore).toBe(63);
    expect(report.riskMetrics.maxConsecutiveLoss).toBe(0);
    expect(report.iterationDirections).toHaveLength(3); // 恰好3条不触发补足分支
  });

  describe('风险指标', () => {
    it('VaR95 基于权益曲线日收益率（每日 -5% → var95=5）', () => {
      const { riskMetrics } = strategyOptimizer(
        makeBacktest({
          equityCurve: [
            { date: '2024-01-02', value: 100 },
            { date: '2024-01-03', value: 95 },
            { date: '2024-01-04', value: 90.25 },
          ],
        }),
        makeAudit(),
        makeStrategy(),
      );
      expect(riskMetrics.var95).toBe(5);
    });

    it('权益曲线为空或单点 → var95=0', () => {
      const empty = strategyOptimizer(
        makeBacktest({ equityCurve: [] }),
        makeAudit(),
        makeStrategy(),
      ).riskMetrics.var95;
      const single = strategyOptimizer(
        makeBacktest({ equityCurve: [{ date: '2024-01-02', value: 100 }] }),
        makeAudit(),
        makeStrategy(),
      ).riskMetrics.var95;
      const flat = strategyOptimizer(
        makeBacktest({
          equityCurve: [
            { date: '2024-01-02', value: 100 },
            { date: '2024-01-03', value: 100 },
          ],
        }),
        makeAudit(),
        makeStrategy(),
      ).riskMetrics.var95;
      expect(empty).toBe(0);
      expect(single).toBe(0);
      expect(flat).toBe(0);
    });

    it('最大连续亏损：两连亏后盈利重置', () => {
      const trades = [
        makeTrade('2024-01-02', 'buy', 100),
        makeTrade('2024-01-05', 'sell', 90),
        makeTrade('2024-01-08', 'buy', 100),
        makeTrade('2024-01-10', 'sell', 80),
        makeTrade('2024-01-12', 'buy', 100),
        makeTrade('2024-01-15', 'sell', 110),
      ];
      const { riskMetrics } = strategyOptimizer(
        makeBacktest({ trades }),
        makeAudit(),
        makeStrategy(),
      );
      expect(riskMetrics.maxConsecutiveLoss).toBe(2);
    });

    it('平均持仓天数：合法配对平均，负/非法持仓剔除', () => {
      const trades = [
        makeTrade('2024-01-01', 'buy', 100),
        makeTrade('2024-01-10', 'sell', 110), // 9 天
        makeTrade('2024-01-15', 'buy', 100),
        makeTrade('2024-01-17', 'sell', 105), // 2 天
        makeTrade('2024-01-20', 'buy', 100),
        makeTrade('2024-01-15', 'sell', 95), // -5 天 → 剔除
      ];
      const { riskMetrics } = strategyOptimizer(
        makeBacktest({ trades }),
        makeAudit(),
        makeStrategy(),
      );
      expect(riskMetrics.avgHoldingDays).toBe(5.5);
    });

    it('无交易时平均持仓天数为 0', () => {
      const { riskMetrics } = strategyOptimizer(makeBacktest(), makeAudit(), makeStrategy());
      expect(riskMetrics.avgHoldingDays).toBe(0);
    });
  });

  describe('迭代方向', () => {
    it('多重风险 → 恰好5条方向（slice(0,5) 截断）', () => {
      const { iterationDirections } = strategyOptimizer(
        makeBacktest({
          maxDrawdown: 30,
          sharpeRatio: 0.5,
          winRate: 30,
          annualizedReturn: 5,
          profitFactor: 1.0,
          tradeCount: 15,
        }),
        makeAudit({ overfittingRisk: 'high' }),
        makeStrategy(),
      );
      expect(iterationDirections).toEqual([
        '引入动态止损和仓位管理（如Kelly公式）降低回撤',
        '优化风险调整收益：考虑加入波动率过滤或自适应仓位',
        '提升入场信号质量：结合多因子确认或机器学习过滤',
        '进行Walk-Forward验证和参数稳健性测试以降低过拟合',
        '扩展多标的回测验证策略普适性',
      ]);
    });

    it('健康策略 → 补足最低条数', () => {
      const { iterationDirections } = strategyOptimizer(
        makeBacktest({
          maxDrawdown: 10,
          sharpeRatio: 1.5,
          winRate: 60,
          annualizedReturn: 20,
          profitFactor: 2,
          tradeCount: 50,
        }),
        makeAudit(),
        makeStrategy(),
      );
      expect(iterationDirections).toEqual([
        '扩展多标的回测验证策略普适性',
        '优化交易执行逻辑，减少滑点影响',
      ]);
    });
  });
});
