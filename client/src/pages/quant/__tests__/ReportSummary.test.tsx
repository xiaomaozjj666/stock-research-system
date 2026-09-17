// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReportSummary from '../ReportSummary';
import type {
  AuditReport,
  BacktestResult,
  DataQualityReport,
  OptimizationReport,
  QuantResearchReport,
  StrategyConfig,
} from '../types';

/**
 * ReportSummary 行为测试
 * ----------------------------------------------------------------------------
 * 该面板把「回测指标 + 数据质量」折算成一个 0~100 的综合评分（getOverallScore 里
 * 是 5 组分档加分：夏普 30/25/15/5、总收益 25/20/10/0、最大回撤 20/15/8/0、
 * 胜率 15/10/5、数据质量 10/7/3），再按 80/60/40 三档给中文评级与配色。
 * 下面按「阈值边界 + 档位语义」逐档钉住：只有算错分档才会失败。
 */

const strategy: StrategyConfig = {
  name: '双均线交叉',
  type: 'ma_cross',
  stockCode: '600519',
  params: { fast: 5, slow: 20 },
  startDate: '2023-01-01',
  endDate: '2025-12-31',
};

function makeBacktest(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    totalReturn: 20,
    annualizedReturn: 12,
    sharpeRatio: 1.2,
    maxDrawdown: 15,
    winRate: 55,
    tradeCount: 30,
    profitFactor: 1.5,
    equityCurve: [],
    trades: [],
    benchmark: [],
    ...over,
  };
}

function makeQuality(over: Partial<DataQualityReport> = {}): DataQualityReport {
  return {
    overallScore: 85,
    totalRecords: 600,
    missingDates: [],
    outliers: [],
    duplicates: [],
    issues: [],
    suggestions: [],
    dataRange: { start: '2023-01-01', end: '2025-12-31', tradingDays: 720 },
    ...over,
  };
}

const audit: AuditReport = {
  riskScore: 80,
  futureFunctionRisk: 'low',
  overfittingRisk: 'medium',
  survivorshipBias: 'low',
  checks: [],
  issues: [],
  reliability: '整体可靠',
};

const optimization: OptimizationReport = {
  performanceScore: 70,
  suggestions: [],
  parameterSensitivity: [],
  riskMetrics: { var95: 2.1, maxConsecutiveLoss: 3, avgHoldingDays: 6 },
  iterationDirections: [],
};

function makeReport(over: Partial<QuantResearchReport> = {}): QuantResearchReport {
  return {
    strategy,
    dataQuality: makeQuality(),
    backtest: makeBacktest(),
    audit,
    optimization,
    summary: '策略整体表现稳健，收益与回撤匹配',
    confidence: '中高',
    limitations: '样本区间偏短',
    ...over,
  };
}

function renderPanel(report: QuantResearchReport) {
  return render(<ReportSummary data={report} />);
}

function scoreBlock(container: HTMLElement): HTMLElement {
  return container.querySelector('.quant-summary-score-block') as HTMLElement;
}

function scoreText(container: HTMLElement): string {
  return container.querySelector('.quant-summary-score')?.textContent ?? '';
}

/** 基线：夏普 1.2(25) + 收益 20(20) + 回撤 15(15) + 胜率 55(10) + 质量 85(10) = 80 */
const BASE_SCORE = 80;

interface ScoreCase {
  title: string;
  backtest: Partial<BacktestResult>;
  quality: number;
  score: number;
  label: string;
  color: string;
}

const SCORE_CASES: ScoreCase[] = [
  {
    title: '五项全部顶格（夏普 1.5 / 收益 30 / 回撤 10 / 胜率 60 / 质量 80）→ 100',
    backtest: { sharpeRatio: 1.5, totalReturn: 30, maxDrawdown: 10, winRate: 60 },
    quality: 80,
    score: 100,
    label: '优秀',
    color: 'var(--color-positive)',
  },
  {
    title: '夏普 2 / 收益 35 / 回撤 25 / 胜率 55 / 质量 70 → 恰好 80（优秀下限）',
    backtest: { sharpeRatio: 2, totalReturn: 35, maxDrawdown: 25, winRate: 55 },
    quality: 70,
    score: 80,
    label: '优秀',
    color: 'var(--color-positive)',
  },
  {
    title: '夏普 1.5 / 收益 30 / 回撤 20 / 胜率 49 / 质量 59 → 78（差 2 分落到良好）',
    backtest: { sharpeRatio: 1.5, totalReturn: 30, maxDrawdown: 20, winRate: 49 },
    quality: 59,
    score: 78,
    label: '良好',
    color: 'var(--accent)',
  },
  {
    title: '夏普 1.49 / 收益 14.9 / 回撤 10.1 / 胜率 59.9 / 质量 79.9 → 67（各档均差一点点）',
    backtest: { sharpeRatio: 1.49, totalReturn: 14.9, maxDrawdown: 10.1, winRate: 59.9 },
    quality: 79.9,
    score: 67,
    label: '良好',
    color: 'var(--accent)',
  },
  {
    title: '夏普 1 / 收益 15 / 回撤 20 / 胜率 50 / 质量 60 → 77（各档下沿刚好命中）',
    backtest: { sharpeRatio: 1, totalReturn: 15, maxDrawdown: 20, winRate: 50 },
    quality: 60,
    score: 77,
    label: '良好',
    color: 'var(--accent)',
  },
  {
    title: '夏普 0.5 / 收益 0 / 回撤 30 / 胜率 49 / 质量 59 → 41（一般）',
    backtest: { sharpeRatio: 0.5, totalReturn: 0, maxDrawdown: 30, winRate: 49 },
    quality: 59,
    score: 41,
    label: '一般',
    color: 'var(--color-warning)',
  },
  {
    title: '夏普 0.49 / 收益 0 / 回撤 30.1 / 胜率 60 / 质量 100 → 恰好 40（一般下限）',
    backtest: { sharpeRatio: 0.49, totalReturn: 0, maxDrawdown: 30.1, winRate: 60 },
    quality: 100,
    score: 40,
    label: '一般',
    color: 'var(--color-warning)',
  },
  {
    title: '夏普 0.49 / 收益 -1 / 回撤 31 / 胜率 49 / 质量 0 → 13（理论最低）',
    backtest: { sharpeRatio: 0.49, totalReturn: -1, maxDrawdown: 31, winRate: 49 },
    quality: 0,
    score: 13,
    label: '较差',
    color: 'var(--color-negative)',
  },
  {
    title: '夏普 0.99 / 收益 -0.1 / 回撤 20.1 / 胜率 49.9 / 质量 59.9 → 31（较差）',
    backtest: { sharpeRatio: 0.99, totalReturn: -0.1, maxDrawdown: 20.1, winRate: 49.9 },
    quality: 59.9,
    score: 31,
    label: '较差',
    color: 'var(--color-negative)',
  },
  {
    title: '全部非有限值（NaN）时落到最低档而不是算出 NaN：5+0+0+5+3 = 13',
    backtest: {
      sharpeRatio: Number.NaN,
      totalReturn: Number.NaN,
      maxDrawdown: Number.NaN,
      winRate: Number.NaN,
    },
    quality: Number.NaN,
    score: 13,
    label: '较差',
    color: 'var(--color-negative)',
  },
  {
    title: '极大值（夏普 999 / 收益 1e9 / 回撤 -5 / 胜率 100）仍封顶 100',
    backtest: { sharpeRatio: 999, totalReturn: 1e9, maxDrawdown: -5, winRate: 100 },
    quality: 100,
    score: 100,
    label: '优秀',
    color: 'var(--color-positive)',
  },
];

describe('ReportSummary —— 标题与策略类型标签', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('标题显示策略名，ma_cross 显示「均线交叉」', () => {
    renderPanel(makeReport());

    expect(screen.getByRole('heading', { name: '双均线交叉' })).toBeInTheDocument();
    expect(screen.getByText('均线交叉')).toBeInTheDocument();
  });

  it('momentum 显示「动量策略」，mean_reversion 显示「均值回归」', () => {
    const { unmount } = renderPanel(
      makeReport({ strategy: { ...strategy, name: '动量 20 日', type: 'momentum' } }),
    );
    expect(screen.getByText('动量策略')).toBeInTheDocument();
    expect(screen.queryByText('均线交叉')).toBeNull();
    unmount();

    renderPanel(
      makeReport({ strategy: { ...strategy, name: '均值回归 5 日', type: 'mean_reversion' } }),
    );
    expect(screen.getByText('均值回归')).toBeInTheDocument();
    expect(screen.queryByText('动量策略')).toBeNull();
  });

  it('type 为 custom 时落到「自定义策略」标签（不再被误标成均值回归）', () => {
    const { container } = renderPanel(
      makeReport({ strategy: { ...strategy, name: '自定义策略', type: 'custom' } }),
    );

    // 三元表达式此前只有 ma_cross / momentum 两支，custom 会落到 else 分支被标成「均值回归」
    expect(container.querySelector('.chip')?.textContent).toBe('自定义策略');
    expect(screen.queryByText('均值回归')).toBeNull();
    expect(screen.getByRole('heading', { name: '自定义策略' })).toBeInTheDocument();
  });
});

describe('ReportSummary —— 综合评分分档计算', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('基线指标（夏普 1.2 / 收益 20 / 回撤 15 / 胜率 55 / 质量 85）得 80 分', () => {
    const { container } = renderPanel(makeReport());

    expect(scoreText(container)).toBe(String(BASE_SCORE));
    expect(screen.getByText(String(BASE_SCORE))).toBeInTheDocument();
  });

  for (const c of SCORE_CASES) {
    it(c.title, () => {
      const { container } = renderPanel(
        makeReport({
          backtest: makeBacktest(c.backtest),
          dataQuality: makeQuality({ overallScore: c.quality }),
        }),
      );

      expect(scoreText(container)).toBe(String(c.score));
    });
  }
});

describe('ReportSummary —— 评分档位标签与配色', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const c of SCORE_CASES) {
    it(`${c.score} 分显示「${c.label}」并用 ${c.color} 着色`, () => {
      const { container } = renderPanel(
        makeReport({
          backtest: makeBacktest(c.backtest),
          dataQuality: makeQuality({ overallScore: c.quality }),
        }),
      );

      const block = scoreBlock(container);
      expect(block.querySelector('.quant-summary-score-label')).toHaveTextContent(c.label);
      expect(block.style.color).toBe(c.color);
    });
  }
});

describe('ReportSummary —— 可选文案与元信息', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('summary 有值时渲染总结正文', () => {
    const { container } = renderPanel(makeReport());

    expect(screen.getByText('策略整体表现稳健，收益与回撤匹配')).toBeInTheDocument();
    expect(container.querySelector('.quant-summary-text')).not.toBeNull();
  });

  it('summary 为空串时不渲染空段落（仅剩标题与评分块）', () => {
    const { container } = renderPanel(makeReport({ summary: '' }));

    expect(container.querySelector('.quant-summary-text')).toBeNull();
    expect(screen.getByRole('heading', { name: '双均线交叉' })).toBeInTheDocument();
  });

  it('confidence 与 limitations 齐备时两个元信息项都显示', () => {
    const { container } = renderPanel(makeReport());

    expect(screen.getByText('置信度')).toBeInTheDocument();
    expect(screen.getByText('中高')).toBeInTheDocument();
    expect(screen.getByText('局限性')).toBeInTheDocument();
    expect(screen.getByText('样本区间偏短')).toBeInTheDocument();
    expect(container.querySelectorAll('.quant-summary-meta-item')).toHaveLength(2);
  });

  it('只缺 limitations 时保留置信度项，且不出现「局限性」标签', () => {
    const { container } = renderPanel(makeReport({ limitations: '' }));

    expect(screen.getByText('置信度')).toBeInTheDocument();
    expect(screen.queryByText('局限性')).toBeNull();
    expect(container.querySelectorAll('.quant-summary-meta-item')).toHaveLength(1);
  });

  it('confidence 与 limitations 都缺（undefined）时元信息区为空，不渲染「undefined」文本', () => {
    const { container } = renderPanel(
      makeReport({
        confidence: undefined as unknown as string,
        limitations: undefined as unknown as string,
      }),
    );

    expect(container.querySelectorAll('.quant-summary-meta-item')).toHaveLength(0);
    expect(screen.queryByText('置信度')).toBeNull();
    expect(screen.queryByText('局限性')).toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });
});
