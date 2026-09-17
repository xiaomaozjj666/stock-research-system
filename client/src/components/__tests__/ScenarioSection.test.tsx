// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ScenarioSection from '../ScenarioSection';
import type { ScenarioResult } from '../../types';

/**
 * ScenarioSection 行为测试
 * ----------------------------------------------------------------------------
 * 可见分支：空数组/null → 整体不渲染；三类情景名映射到 optimistic/pessimistic/neutral
 * 两套类名（卡片类 + 文字颜色类）；概率百分比取整；目标价区间用「¥low - ¥high」；
 * 关键假设 / 前置条件 / 专家论据三块各自「有则渲染、空则隐藏」，专家论据只取前 3 条。
 */

function makeScenario(over: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    name: '乐观',
    probability: 0.62,
    keyAssumptions: ['渗透率提升超预期', '毛利率维持 40% 以上'],
    targetPriceRange: { low: 120, high: 180 },
    supportingArguments: [
      { expert: '张三', text: '订单能见度延长至两个季度', confidence: 80 },
      { expert: '李四', text: '产能爬坡快于计划', confidence: 70 },
      { expert: '王五', text: '海外渠道放量', confidence: 65 },
      { expert: '赵六', text: '第 4 条论据不应出现', confidence: 60 },
    ],
    preconditions: ['下游需求不出现断崖式下滑'],
    ...over,
  };
}

function renderSection(data: ScenarioResult[]) {
  return render(<ScenarioSection data={data} />);
}

function cardOf(name: string): HTMLElement {
  return screen.getByText(name).closest('.scenario-card') as HTMLElement;
}

describe('ScenarioSection —— 空态', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('情景数组为空时不渲染任何内容', () => {
    const { container } = renderSection([]);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('情景推演')).toBeNull();
  });

  it('data 为 undefined/null 时同样不渲染', () => {
    const first = renderSection(undefined as unknown as ScenarioResult[]);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    const second = renderSection(null as unknown as ScenarioResult[]);
    expect(second.container).toBeEmptyDOMElement();
  });
});

describe('ScenarioSection —— 标题与固定说明', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染标题、副标题与免责声明', () => {
    renderSection([makeScenario()]);

    expect(screen.getByText('情景推演')).toBeInTheDocument();
    expect(screen.getByText('基于专家情绪分布的概率加权分析')).toBeInTheDocument();
    expect(screen.getByText('概率为主观估计，仅供参考')).toBeInTheDocument();
  });

  it('三类情景都渲染时按数据顺序排列三张卡片', () => {
    const { container } = renderSection([
      makeScenario({ name: '乐观' }),
      makeScenario({ name: '中性' }),
      makeScenario({ name: '悲观' }),
    ]);

    const names = Array.from(container.querySelectorAll('.scenario-name')).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(['乐观', '中性', '悲观']);
  });
});

describe('ScenarioSection —— 情景名称与配色类', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('乐观走 optimistic、悲观走 pessimistic、中性走 neutral（卡片与文字两套类名）', () => {
    renderSection([
      makeScenario({ name: '乐观' }),
      makeScenario({ name: '中性' }),
      makeScenario({ name: '悲观' }),
    ]);

    expect(cardOf('乐观')).toHaveClass('scenario-card', 'optimistic');
    expect(cardOf('中性')).toHaveClass('scenario-card', 'neutral');
    expect(cardOf('悲观')).toHaveClass('scenario-card', 'pessimistic');

    expect(cardOf('乐观').querySelector('.scenario-name')).toHaveClass('scenario-color-optimistic');
    expect(cardOf('中性').querySelector('.scenario-prob')).toHaveClass('scenario-color-neutral');
    expect(cardOf('悲观').querySelector('.scenario-prob')).toHaveClass(
      'scenario-color-pessimistic',
    );
  });

  it('未识别的情景名回退为 neutral', () => {
    renderSection([makeScenario({ name: '震荡' as ScenarioResult['name'] })]);

    expect(cardOf('震荡')).toHaveClass('scenario-card', 'neutral');
    expect(cardOf('震荡').querySelector('.scenario-name')).toHaveClass('scenario-color-neutral');
  });
});

describe('ScenarioSection —— 概率与目标价区间', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('概率按百分比取整显示', () => {
    renderSection([makeScenario({ probability: 0.62 })]);

    expect(cardOf('乐观').querySelector('.scenario-prob')).toHaveTextContent('62%');
  });

  it('概率边界 0 与 1 分别显示 0% 与 100%', () => {
    const { unmount } = renderSection([makeScenario({ probability: 0 })]);
    expect(cardOf('乐观').querySelector('.scenario-prob')).toHaveTextContent('0%');
    unmount();

    renderSection([makeScenario({ probability: 1 })]);
    expect(cardOf('乐观').querySelector('.scenario-prob')).toHaveTextContent('100%');
  });

  it('概率小于 0.5% 时取整为 0%', () => {
    renderSection([makeScenario({ probability: 0.004 })]);

    expect(cardOf('乐观').querySelector('.scenario-prob')).toHaveTextContent('0%');
  });

  it('目标价区间取整显示为「¥low - ¥high」', () => {
    renderSection([makeScenario({ targetPriceRange: { low: 120.4, high: 180.6 } })]);

    expect(cardOf('乐观').querySelector('.scenario-price-range')).toHaveTextContent(
      '目标价区间：¥120 - ¥181',
    );
  });

  it('目标价为 0 时照常显示 ¥0（toFixed 返回的字符串 "0" 是 truthy，不会被 || 吞掉）', () => {
    const { unmount } = renderSection([makeScenario({ targetPriceRange: { low: 0, high: 180 } })]);
    expect(cardOf('乐观').querySelector('.scenario-price-range')).toHaveTextContent(
      '目标价区间：¥0 - ¥180',
    );
    unmount();

    renderSection([makeScenario({ targetPriceRange: { low: 120, high: 0 } })]);
    expect(cardOf('乐观').querySelector('.scenario-price-range')).toHaveTextContent(
      '目标价区间：¥120 - ¥0',
    );
  });

  it('目标价非有限值（NaN）时直接渲染出「¥NaN」（现状：未做有限性兜底）', () => {
    renderSection([
      makeScenario({ targetPriceRange: { low: Number.NaN, high: Number.POSITIVE_INFINITY } }),
    ]);

    expect(cardOf('乐观').querySelector('.scenario-price-range')).toHaveTextContent(
      '目标价区间：¥NaN - ¥Infinity',
    );
  });

  it('整个 targetPriceRange 缺失时两侧都是破折号', () => {
    renderSection([
      makeScenario({
        targetPriceRange: undefined as unknown as ScenarioResult['targetPriceRange'],
      }),
    ]);

    expect(cardOf('乐观').querySelector('.scenario-price-range')).toHaveTextContent(
      '目标价区间：¥— - ¥—',
    );
  });
});

describe('ScenarioSection —— 关键假设 / 前置条件 / 专家论据', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('有假设与前置条件时分别成块列出', () => {
    const card = (() => {
      renderSection([makeScenario()]);
      return cardOf('乐观');
    })();

    expect(screen.getByText('关键假设')).toBeInTheDocument();
    expect(screen.getByText('渗透率提升超预期')).toBeInTheDocument();
    expect(screen.getByText('毛利率维持 40% 以上')).toBeInTheDocument();

    const pre = card.querySelector('.scenario-preconditions') as HTMLElement;
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent('前置条件');
    expect(pre).toHaveTextContent('下游需求不出现断崖式下滑');
  });

  it('假设为空数组时不渲染「关键假设」块，前置条件照常保留', () => {
    renderSection([makeScenario({ keyAssumptions: [] })]);

    expect(screen.queryByText('关键假设')).toBeNull();
    expect(screen.getByText('前置条件')).toBeInTheDocument();
  });

  it('前置条件为空数组时不渲染该块', () => {
    const card = (() => {
      renderSection([makeScenario({ preconditions: [] })]);
      return cardOf('乐观');
    })();

    expect(screen.queryByText('前置条件')).toBeNull();
    expect(card.querySelector('.scenario-preconditions')).toBeNull();
    expect(screen.getByText('关键假设')).toBeInTheDocument();
  });

  it('专家论据最多只渲染前 3 条，并带专家名与信心度', () => {
    const { container } = renderSection([makeScenario()]);

    const args = Array.from(container.querySelectorAll('.scenario-arg-item')).map((a) =>
      (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(args).toHaveLength(3);
    expect(args[0]).toBe('张三订单能见度延长至两个季度(80%)');
    expect(args[2]).toBe('王五海外渠道放量(65%)');
    expect(screen.queryByText('第 4 条论据不应出现')).toBeNull();
  });

  it('专家论据为空数组时不渲染该块', () => {
    const { container } = renderSection([makeScenario({ supportingArguments: [] })]);

    expect(container.querySelector('.scenario-arguments')).toBeNull();
    expect(screen.queryByText('专家论据')).toBeNull();
  });

  it('缺 supportingArguments 字段（undefined）时不抛错且不渲染该块', () => {
    const { container } = renderSection([
      makeScenario({
        supportingArguments: undefined as unknown as ScenarioResult['supportingArguments'],
      }),
    ]);

    expect(container.querySelector('.scenario-arguments')).toBeNull();
    expect(screen.getByText('关键假设')).toBeInTheDocument();
  });

  it('多张卡片时各块的条目互不串台', () => {
    const { container } = renderSection([
      makeScenario({
        name: '乐观',
        preconditions: ['乐观前置'],
        supportingArguments: [],
        keyAssumptions: ['乐观假设'],
      }),
      makeScenario({
        name: '悲观',
        preconditions: ['悲观前置'],
        supportingArguments: [],
        keyAssumptions: ['悲观假设'],
      }),
    ]);

    const cards = Array.from(container.querySelectorAll('.scenario-card'));
    expect(cards[0]).toHaveTextContent('乐观假设');
    expect(cards[0]).not.toHaveTextContent('悲观假设');
    expect(cards[0]).toHaveTextContent('乐观前置');
    expect(cards[1]).toHaveTextContent('悲观假设');
    expect(cards[1]).not.toHaveTextContent('乐观前置');
  });
});
