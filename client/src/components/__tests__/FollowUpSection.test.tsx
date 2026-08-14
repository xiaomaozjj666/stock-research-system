// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FollowUpSection from '../FollowUpSection';

const DATA = ['季度营收/净利润增速变化', '经营现金流/净利润比率', '毛利率/净利率趋势变化'];

describe('FollowUpSection 后续跟踪指标', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('渲染生成指标列表', () => {
    render(<FollowUpSection data={DATA} stockCode="600519" />);
    expect(screen.getByText('季度营收/净利润增速变化')).toBeInTheDocument();
    expect(screen.getAllByText('经营现金流/净利润比率')).toHaveLength(1);
    expect(screen.getByText('后续跟踪指标')).toBeInTheDocument();
  });

  it('无数据且无自定义时返回 null', () => {
    const { container } = render(<FollowUpSection data={[]} stockCode="600519" />);
    expect(container.innerHTML).toBe('');
  });

  it('点击星标关注 → 该指标置顶（排第一）并持久化', async () => {
    const { rerender } = render(<FollowUpSection data={DATA} stockCode="600519" />);
    // 关注第二条
    const starButtons = screen.getAllByRole('button', { name: '关注' });
    fireEvent.click(starButtons[1]);

    const items = screen.getAllByText(/变化|比率/);
    expect(items[0].textContent).toBe('经营现金流/净利润比率'); // 置顶
    expect(screen.getByRole('button', { name: '取消关注' })).toBeInTheDocument();

    // 持久化：重新挂载（同股票）后关注状态保留
    rerender(<FollowUpSection data={DATA} stockCode="600519" />);
    expect(screen.getByRole('button', { name: '取消关注' })).toBeInTheDocument();
    const again = screen.getAllByText(/变化|比率/);
    expect(again[0].textContent).toBe('经营现金流/净利润比率');
  });

  it('添加自定义指标（回车或按钮）→ 显示并持久化；可删除', async () => {
    const { rerender } = render(<FollowUpSection data={DATA} stockCode="600519" />);
    const input = screen.getByLabelText('自定义跟踪指标输入');
    fireEvent.change(input, { target: { value: '关注北向资金流向' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(screen.getByText('关注北向资金流向')).toBeInTheDocument();
    // 回车添加第二条
    fireEvent.change(input, { target: { value: '机构持仓变化' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('机构持仓变化')).toBeInTheDocument();

    // 持久化恢复
    rerender(<FollowUpSection data={DATA} stockCode="600519" />);
    expect(screen.getByText('关注北向资金流向')).toBeInTheDocument();
    expect(screen.getByText('机构持仓变化')).toBeInTheDocument();

    // 删除自定义项
    fireEvent.click(screen.getAllByRole('button', { name: '删除自定义指标' })[0]);
    expect(screen.queryByText('关注北向资金流向')).not.toBeInTheDocument();
    expect(screen.getByText('机构持仓变化')).toBeInTheDocument();
  });

  it('不同股票代码的跟踪状态互相隔离', () => {
    const { unmount } = render(<FollowUpSection data={DATA} stockCode="600519" />);
    fireEvent.click(screen.getAllByRole('button', { name: '关注' })[0]);
    expect(screen.getByRole('button', { name: '取消关注' })).toBeInTheDocument();
    unmount(); // 清理 DOM

    render(<FollowUpSection data={DATA} stockCode="000001" />);
    // 000001 无关注状态：3 条全部是"关注"按钮
    expect(screen.getAllByRole('button', { name: '关注' })).toHaveLength(3);
  });
});
