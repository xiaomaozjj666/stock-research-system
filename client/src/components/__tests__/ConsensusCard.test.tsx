// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConsensusCard from '../ConsensusCard';
import type { ConsensusSnapshot } from '../../types';

/**
 * ConsensusCard 行为测试
 * ----------------------------------------------------------------------------
 * 四个指标格（覆盖机构 / 买入·增持评级 / EPS 预测 / 北向持股占比）各有「有值 / 缺值 —」
 * 两条路径，外加两条可选列表项（目标价区间、北向持股披露）与一条固定口径说明。
 * 注意「0 算有值」：评级 0/0、北向占比 0%、市值 0 亿都必须照常显示而不是破折号。
 */

function makeConsensus(over: Partial<ConsensusSnapshot> = {}): ConsensusSnapshot {
  return {
    code: '600519',
    orgNum: 18,
    ratings: { buy: 12, add: 5, neutral: 1, reduce: 0, sale: 0 },
    forecasts: [
      { year: 2025, eps: 68.1234, mark: 'E' },
      { year: 2026, eps: 75.5, mark: 'E' },
      { year: 2024, eps: 60.1, mark: 'A' },
    ],
    targetPriceMax: 2100,
    targetPriceMin: 1800,
    north: { date: '2025-06-30', holdSharesRatio: 2.35, holdMarketCap: 12345678900 },
    ...over,
  };
}

function renderCard(data: ConsensusSnapshot) {
  return render(<ConsensusCard data={data} />);
}

/** 取某个指标格的数值（label 可用正则匹配带年份的 EPS 标签） */
function metric(label: string | RegExp): { label: string; value: string } {
  const labelEl = screen.getByText(label);
  const box = labelEl.closest('.news-metric') as HTMLElement;
  return {
    label: labelEl.textContent ?? '',
    value: box.querySelector('.news-metric-value')?.textContent ?? '',
  };
}

describe('ConsensusCard —— 标题与快照口径声明', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('标题为「机构一致预期」，右上角带「快照」徽标', () => {
    renderCard(makeConsensus());

    expect(screen.getByRole('heading', { name: '机构一致预期' })).toBeInTheDocument();
    expect(screen.getByText('快照')).toHaveClass('news-badge', 'news-badge--neutral');
  });

  it('始终给出「当前时点快照、不参与回测」的固定说明', () => {
    renderCard(makeConsensus());

    expect(
      screen.getByText('当前时点快照（无历史序列），仅作研判参考、不参与历史回测'),
    ).toBeInTheDocument();
  });

  it('四个指标格标签固定齐全', () => {
    const { container } = renderCard(makeConsensus());

    const labels = Array.from(container.querySelectorAll('.news-metric-label')).map(
      (l) => l.textContent,
    );
    expect(labels).toEqual([
      '覆盖机构',
      '买入/增持评级',
      'EPS 预测（2025E/2026E）',
      '北向持股占比',
    ]);
  });
});

describe('ConsensusCard —— 覆盖机构数', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('有值时显示机构家数', () => {
    renderCard(makeConsensus({ orgNum: 27 }));

    expect(metric('覆盖机构').value).toBe('27');
  });

  it('orgNum 为 null 时显示破折号而不是 0', () => {
    renderCard(makeConsensus({ orgNum: null }));

    expect(metric('覆盖机构').value).toBe('—');
  });

  it('orgNum 为 0（无机构覆盖但字段存在）时显示 0', () => {
    renderCard(makeConsensus({ orgNum: 0 }));

    expect(metric('覆盖机构').value).toBe('0');
  });
});

describe('ConsensusCard —— 买入/增持评级', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('买入与增持都齐备时显示「买入/增持」两段', () => {
    renderCard(makeConsensus({ ratings: { buy: 12, add: 5, neutral: 1, reduce: 0, sale: 0 } }));

    expect(metric('买入/增持评级').value).toBe('12/5');
  });

  it('只有其中一项有值时，缺的那项按 0 补齐（不是破折号）', () => {
    const { unmount } = renderCard(
      makeConsensus({ ratings: { buy: null, add: 5, neutral: 0, reduce: 0, sale: 0 } }),
    );
    expect(metric('买入/增持评级').value).toBe('0/5');
    unmount();

    renderCard(makeConsensus({ ratings: { buy: 3, add: null, neutral: 0, reduce: 0, sale: 0 } }));
    expect(metric('买入/增持评级').value).toBe('3/0');
  });

  it('买入与增持都为 null 时整格显示破折号', () => {
    renderCard(
      makeConsensus({ ratings: { buy: null, add: null, neutral: 2, reduce: 0, sale: 0 } }),
    );

    expect(metric('买入/增持评级').value).toBe('—');
  });

  it('买入与增持都是 0 时仍算「有评级数据」，显示 0/0', () => {
    renderCard(makeConsensus({ ratings: { buy: 0, add: 0, neutral: 0, reduce: 0, sale: 0 } }));

    expect(metric('买入/增持评级').value).toBe('0/0');
  });
});

describe('ConsensusCard —— EPS 预测', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('只取 mark=E 的预测年份，EPS 保留两位并用「 / 」连接', () => {
    renderCard(makeConsensus());

    // 2024 年 mark='A' 是实际值，不进预测格
    expect(metric(/^EPS 预测/).value).toBe('68.12 / 75.50');
    expect(metric(/^EPS 预测/).label).toBe('EPS 预测（2025E/2026E）');
  });

  it('没有任何 E 预测时数值为破折号，标签也不带年份括号', () => {
    renderCard(makeConsensus({ forecasts: [{ year: 2024, eps: 60.1, mark: 'A' }] }));

    expect(metric('EPS 预测').value).toBe('—');
    expect(metric('EPS 预测').label).toBe('EPS 预测');
  });

  it('forecasts 为空数组时同样走缺值态', () => {
    renderCard(makeConsensus({ forecasts: [] }));

    expect(metric('EPS 预测').value).toBe('—');
  });

  it('单条 E 预测时年份括号里只有一个年份', () => {
    renderCard(makeConsensus({ forecasts: [{ year: 2027, eps: 88.888, mark: 'E' }] }));

    expect(metric(/^EPS 预测/).value).toBe('88.89');
    expect(metric(/^EPS 预测/).label).toBe('EPS 预测（2027E）');
  });

  it('负 EPS（亏损预测）照常带符号显示', () => {
    renderCard(makeConsensus({ forecasts: [{ year: 2025, eps: -1.2, mark: 'E' }] }));

    expect(metric(/^EPS 预测/).value).toBe('-1.20');
  });
});

describe('ConsensusCard —— 北向持股', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('持股占比有值时带百分号显示', () => {
    renderCard(
      makeConsensus({ north: { date: '2025-06-30', holdSharesRatio: 2.35, holdMarketCap: 0 } }),
    );

    expect(metric('北向持股占比').value).toBe('2.35%');
  });

  it('持股占比为 0 时显示 0%', () => {
    renderCard(
      makeConsensus({ north: { date: '2025-06-30', holdSharesRatio: 0, holdMarketCap: 0 } }),
    );

    expect(metric('北向持股占比').value).toBe('0%');
  });

  it('占比为 null 或整个 north 缺失时显示破折号', () => {
    const { unmount } = renderCard(
      makeConsensus({ north: { date: '2025-06-30', holdSharesRatio: null, holdMarketCap: 0 } }),
    );
    expect(metric('北向持股占比').value).toBe('—');
    unmount();

    renderCard(makeConsensus({ north: undefined }));
    expect(metric('北向持股占比').value).toBe('—');
  });

  it('有披露日期时列出披露行，市值按亿元取整', () => {
    renderCard(makeConsensus());

    expect(screen.getByText('北向持股披露：2025-06-30，市值 123 亿')).toBeInTheDocument();
  });

  it('市值为 0 时照常写「市值 0 亿」，null 时该行不带市值片段', () => {
    const { unmount } = renderCard(
      makeConsensus({ north: { date: '2025-06-30', holdSharesRatio: 1, holdMarketCap: 0 } }),
    );
    expect(screen.getByText('北向持股披露：2025-06-30，市值 0 亿')).toBeInTheDocument();
    unmount();

    renderCard(
      makeConsensus({ north: { date: '2025-06-30', holdSharesRatio: 1, holdMarketCap: null } }),
    );
    const title = screen.getByText(/北向持股披露：2025-06-30/);
    expect(title).toHaveTextContent('北向持股披露：2025-06-30');
    expect(title.textContent).not.toContain('市值');
  });

  it('没有披露日期时该行整体不渲染，只留下固定口径说明', () => {
    const { container } = renderCard(
      makeConsensus({
        north: { date: '', holdSharesRatio: 1, holdMarketCap: 100 },
        targetPriceMin: null,
        targetPriceMax: null,
      }),
    );

    expect(screen.queryByText(/北向持股披露/)).toBeNull();
    // 目标价行也被置空后，列表里只剩那条固定的快照口径说明
    expect(container.querySelectorAll('.news-item')).toHaveLength(1);
    expect(
      screen.getByText('当前时点快照（无历史序列），仅作研判参考、不参与历史回测'),
    ).toBeInTheDocument();
  });
});

describe('ConsensusCard —— 机构目标价区间', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('上下限齐备时显示「min ~ max 元」', () => {
    renderCard(makeConsensus({ targetPriceMin: 1800, targetPriceMax: 2100 }));

    expect(screen.getByText('机构目标价区间：1800 ~ 2100 元')).toBeInTheDocument();
  });

  it('只缺上限时该侧显示破折号，仍保留目标价行', () => {
    renderCard(makeConsensus({ targetPriceMin: 1800, targetPriceMax: null }));

    expect(screen.getByText('机构目标价区间：1800 ~ — 元')).toBeInTheDocument();
  });

  it('只缺下限时该侧显示破折号', () => {
    renderCard(makeConsensus({ targetPriceMin: null, targetPriceMax: 2100 }));

    expect(screen.getByText('机构目标价区间：— ~ 2100 元')).toBeInTheDocument();
  });

  it('上下限都为 null 时不渲染目标价行', () => {
    renderCard(makeConsensus({ targetPriceMin: null, targetPriceMax: null }));

    expect(screen.queryByText(/机构目标价区间/)).toBeNull();
    // 只剩固定口径说明那一条
    expect(
      screen.getByText('当前时点快照（无历史序列），仅作研判参考、不参与历史回测'),
    ).toBeInTheDocument();
  });

  it('上下限为 0（真实的 0 元不可能，但字段存在）时照常成行', () => {
    renderCard(makeConsensus({ targetPriceMin: 0, targetPriceMax: 0 }));

    expect(screen.getByText('机构目标价区间：0 ~ 0 元')).toBeInTheDocument();
  });

  it('字段为 undefined（后端省略该字段）时仍渲染出「— ~ — 元」空行（现状：判空用 !== null）', () => {
    renderCard(
      makeConsensus({
        targetPriceMin: undefined as unknown as null,
        targetPriceMax: undefined as unknown as null,
      }),
    );

    expect(screen.getByText('机构目标价区间：— ~ — 元')).toBeInTheDocument();
  });
});
