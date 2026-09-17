// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ExpertOpinions from '../ExpertOpinions';
import type { ExpertArgument, ExpertOpinion } from '../../types';

/**
 * ExpertOpinions 行为测试
 * ----------------------------------------------------------------------------
 * 交互只有一处：点标题行切换该专家的展开状态（openIndex 单值 → 同时只展开一个）。
 * 注意折叠是「类名切换」而不是卸载节点，所以断言打在 .expert-body-open/closed 与
 * 箭头 ▾/▸ 上，而不是文本是否存在。
 */

function makeArgument(over: Partial<ExpertArgument> = {}): ExpertArgument {
  return {
    text: '订单能见度延长至两个季度',
    confidence: 80,
    type: 'support',
    evidenceType: 'fact',
    ...over,
  };
}

function makeOpinion(over: Partial<ExpertOpinion> = {}): ExpertOpinion {
  return {
    expert: '张三',
    arguments: [makeArgument()],
    overallSentiment: 'bullish',
    confidence: 82,
    keyPoints: ['毛利率维持高位'],
    ...over,
  };
}

function renderList(data: ExpertOpinion[]) {
  return render(<ExpertOpinions data={data} />);
}

/** 按专家名取该面板的标题行（点击目标） */
function headerOf(expert: string): HTMLElement {
  return screen.getByText(expert).closest('.expert-header') as HTMLElement;
}

/** 按专家名取折叠头的按钮（键盘/读屏入口） */
function headerButtonOf(expert: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(expert) });
}

/** 按专家名取该面板的正文容器 */
function bodyOf(expert: string): HTMLElement {
  return screen
    .getByText(expert)
    .closest('.expert-panel')!
    .querySelector('.expert-body') as HTMLElement;
}

describe('ExpertOpinions —— 空态', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('专家数组为空时不渲染卡片', () => {
    const { container } = renderList([]);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('专家观点')).toBeNull();
  });

  it('data 为 undefined 时走默认空数组，同样不渲染', () => {
    const { container } = renderList(undefined as unknown as ExpertOpinion[]);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('ExpertOpinions —— 标题行信息', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染区块标题与每位专家的名字', () => {
    renderList([makeOpinion(), makeOpinion({ expert: '李四' })]);

    expect(screen.getByText('专家观点')).toBeInTheDocument();
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.getByText('李四')).toBeInTheDocument();
  });

  it('信心度按「N%」显示在标题行', () => {
    renderList([makeOpinion({ confidence: 82 })]);

    expect(headerOf('张三').querySelector('.confidence-badge')).toHaveTextContent('82%');
  });

  it('信心度 0% 照常显示，不被当成缺失', () => {
    renderList([makeOpinion({ confidence: 0 })]);

    expect(headerOf('张三').querySelector('.confidence-badge')).toHaveTextContent('0%');
  });

  it('三种情绪映射到「看多 / 中性 / 看空」并带原始类名', () => {
    renderList([
      makeOpinion({ expert: '看多派', overallSentiment: 'bullish' }),
      makeOpinion({ expert: '中性派', overallSentiment: 'neutral' }),
      makeOpinion({ expert: '看空派', overallSentiment: 'bearish' }),
    ]);

    const sentiment = (expert: string) =>
      headerOf(expert).querySelector('.expert-sentiment') as HTMLElement;
    expect(sentiment('看多派')).toHaveTextContent('看多');
    expect(sentiment('看多派')).toHaveClass('expert-sentiment', 'bullish');
    expect(sentiment('中性派')).toHaveTextContent('中性');
    expect(sentiment('中性派')).toHaveClass('expert-sentiment', 'neutral');
    expect(sentiment('看空派')).toHaveTextContent('看空');
    expect(sentiment('看空派')).toHaveClass('expert-sentiment', 'bearish');
  });

  it('未识别的情绪值回退为「中性」', () => {
    renderList([makeOpinion({ overallSentiment: 'mixed' as ExpertOpinion['overallSentiment'] })]);

    expect(headerOf('张三').querySelector('.expert-sentiment')).toHaveTextContent('中性');
  });
});

describe('ExpertOpinions —— 展开与收起', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('初始为折叠态：箭头 ▸ + expert-body-closed + aria-expanded=false', () => {
    renderList([makeOpinion()]);

    expect(headerOf('张三').querySelector('.expert-arrow')).toHaveTextContent('▸');
    expect(bodyOf('张三')).toHaveClass('expert-body', 'expert-body-closed');
    expect(headerButtonOf('张三')).toHaveAttribute('aria-expanded', 'false');
  });

  it('折叠头是真正的 button：键盘/读屏可达，且不提交表单', () => {
    renderList([makeOpinion()]);

    const btn = headerButtonOf('张三');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    // 用键盘激活（Enter / Space 在原生 button 上都会触发 click）
    fireEvent.click(btn);
    expect(bodyOf('张三')).toHaveClass('expert-body-open');
  });

  it('点击标题行展开：箭头变 ▾、正文加 expert-body-open、aria-expanded=true', () => {
    renderList([makeOpinion()]);

    fireEvent.click(headerOf('张三'));

    expect(headerOf('张三').querySelector('.expert-arrow')).toHaveTextContent('▾');
    expect(bodyOf('张三')).toHaveClass('expert-body', 'expert-body-open');
    expect(headerButtonOf('张三')).toHaveAttribute('aria-expanded', 'true');
  });

  it('再次点击同一标题行收起（aria-expanded 回到 false）', () => {
    renderList([makeOpinion()]);

    fireEvent.click(headerOf('张三'));
    fireEvent.click(headerOf('张三'));

    expect(headerOf('张三').querySelector('.expert-arrow')).toHaveTextContent('▸');
    expect(bodyOf('张三')).toHaveClass('expert-body-closed');
    expect(headerButtonOf('张三')).toHaveAttribute('aria-expanded', 'false');
  });

  it('同时只展开一位：展开李四会收起张三', () => {
    renderList([makeOpinion(), makeOpinion({ expert: '李四', arguments: [], keyPoints: [] })]);

    fireEvent.click(headerOf('张三'));
    expect(bodyOf('张三')).toHaveClass('expert-body-open');

    fireEvent.click(headerOf('李四'));
    expect(bodyOf('李四')).toHaveClass('expert-body-open');
    expect(bodyOf('张三')).toHaveClass('expert-body-closed');

    fireEvent.click(headerOf('李四'));
    expect(bodyOf('李四')).toHaveClass('expert-body-closed');
    expect(bodyOf('张三')).toHaveClass('expert-body-closed');
  });
});

describe('ExpertOpinions —— 论据渲染', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('论据文本与「support / oppose」立场类名都渲染', () => {
    const { container } = renderList([
      makeOpinion({
        arguments: [
          makeArgument({ text: '支持理由', type: 'support' }),
          makeArgument({ text: '反对理由', type: 'oppose' }),
        ],
      }),
    ]);

    const args = Array.from(container.querySelectorAll('.arg-item'));
    expect(args).toHaveLength(2);
    expect(args[0]).toHaveTextContent('支持理由');
    expect(args[0]).toHaveClass('arg-item', 'support');
    expect(args[1]).toHaveTextContent('反对理由');
    expect(args[1]).toHaveClass('arg-item', 'oppose');
  });

  it('fact/inference/hypothesis 三种证据类型分别显示中文方括号标签', () => {
    const { container } = renderList([
      makeOpinion({
        arguments: [
          makeArgument({ text: 'A', evidenceType: 'fact' }),
          makeArgument({ text: 'B', evidenceType: 'inference' }),
          makeArgument({ text: 'C', evidenceType: 'hypothesis' }),
        ],
      }),
    ]);

    const tags = Array.from(container.querySelectorAll('.evidence-tag')).map((t) => ({
      text: t.textContent,
      cls: t.className,
    }));
    expect(tags).toEqual([
      { text: '[事实]', cls: 'evidence-tag fact' },
      { text: '[推演]', cls: 'evidence-tag inference' },
      { text: '[假设]', cls: 'evidence-tag hypothesis' },
    ]);
  });

  it('没有 evidenceType 时不渲染证据标签', () => {
    const { container } = renderList([
      makeOpinion({ arguments: [makeArgument({ evidenceType: undefined })] }),
    ]);

    expect(container.querySelector('.evidence-tag')).toBeNull();
    expect(container.querySelector('.arg-item')).toHaveTextContent('订单能见度延长至两个季度');
  });

  it('未识别的 evidenceType 仍渲染空标签（现状：evidenceTagLabel 返回空串）', () => {
    const { container } = renderList([
      makeOpinion({ arguments: [makeArgument({ evidenceType: 'rumor' as 'fact' })] }),
    ]);

    const tag = container.querySelector('.evidence-tag');
    expect(tag).not.toBeNull();
    expect(tag).toHaveTextContent('');
  });

  it('每条论据带自己的信心度徽标', () => {
    const { container } = renderList([
      makeOpinion({
        arguments: [makeArgument({ confidence: 55 }), makeArgument({ confidence: 90 })],
      }),
    ]);

    const badges = Array.from(container.querySelectorAll('.arg-item .confidence-badge')).map(
      (b) => b.textContent,
    );
    expect(badges).toEqual(['55%', '90%']);
  });

  it('arguments 为空数组时论据区为空但不报错', () => {
    const { container } = renderList([makeOpinion({ arguments: [], keyPoints: [] })]);

    expect(container.querySelector('.expert-args')).not.toBeNull();
    expect(container.querySelectorAll('.arg-item')).toHaveLength(0);
  });
});

describe('ExpertOpinions —— 关键要点', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('有关键要点时渲染标题与全部条目', () => {
    const { container } = renderList([
      makeOpinion({ keyPoints: ['毛利率维持高位', '现金流改善'] }),
    ]);

    expect(container.querySelector('.keypoints-label')).toHaveTextContent('关键要点：');
    const items = Array.from(container.querySelectorAll('.expert-keypoints li')).map(
      (li) => li.textContent,
    );
    expect(items).toEqual(['毛利率维持高位', '现金流改善']);
  });

  it('关键要点为空数组时不渲染该块', () => {
    const { container } = renderList([makeOpinion({ keyPoints: [] })]);

    expect(container.querySelector('.expert-keypoints')).toBeNull();
    expect(screen.queryByText('关键要点：')).toBeNull();
  });

  it('缺 keyPoints 字段（undefined）时不抛错且不渲染该块', () => {
    const { container } = renderList([
      makeOpinion({ keyPoints: undefined as unknown as string[] }),
    ]);

    expect(container.querySelector('.expert-keypoints')).toBeNull();
    expect(container.querySelector('.arg-item')).not.toBeNull();
  });

  it('展开/收起只切换类名，论据与要点文本始终在文档中（现状）', () => {
    const { container } = renderList([makeOpinion({ keyPoints: ['毛利率维持高位'] })]);

    expect(bodyOf('张三')).toHaveClass('expert-body-closed');
    expect(screen.getByText('订单能见度延长至两个季度')).toBeInTheDocument();
    expect(container.querySelector('.expert-keypoints')).not.toBeNull();

    fireEvent.click(headerOf('张三'));
    expect(bodyOf('张三')).toHaveClass('expert-body-open');
    expect(screen.getByText('订单能见度延长至两个季度')).toBeInTheDocument();
  });
});
