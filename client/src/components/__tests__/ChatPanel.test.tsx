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
});
