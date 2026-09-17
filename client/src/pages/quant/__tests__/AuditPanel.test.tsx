// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AuditPanel from '../AuditPanel';
import type { AuditReport } from '../types';

/**
 * AuditPanel 行为测试
 * ----------------------------------------------------------------------------
 * 三条风险维度按 low/medium/high 映射到状态色板（低=好 → sig-valid 绿、
 * 中 → chip-neutral、高 → chip-danger 红）与「低/中/高」；检查项通过与否决定
 * 图标（✓ / ⚠ / ✕）与颜色。
 *
 * 颜色口径：涨跌色（--color-positive 红 / --color-negative 绿）只表达数值方向，
 * 「通过 / 严重程度」是状态语义，不得借用——否则会渲染成「通过的 ✓ 是红色、
 * critical 的 ✕ 是绿色」。
 */

function makeAudit(over: Partial<AuditReport> = {}): AuditReport {
  return {
    riskScore: 72,
    futureFunctionRisk: 'low',
    overfittingRisk: 'medium',
    survivorshipBias: 'high',
    checks: [
      { name: '未来函数检查', passed: true, detail: '未发现引用未来数据', severity: 'info' },
      { name: '参数稳定性', passed: false, detail: '参数敏感度过高', severity: 'warning' },
      { name: '数据泄漏', passed: false, detail: '检出收益序列泄漏', severity: 'critical' },
    ],
    issues: [],
    reliability: '样本外表现与样本内接近，整体可信',
    ...over,
  };
}

function renderPanel(data: AuditReport) {
  return render(<AuditPanel data={data} />);
}

/** 按中文维度名（未来函数 / 过拟合 / 幸存者偏差）取该行的风险徽标 */
function riskChip(label: string): HTMLElement {
  const item = screen.getByText(label).closest('.quant-audit-risk-item') as HTMLElement;
  return item.querySelector('.chip') as HTMLElement;
}

/** 按检查项名称取该行的图标元素 */
function checkIcon(name: string): HTMLElement {
  const item = screen.getByText(name).closest('.quant-check-item') as HTMLElement;
  return item.querySelector('.quant-check-icon') as HTMLElement;
}

describe('AuditPanel —— 风险评分', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('显示标题「回测审计报告」、风险评分数字与满分口径', () => {
    const { container } = renderPanel(makeAudit());

    expect(screen.getByRole('heading', { name: '回测审计报告' })).toBeInTheDocument();
    expect(container.querySelector('.quant-audit-score')?.textContent).toBe('72/100');
    expect(screen.getByText('风险评分')).toBeInTheDocument();
  });

  it('边界分 0 与 100 原样展示，不做缺省替换', () => {
    const { container, unmount } = renderPanel(makeAudit({ riskScore: 0 }));
    expect(container.querySelector('.quant-audit-score')?.textContent).toBe('0/100');
    unmount();

    const second = renderPanel(makeAudit({ riskScore: 100 }));
    expect(second.container.querySelector('.quant-audit-score')?.textContent).toBe('100/100');
  });

  it('超过满分的 riskScore 不做截断（现状：123 显示为 123/100）', () => {
    const { container } = renderPanel(makeAudit({ riskScore: 123 }));

    expect(container.querySelector('.quant-audit-score')?.textContent).toBe('123/100');
  });
});

describe('AuditPanel —— 三档风险徽标', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('low → 「低」+ sig-valid（状态绿）；medium → 「中」+ chip-neutral', () => {
    renderPanel(makeAudit());

    expect(riskChip('未来函数')).toHaveTextContent('低');
    expect(riskChip('未来函数')).toHaveClass('chip', 'sig-valid');
    expect(riskChip('过拟合')).toHaveTextContent('中');
    expect(riskChip('过拟合')).toHaveClass('chip', 'chip-neutral');
  });

  it('high → 「高」+ chip-danger（警示红，不是涨跌口径的绿）', () => {
    const { unmount } = renderPanel(makeAudit());
    expect(riskChip('幸存者偏差')).toHaveTextContent('高');
    expect(riskChip('幸存者偏差')).toHaveClass('chip', 'chip-danger');
    expect(riskChip('幸存者偏差')).not.toHaveClass('chip-negative');
    unmount();

    // 三条维度互换档位后，徽标跟着走（说明取的是各自字段而不是写死）
    renderPanel(
      makeAudit({
        futureFunctionRisk: 'high',
        overfittingRisk: 'low',
        survivorshipBias: 'medium',
      }),
    );
    expect(riskChip('未来函数')).toHaveClass('chip-danger');
    expect(riskChip('过拟合')).toHaveClass('sig-valid');
    expect(riskChip('幸存者偏差')).toHaveClass('chip-neutral');
  });
});

describe('AuditPanel —— 检查项列表', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('通过项显示 ✓ 并用 --color-success（状态绿）着色，不用涨跌红', () => {
    renderPanel(makeAudit());

    const icon = checkIcon('未来函数检查');
    expect(icon).toHaveTextContent('✓');
    expect(icon.style.color).toBe('var(--color-success)');
    expect(icon.style.color).not.toBe('var(--color-positive)');
    expect(screen.getByText('未发现引用未来数据')).toBeInTheDocument();
  });

  it('未通过且 severity=warning 显示 ⚠ 并用 --color-warning 着色', () => {
    renderPanel(makeAudit());

    const icon = checkIcon('参数稳定性');
    expect(icon).toHaveTextContent('⚠');
    expect(icon.style.color).toBe('var(--color-warning)');
    expect(screen.getByText('参数敏感度过高')).toBeInTheDocument();
  });

  it('未通过且 severity=critical 显示 ✕ 并用 --color-danger（警示红）着色', () => {
    renderPanel(makeAudit());

    const icon = checkIcon('数据泄漏');
    expect(icon).toHaveTextContent('✕');
    expect(icon.style.color).toBe('var(--color-danger)');
    expect(icon.style.color).not.toBe('var(--color-negative)');
    expect(screen.getByText('检出收益序列泄漏')).toBeInTheDocument();
  });

  it('未通过但 severity=info 显示 ℹ 并用 --color-info 着色', () => {
    renderPanel(
      makeAudit({
        checks: [{ name: '样本量', passed: false, detail: '样本偏少', severity: 'info' }],
      }),
    );

    const icon = checkIcon('样本量');
    expect(icon).toHaveTextContent('ℹ');
    expect(icon.style.color).toBe('var(--color-info)');
  });

  it('通过与否优先于 severity：passed=true 时即便 severity=critical 也显示 ✓', () => {
    renderPanel(
      makeAudit({
        checks: [
          { name: '重叠修正', passed: true, detail: '已做 Holm 校正', severity: 'critical' },
        ],
      }),
    );

    const icon = checkIcon('重叠修正');
    expect(icon).toHaveTextContent('✓');
    expect(icon).not.toHaveTextContent('✕');
    expect(icon.style.color).toBe('var(--color-success)');
  });

  it('checks 为空数组时不渲染「检查项」小节', () => {
    const { container } = renderPanel(makeAudit({ checks: [] }));

    expect(screen.queryByText('检查项')).toBeNull();
    expect(container.querySelector('.quant-audit-checks')).toBeNull();
    expect(container.querySelectorAll('.quant-check-item')).toHaveLength(0);
  });

  it('多条检查项按数据顺序渲染', () => {
    const { container } = renderPanel(makeAudit());

    const names = Array.from(container.querySelectorAll('.quant-check-name')).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(['未来函数检查', '参数稳定性', '数据泄漏']);
  });
});

describe('AuditPanel —— 可靠性评估', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reliability 有值时渲染小节标题与正文', () => {
    const { container } = renderPanel(makeAudit());

    expect(screen.getByText('可靠性评估')).toBeInTheDocument();
    expect(screen.getByText('样本外表现与样本内接近，整体可信')).toBeInTheDocument();
    expect(container.querySelector('.quant-audit-reliability')).not.toBeNull();
  });

  it('reliability 为空串时整段不渲染', () => {
    const { container } = renderPanel(makeAudit({ reliability: '' }));

    expect(screen.queryByText('可靠性评估')).toBeNull();
    expect(container.querySelector('.quant-audit-reliability')).toBeNull();
  });
});
