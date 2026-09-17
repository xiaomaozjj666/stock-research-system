// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MobileNav from '../MobileNav';

/** 目录项与 App 各区块的 id 对齐；「风险清单」在下方用于验证跳转落到正确的锚点 */
const SECTIONS = [
  '核心摘要',
  '财务分析',
  '数据图表',
  '估值分析',
  '专家观点',
  '资金筹码',
  '情景推演',
  '量化策略',
  '综合评分',
  '争议焦点',
  '风险清单',
  '自省校验',
  '研究局限性',
  '跟踪指标',
];

function renderNav(activeSection = 'summary') {
  return render(<MobileNav activeSection={activeSection} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MobileNav 移动端目录抽屉', () => {
  it('默认收起：切换按钮标注 aria-expanded=false，且不渲染抽屉对话框', () => {
    renderNav();

    const toggle = screen.getByRole('button', { name: '目录导航' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // 收起时目录项完全不在 DOM 里，读屏与键盘都不会落到隐藏内容上
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: '核心摘要' })).toBeNull();
  });

  it('点击切换按钮展开：列出 14 个中文目录项，aria-expanded 转为 true', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));

    const dialog = screen.getByRole('dialog', { name: '目录' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '目录导航' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    for (const label of SECTIONS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('切换按钮的 aria-controls 指向抽屉容器 id（读屏能关联按钮与面板）', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));

    const toggle = screen.getByRole('button', { name: '目录导航' });
    const dialog = screen.getByRole('dialog', { name: '目录' });
    expect(toggle.getAttribute('aria-controls')).toBe(dialog.id);
    expect(dialog.id).not.toBe('');
  });

  it('展开后焦点自动落入抽屉第一项，键盘用户不必再 Tab 找入口', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '核心摘要' }));
  });

  it('再次点击切换按钮收起，并把焦点交还切换按钮', () => {
    renderNav();
    const toggle = screen.getByRole('button', { name: '目录导航' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(toggle);
  });

  it('按 Esc 关闭抽屉并归还焦点（打开状态才绑定键盘监听）', () => {
    renderNav();
    const toggle = screen.getByRole('button', { name: '目录导航' });
    fireEvent.click(toggle);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('其它按键不关闭抽屉（只有 Esc 才收起）', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));

    fireEvent.keyDown(document, { key: 'a' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });

    expect(screen.getByRole('dialog', { name: '目录' })).toBeInTheDocument();
  });

  it('点击目录项：收起抽屉并平滑滚动到对应区块', () => {
    const { container } = render(
      <div>
        <div id="risk">风险清单区块</div>
        <MobileNav activeSection="summary" />
      </div>,
    );
    const target = container.querySelector('#risk') as HTMLElement;
    const scrollSpy = vi.spyOn(target, 'scrollIntoView').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));
    fireEvent.click(screen.getByRole('button', { name: '风险清单' }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // 关闭后焦点回到切换按钮，键盘用户停留在原处而不是丢失焦点
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '目录导航' }));
  });

  it('系统开启「减少动态效果」时改为瞬时跳转（behavior: auto），不再平滑滚动', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const { container } = render(
      <div>
        <div id="risk">风险清单区块</div>
        <MobileNav activeSection="summary" />
      </div>,
    );
    const target = container.querySelector('#risk') as HTMLElement;
    const scrollSpy = vi.spyOn(target, 'scrollIntoView').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));
    fireEvent.click(screen.getByRole('button', { name: '风险清单' }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('目标区块不存在时点击目录项：不抛异常，抽屉照常收起', () => {
    const { container } = render(<MobileNav activeSection="summary" />);
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));
    fireEvent.click(screen.getByRole('button', { name: '跟踪指标' }));

    expect(container.querySelector('#followup')).toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('高亮当前所在区块：activeSection 对应的目录项带 active 类，其余不带', () => {
    renderNav('valuation');
    fireEvent.click(screen.getByRole('button', { name: '目录导航' }));

    expect(screen.getByRole('button', { name: '估值分析' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: '核心摘要' })).not.toHaveClass('active');
  });

  it('收起后重新展开仍是完整目录（Esc 关闭时的监听已解绑，不残留状态）', () => {
    renderNav();
    const toggle = screen.getByRole('button', { name: '目录导航' });

    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(toggle);

    expect(screen.getByRole('dialog', { name: '目录' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /核心摘要|跟踪指标/ })).toHaveLength(2);
  });
});
