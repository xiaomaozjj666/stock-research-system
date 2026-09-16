/**
 * ============================================================================
 * POST /api/quant/analyze 主路径路由级测试 —— 防的是「主路径零回归保护」。
 *
 * 背景（审计）：该端点约 430 行（routes/quant.ts 的 `POST /api/quant/analyze`），
 * 全库此前只断言过「缺少 strategy → 400」一条；成功响应结构（strategy/dataQuality/backtest/
 * priceVolumeFactors/compositeAlpha/audit/optimization/summary/confidence/
 * limitations）、K 线不可得时的 422、编排抛错时的 500 与错误体形状，全部无断言。
 * 一旦编排层（orchestrator）签名或返回结构变动、或 500 分支开始泄漏堆栈，
 * 现有测试套件不会变红。
 *
 * 隔离策略：
 *   - orchestrator 的 parseStrategyInput / orchestrate / generateSummary 全量打桩，
 *     LLM 与子 Agent 逻辑不参与（其自身单测另行覆盖）；
 *   - dataProvider 的 fetchOHLCVData / fetchBenchmarkReturns 打桩，不触真实行情网络；
 *   - quantLimiter 在模块层替换为直通中间件：本文件请求数多于默认 5 req/min，
 *     不替换会互相挤占配额导致 429（限流 429 分支本身另有专门文件覆盖）；
 *     circuitBreakerGuard 保持真实实现。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { OHLCVData, StrategyConfig } from '../quant/types.js';

// 限流直通：本文件用例数 > quantLimiter 默认 5 req/min
vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  return {
    ...actual,
    quantLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const mocks = vi.hoisted(() => ({
  parseStrategyInput: vi.fn(),
  orchestrate: vi.fn(),
  generateSummary: vi.fn(),
  fetchOHLCVData: vi.fn(),
  fetchBenchmarkReturns: vi.fn(),
}));

vi.mock('../quant/agents/orchestrator.js', () => ({
  parseStrategyInput: mocks.parseStrategyInput,
  orchestrate: mocks.orchestrate,
  generateSummary: mocks.generateSummary,
}));

vi.mock('../quant/dataProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/dataProvider.js')>();
  return {
    ...actual,
    fetchOHLCVData: mocks.fetchOHLCVData,
    fetchBenchmarkReturns: mocks.fetchBenchmarkReturns,
  };
});

import { app } from '../index.js';

/** 生成 n 根确定性日 K 线（正弦+微升，保证因子有非退化取值） */
function genBars(n = 280, start = '2024-01-01'): OHLCVData[] {
  const out: OHLCVData[] = [];
  const d = new Date(start);
  for (let i = 0; i < n; i++) {
    const date = new Date(d.getTime() + i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const close = 100 * (1 + i * 0.0004) * (1 + 0.05 * Math.sin(i / 7));
    out.push({
      date,
      open: close * 0.995,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1000 + (i % 13) * 37,
    });
  }
  return out;
}

/** 与 orchestrator 返回结构一致的数据质量报告（仅断言路径用到，形状为可控常量） */
const dataQualityFixture = {
  overallScore: 92,
  totalRecords: 280,
  missingDates: [],
  outliers: [],
  duplicates: [],
  issues: [],
  suggestions: [],
  dataRange: { start: '2024-01-01', end: '2024-10-06', tradingDays: 280 },
};

const auditFixture = {
  riskScore: 85,
  futureFunctionRisk: 'low' as const,
  overfittingRisk: 'low' as const,
  survivorshipBias: 'low' as const,
  checks: [{ name: 'lookahead', passed: true, detail: 'ok', severity: 'info' as const }],
  issues: [],
  reliability: '高',
};

const optimizationFixture = {
  performanceScore: 80,
  suggestions: [
    { category: 'risk' as const, title: '收紧止损', detail: '降低回撤', impact: 'medium' as const },
  ],
  parameterSensitivity: [],
  riskMetrics: { var95: -3.2, maxConsecutiveLoss: 2, avgHoldingDays: 12 },
  iterationDirections: [],
};

/** 策略配置夹具：显式给全字段，避免用例依赖 orchestrator 的真实解析逻辑 */
function strategyFixture(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    name: '均线交叉策略',
    type: 'ma_cross',
    stockCode: '600519',
    params: { shortPeriod: 5, longPeriod: 20 },
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.parseStrategyInput.mockReset();
  mocks.orchestrate.mockReset();
  mocks.generateSummary.mockReset();
  mocks.fetchOHLCVData.mockReset();
  mocks.fetchBenchmarkReturns.mockReset();
  // 默认：K 线可得、基准缺失（Beta 类因子按 NaN 处理，不拖垮报告）
  mocks.fetchOHLCVData.mockResolvedValue(genBars());
  mocks.fetchBenchmarkReturns.mockResolvedValue(null);
  mocks.parseStrategyInput.mockImplementation((input: string | StrategyConfig) =>
    strategyFixture(typeof input === 'string' ? { name: '自然语言策略' } : input),
  );
  mocks.orchestrate.mockResolvedValue({
    dataQuality: dataQualityFixture,
    audit: auditFixture,
    optimization: optimizationFixture,
  });
  mocks.generateSummary.mockReturnValue('回测摘要：正收益 12.5%，风险可控。');
});

describe('POST /api/quant/analyze 主路径', () => {
  it('合法入参 → 200，且完整报告结构齐备（strategy/backtest/audit/summary/confidence/limitations）', async () => {
    const res = await request(app)
      .post('/api/quant/analyze')
      .send({ strategy: '双均线交叉策略，5日和20日' });

    expect(res.status).toBe(200);
    // 策略配置原样回传（前端报告头要显示用的是哪套参数）
    expect(res.body.strategy).toMatchObject({
      stockCode: '600519',
      type: 'ma_cross',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    // 子 Agent 三段报告与摘要走编排层返回值
    expect(res.body.dataQuality).toMatchObject({ overallScore: 92 });
    expect(res.body.audit).toMatchObject({ riskScore: 85 });
    expect(res.body.optimization).toMatchObject({ performanceScore: 80 });
    expect(res.body.summary).toBe('回测摘要：正收益 12.5%，风险可控。');

    // 回测结果来自真实 runBacktest（K 线与策略参数已打桩/夹具化）
    expect(res.body.backtest).toBeDefined();
    expect(typeof res.body.backtest.totalReturn).toBe('number');
    expect(typeof res.body.backtest.tradeCount).toBe('number');
    expect(Array.isArray(res.body.backtest.equityCurve)).toBe(true);

    // 量价因子随报告透出，并带 available 标记（NaN 因子不得当 0 参与加权）
    expect(Array.isArray(res.body.priceVolumeFactors)).toBe(true);
    expect(res.body.priceVolumeFactors.length).toBeGreaterThan(0);
    for (const f of res.body.priceVolumeFactors) {
      expect(typeof f.name).toBe('string');
      expect(typeof f.available).toBe('boolean');
      expect(f.available).toBe(Number.isFinite(f.value));
    }

    // 置信度由 dataQuality/audit 双阈值推导：92/85 → 高
    expect(res.body.confidence).toBe('高');
    // limitations 为分号拼接的字符串（前端直接展示）
    expect(typeof res.body.limitations).toBe('string');
    expect(res.body.limitations).toContain('历史回测不代表未来收益');
    // 无新闻输入 → 不返回新闻叠加相关字段（保持既有输出契约）
    expect(res.body.newsSentiment).toBeUndefined();
    expect(res.body.backtestBaseline).toBeUndefined();

    // 编排调用契约：strategy 原文 → parse → orchestrate(config, bars, backtest)
    expect(mocks.parseStrategyInput).toHaveBeenCalledWith('双均线交叉策略，5日和20日');
    expect(mocks.orchestrate).toHaveBeenCalledTimes(1);
    const [cfgArg, barsArg, btArg] = mocks.orchestrate.mock.calls[0] as [
      StrategyConfig,
      OHLCVData[],
      { totalReturn: number },
    ];
    expect(cfgArg.stockCode).toBe('600519');
    expect(barsArg).toHaveLength(280);
    expect(typeof btArg.totalReturn).toBe('number');
  });

  it('消息情绪叠加生效时额外返回 newsSentiment 与 backtestBaseline', async () => {
    const res = await request(app)
      .post('/api/quant/analyze')
      .send({
        strategy: strategyFixture(),
        newsItems: [
          { id: 'n1', title: '业绩超预期大增', summary: '净利润大增', publishedAt: '2024-06-03' },
          { id: 'n2', title: '获机构密集调研', summary: '机构调研', publishedAt: '2024-06-10' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.newsSentiment).toBeDefined();
    expect(res.body.newsSentiment.hasNews).toBe(true);
    // 基线曲线只在确实用了新闻叠加层时返回，供前端做 A/B 对比
    expect(res.body.backtestBaseline).toBeDefined();
    expect(res.body.backtest).toBeDefined();
    // 新闻叠加层生效 → limitations 必须披露其口径（不得静默叠加）
    expect(res.body.limitations).toContain('新闻');
  });

  it('含显式 factorOverlay 的策略 → 200，因子叠加层进入回测且披露姿态', async () => {
    const res = await request(app)
      .post('/api/quant/analyze')
      .send({
        strategy: strategyFixture({
          factorOverlay: { direction: 'up', alpha: 0.4, posture: 0.7 },
        }),
      });

    expect(res.status).toBe(200);
    expect(res.body.strategy.factorOverlay).toMatchObject({ direction: 'up', posture: 0.7 });
    // 引擎回报 factorAware 时应附带姿态披露；若引擎未采纳亦不算失败（如实断言二者之一）
    if (res.body.backtest.factorAware) {
      expect(res.body.limitations).toContain('组合 alpha 信号叠加已生效');
    } else {
      expect(res.body.backtest.factorAware).toBeUndefined();
    }
  });

  it('缺少 strategy → 400，且不调用编排层', async () => {
    const res = await request(app).post('/api/quant/analyze').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: '请提供策略配置（strategy）' });
    // 校验在编排之前拦下：不得为畸形请求白跑一轮取数/LLM
    expect(mocks.parseStrategyInput).not.toHaveBeenCalled();
    expect(mocks.orchestrate).not.toHaveBeenCalled();
    expect(mocks.fetchOHLCVData).not.toHaveBeenCalled();
  });

  it('K 线数据不可得（空数组）→ 422，且不进入回测与编排', async () => {
    mocks.fetchOHLCVData.mockResolvedValue([]);

    const res = await request(app).post('/api/quant/analyze').send({ strategy: strategyFixture() });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('600519');
    expect(mocks.orchestrate).not.toHaveBeenCalled();
  });

  it('编排层抛错 → 500，错误体形状一致且不泄漏堆栈', async () => {
    mocks.orchestrate.mockRejectedValue(new Error('审计子 Agent 不可用'));

    const res = await request(app).post('/api/quant/analyze').send({ strategy: strategyFixture() });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('量化分析失败');
    expect(res.body.detail).toBe('审计子 Agent 不可用');
    // 安全约束：只暴露 message，不得把 stack / 内部路径 / node_modules 路径写进响应
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('.ts:');
    expect(raw).not.toContain('node_modules');
    expect(raw).not.toContain('at ');
  });
});
