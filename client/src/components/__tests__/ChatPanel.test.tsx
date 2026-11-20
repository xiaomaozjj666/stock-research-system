// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatPanel from '../ChatPanel';
import { chatWithAgent, chatWithAgentStream, type ChatStreamEvent } from '../../api/client';

vi.mock('../../api/client', () => ({
  // 组件对取消错误做 instanceof 判定——factory 必须导出同一个类，否则取消路径
  // 在运行时会因「mock 上没有该导出」直接抛错（旧用例从未触发取消路径，故未暴露）
  AnalysisCancelledError: class AnalysisCancelledError extends Error {
    name = 'AnalysisCancelledError';
  },
  chatWithAgent: vi.fn(async () => ({
    answer: '这是回复',
    toolsUsed: ['run_analysis'],
    evidence: [{ id: 'e1', source: 'cache:x', text: '证据内容片段' }],
    debate: undefined,
    degraded: false,
  })),
  // 流式优先路径：同步推送 done 事件即完成
  chatWithAgentStream: vi.fn((_message: string, onEvent: (e: unknown) => void) => {
    onEvent({
      phase: 'done',
      message: '完成',
      response: {
        answer: '这是回复',
        toolsUsed: ['run_analysis'],
        evidence: [{ id: 'e1', source: 'cache:x', text: '证据内容片段' }],
        debate: undefined,
        degraded: false,
      },
    });
    return { cancel: vi.fn() };
  }),
}));

describe('ChatPanel', () => {
  it('渲染空状态与快捷提问', () => {
    render(<ChatPanel />);
    expect(screen.getByText('研究助手')).toBeInTheDocument();
    expect(screen.getByText(/帮我分析 600519/)).toBeInTheDocument();
  });

  it('发送消息后展示助手回复与工具徽章', async () => {
    render(<ChatPanel />);
    const ta = screen.getByLabelText('对话输入') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '分析 600519' } });
    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(screen.getByText('这是回复')).toBeInTheDocument());
    expect(screen.getByText(/工具: run_analysis/)).toBeInTheDocument();
  });

  it('快捷提问按钮可触发对话', async () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByText(/对比 600519 和 000858/));
    await waitFor(() => expect(screen.getByText('这是回复')).toBeInTheDocument());
  });

  it('Enter 键发送、Shift+Enter 不发送（换行）', async () => {
    render(<ChatPanel />);
    const ta = screen.getByLabelText('对话输入') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '分析 600519' } });
    // Shift+Enter：不应触发发送
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(screen.queryByText('这是回复')).not.toBeInTheDocument();
    // Enter：触发发送
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('这是回复')).toBeInTheDocument());
  });

  it('空输入时发送按钮禁用', () => {
    render(<ChatPanel />);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('清空按钮清空当前对话', async () => {
    render(<ChatPanel />);
    const ta = screen.getByLabelText('对话输入') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '分析 600519' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('这是回复')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(screen.queryByText('这是回复')).not.toBeInTheDocument();
  });
});

describe('ChatPanel 未覆盖分支（覆盖率补强）', () => {
  const RICH = {
    answer: '这是带完整元信息的回复',
    toolsUsed: ['run_analysis'],
    evidence: [{ id: 'e1', source: 'cache:x', text: '证据内容片段'.repeat(30) }],
    debate: { bull: '看多理由', bear: '看空理由', synthesis: '综合意见' },
    degraded: false,
    verification: {
      verified: false,
      warning: '存在未经核实的断言',
      unverified: ['断言一'],
      calculationErrors: [
        {
          claim: '营收增速 12%',
          reconstructedFormula: '|12/10-1|',
          recomputedValue: '0.2',
          claimedValue: '0.12',
          discrepancy: '数值不符',
        },
      ],
    },
  };

  it('证据展开/收起、事实校验告警、计算核验与辩论块渲染', async () => {
    vi.mocked(chatWithAgentStream).mockImplementationOnce(
      (_m: string, onEvent: (e: ChatStreamEvent) => void) => {
        onEvent({ phase: 'done', message: '完成', response: RICH });
        return { cancel: vi.fn() };
      },
    );
    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('对话输入'), { target: { value: '分析一下' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // 事实校验告警（role=alert）+ 计算核验明细
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('事实校验');
    expect(alert).toHaveTextContent('断言一');
    expect(alert).toHaveTextContent('营收增速 12%');
    // 辩论块
    expect(screen.getByText('看多理由')).toBeInTheDocument();
    expect(screen.getByText('看空理由')).toBeInTheDocument();

    // 证据默认收起，点击后展开（并截断到 160 字）
    const toggle = screen.getByRole('button', { name: /证据 1 条/ });
    expect(screen.queryByText(/证据内容片段/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText(/证据内容片段/)).toBeInTheDocument();
    });
    // 展开后按钮指示变为收起态
    expect(screen.getByRole('button', { name: /▲/ })).toBeInTheDocument();
  });

  it('流式阶段事件更新进度文案（非 done/error 分支）', async () => {
    let push: ((e: ChatStreamEvent) => void) | null = null;
    vi.mocked(chatWithAgentStream).mockImplementationOnce(
      (_m: string, onEvent: (e: ChatStreamEvent) => void) => {
        push = onEvent;
        return { cancel: vi.fn() };
      },
    );
    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('对话输入'), { target: { value: '分析一下' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // 推送一个阶段事件后，加载气泡应显示该阶段文案
    await waitFor(() => expect(push).not.toBeNull());
    push!({ phase: 'planning', message: '正在规划执行路径…' });
    expect(await screen.findByText('正在规划执行路径…')).toBeInTheDocument();
  });

  it('流式失败 → 自动回退非流式接口，答案仍可呈现', async () => {
    vi.mocked(chatWithAgentStream).mockImplementationOnce(
      (_m: string, onEvent: (e: ChatStreamEvent) => void) => {
        onEvent({ phase: 'error', message: '流式连接中断' });
        return { cancel: vi.fn() };
      },
    );
    const mockFallback = vi.mocked(chatWithAgent);
    mockFallback.mockClear();
    mockFallback.mockResolvedValueOnce({
      answer: '回退后的回复',
      toolsUsed: [],
      evidence: [],
      debate: undefined,
      degraded: false,
    });

    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('对话输入'), { target: { value: '分析一下' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('回退后的回复')).toBeInTheDocument();
    expect(mockFallback).toHaveBeenCalledTimes(1);
  });

  it('点击停止 → 追加「已取消」提示并复位输入态（loading=false）', async () => {
    vi.mocked(chatWithAgentStream).mockImplementationOnce(() => ({ cancel: vi.fn() }));
    render(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('对话输入'), { target: { value: '分析一下' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const stop = await screen.findByRole('button', { name: '停止生成' });
    fireEvent.click(stop);

    expect(await screen.findByText('已取消本次回答')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument();
    });
  });
});
