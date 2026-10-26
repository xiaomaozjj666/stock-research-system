// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FollowUpSection from '../FollowUpSection';
import type { ThesisRecord } from '../../api/generated';

const apiMock = vi.hoisted(() => ({
  getTheses: vi.fn(),
  createThesis: vi.fn(),
  evaluateThesis: vi.fn(),
}));
vi.mock('../../api/client', () => apiMock);

const DATA = ['季度营收/净利润增速变化', '经营现金流/净利润比率', '毛利率/净利率趋势变化'];

describe('FollowUpSection 后续跟踪指标', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.getTheses.mockReset().mockResolvedValue({ items: [] });
    apiMock.createThesis.mockReset();
    apiMock.evaluateThesis.mockReset();
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

  it('创建预注册时提交完整冻结口径并展示 active', async () => {
    const created: ThesisRecord = {
      id: 'thesis-1',
      stockCode: '600519',
      thesis: '跌破证伪线则撤销',
      rating: '持续观察',
      metric: 'return_pct',
      comparator: 'lte',
      threshold: -5,
      horizonDays: 20,
      evidenceSource: 'real_ohlcv',
      invalidationAction: '撤销假设并复核风险',
      benchmarkCode: '000300',
      execution: {
        side: 'buy',
        orderType: 'market',
        entryPrice: 100,
        quantity: 100,
        commissionRate: 0.0003,
        stampDutyRate: 0.0005,
      },
      createdAt: '2026-01-01T12:00:00.000Z',
      dueAt: '2026-01-21T12:00:00.000Z',
      status: 'active',
      evidenceStatus: 'pending',
    };
    apiMock.createThesis.mockResolvedValue({ thesis: created });
    render(
      <FollowUpSection
        data={DATA}
        stockCode="600519"
        enableThesis
        rating="持续观察"
        entryPrice={100}
      />,
    );

    fireEvent.change(screen.getByLabelText('投资论点'), { target: { value: '跌破证伪线则撤销' } });
    fireEvent.click(screen.getByRole('button', { name: '冻结并创建实验' }));

    await waitFor(() => expect(apiMock.createThesis).toHaveBeenCalledTimes(1));
    expect(apiMock.createThesis).toHaveBeenCalledWith({
      stockCode: '600519',
      thesis: '跌破证伪线则撤销',
      rating: '持续观察',
      metric: 'return_pct',
      comparator: 'lte',
      threshold: -5,
      horizonDays: 20,
      evidenceSource: 'real_ohlcv',
      invalidationAction: '撤销假设并复核风险',
      benchmarkCode: '000300',
      execution: {
        side: 'buy',
        orderType: 'market',
        entryPrice: 100,
        quantity: 100,
        commissionRate: 0.0003,
        stampDutyRate: 0.0005,
      },
    });
    expect(await screen.findByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('未到期或未评估，口径已冻结')).toBeInTheDocument();
  });

  it('评估后展示证据不足，不制造收益结论', async () => {
    const active: ThesisRecord = {
      id: 'thesis-2',
      stockCode: '600519',
      thesis: '等待真实证据',
      rating: '持续观察',
      metric: 'return_pct',
      comparator: 'lte',
      threshold: -5,
      horizonDays: 20,
      evidenceSource: 'real_ohlcv',
      invalidationAction: '撤销假设',
      benchmarkCode: '000300',
      execution: {
        side: 'buy',
        orderType: 'market',
        entryPrice: 100,
        quantity: 100,
        commissionRate: 0.0003,
        stampDutyRate: 0.0005,
      },
      createdAt: '2026-01-01T12:00:00.000Z',
      dueAt: '2026-01-21T12:00:00.000Z',
      status: 'active',
      evidenceStatus: 'pending',
    };
    apiMock.getTheses.mockResolvedValue({ items: [active] });
    apiMock.evaluateThesis.mockResolvedValue({
      thesis: {
        ...active,
        status: 'expired',
        evidenceStatus: 'insufficient_evidence',
        reason: 'insufficient_evidence',
      },
    });
    render(
      <FollowUpSection
        data={DATA}
        stockCode="600519"
        enableThesis
        rating="持续观察"
        entryPrice={100}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '按冻结口径评估' }));
    expect(await screen.findByText('已到期')).toBeInTheDocument();
    expect(screen.getByText(/证据不足：到期时无可用真实完成 K 线/)).toBeInTheDocument();
    expect(screen.queryByText(/净收益率 -?\d/)).not.toBeInTheDocument();
    expect(apiMock.evaluateThesis).toHaveBeenCalledWith('thesis-2');
  });
});
