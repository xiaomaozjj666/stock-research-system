// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatPanel from '../ChatPanel';

vi.mock('../../api/client', () => ({
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
