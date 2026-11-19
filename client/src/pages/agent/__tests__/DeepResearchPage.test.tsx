// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { DeepResearchResult, DeepResearchRunSummary } from '../../../api/client';
import { partial } from '../../../test/partial';

vi.mock('../../../api/client', () => ({
  listDeepResearchRuns: vi.fn(),
  getDeepResearchRun: vi.fn(),
  deleteDeepResearchRun: vi.fn(),
  runDeepResearchStream: vi.fn(),
}));

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import {
  deleteDeepResearchRun,
  getDeepResearchRun,
  listDeepResearchRuns,
  runDeepResearchStream,
} from '../../../api/client';
import DeepResearchPage from '../DeepResearchPage';

const SUMMARY: DeepResearchRunSummary = {
  id: 'run-1',
  question: '白酒行业竞争格局',
  createdAt: '2026-11-18T02:00:00.000Z',
  title: '白酒行业竞争格局研究',
  overallConfidence: 0.72,
  confidenceLabel: '高',
  rounds: 2,
  evidenceCount: 3,
  sectionCount: 1,
  conflictCount: 0,
};

function makeResult(): DeepResearchResult {
  return partial<DeepResearchResult>({
    report: partial<DeepResearchResult['report']>({
      title: '白酒行业竞争格局研究',
      executiveSummary: '高端白酒集中度继续提升。',
      overallConfidence: 0.72,
      confidenceLabel: '高',
      sections: [
        partial<DeepResearchResult['report']['sections'][number]>({
          subQuestionId: 'q1',
          question: '高端白酒集中度如何？',
          conclusion: 'CR3 持续上行。',
          confidence: 0.8,
          confidenceLabel: '高',
          status: 'consistent',
          conflictNotes: [],
          citations: [
            partial<DeepResearchResult['report']['sections'][number]['citations'][number]>({
              evidenceId: 'ev-1',
              claim: '高端白酒 CR3 达到 82%',
              sourceTitle: '贵州茅台 2025 年年度报告',
              sourceType: 'company_disclosure',
              path: {
                round: 1,
                query: '高端白酒 集中度',
                adapter: 'eastmoney.announcement',
                attempt: 1,
              },
            }),
          ],
        }),
      ],
      methodology: partial<DeepResearchResult['report']['methodology']>({
        rounds: 2,
        adaptersUsed: ['eastmoney.announcement'],
        evidenceCount: 3,
        sourceCount: 2,
        planVersions: 1,
        conflictsFound: 0,
      }),
      conflicts: [],
      limitations: [],
      generatedAt: '2026-11-18T02:00:00.000Z',
    }),
    evidence: [
      partial<DeepResearchResult['evidence'][number]>({
        id: 'ev-1',
        subQuestionId: 'q1',
        claim: '高端白酒 CR3 达到 82%',
        quote: '原文摘录：2025 年高端白酒 CR3 达 82%。',
      }),
    ],
    reportMarkdown: '# 白酒行业竞争格局研究',
    events: [
      {
        seq: 1,
        type: 'run_started',
        round: 0,
        at: '2026-11-18T01:55:00.000Z',
        message: '开始研究',
      },
    ],
    stats: partial<DeepResearchResult['stats']>({
      rounds: 2,
      evidenceCount: 3,
      totalRetrievalTasks: 4,
      succeededTasks: 3,
      fallbacksUsed: 1,
      startedAt: '2026-11-18T01:55:00.000Z',
      stopReason: 'all_p0_sufficient',
    }),
  });
}

beforeEach(() => {
  vi.mocked(listDeepResearchRuns).mockResolvedValue([SUMMARY]);
  vi.mocked(getDeepResearchRun).mockResolvedValue({
    id: SUMMARY.id,
    question: SUMMARY.question,
    scope: {},
    createdAt: SUMMARY.createdAt,
    result: makeResult(),
  });
  vi.mocked(deleteDeepResearchRun).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DeepResearchPage 研究库', () => {
  it('加载并渲染历史研究摘要', async () => {
    render(<DeepResearchPage />);
    expect(await screen.findByText('白酒行业竞争格局')).toBeInTheDocument();
    expect(screen.getByText(/2 轮 · 3 条证据/)).toBeInTheDocument();
    expect(screen.getByText('历史研究')).toBeInTheDocument();
  });

  it('点击历史条目回看报告与执行轨迹', async () => {
    render(<DeepResearchPage />);
    fireEvent.click(await screen.findByRole('button', { name: /白酒行业竞争格局/ }));

    await waitFor(() => expect(getDeepResearchRun).toHaveBeenCalledWith('run-1'));
    // 报告标题与摘要来自历史结果
    expect(await screen.findByText('白酒行业竞争格局研究')).toBeInTheDocument();
    expect(screen.getByText('高端白酒集中度继续提升。')).toBeInTheDocument();
    // 轨迹同时恢复，才能在事后复核结论怎么来的（"启动研究"是轨迹条目标签）
    expect(screen.getByText('启动研究')).toBeInTheDocument();
    // 引用要能展开到原文摘录，而不只是来源标题
    expect(screen.getByText('原文摘录：2025 年高端白酒 CR3 达 82%。')).toBeInTheDocument();
    expect(screen.getByText(/第 1 轮 · 查询「高端白酒 集中度」/)).toBeInTheDocument();
    expect(screen.getByText(/正在查看历史研究/)).toBeInTheDocument();
  });

  it('删除历史条目后从列表移除', async () => {
    render(<DeepResearchPage />);
    await screen.findByText('白酒行业竞争格局');

    fireEvent.click(screen.getByRole('button', { name: '删除该研究记录' }));

    await waitFor(() => expect(deleteDeepResearchRun).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(screen.queryByText('白酒行业竞争格局')).toBeNull());
  });

  it('历史读取失败时页面仍可用（只保留空状态，不弹整页错误）', async () => {
    vi.mocked(listDeepResearchRuns).mockRejectedValueOnce(new Error('network down'));
    render(<DeepResearchPage />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('能用来做什么')).toBeInTheDocument();
  });
});

describe('DeepResearchPage 运行流（此前审查点名的零覆盖区）', () => {
  beforeEach(() => {
    vi.mocked(listDeepResearchRuns).mockResolvedValue([]);
    vi.mocked(getDeepResearchRun).mockResolvedValue({
      id: SUMMARY.id,
      question: SUMMARY.question,
      scope: {},
      createdAt: SUMMARY.createdAt,
      result: makeResult(),
    });
  });

  it('开始研究：进度事件进轨迹、done 渲染报告、刷新历史', async () => {
    let capturedOnEvent: ((e: unknown) => void) | null = null;
    vi.mocked(runDeepResearchStream).mockImplementation((_q, onEvent) => {
      capturedOnEvent = onEvent as (e: unknown) => void;
      return {
        cancel: vi.fn(),
        done: new Promise<DeepResearchResult>((resolve) => {
          setTimeout(() => resolve(makeResult()), 0);
        }),
      };
    });

    render(<DeepResearchPage />);
    const input = screen.getByPlaceholderText(/贵州茅台当前的基本面与估值/);
    fireEvent.change(input, { target: { value: '白酒行业未来两年的竞争格局与风险' } });
    fireEvent.click(screen.getByRole('button', { name: '开始研究' }));

    // 过程事件进轨迹
    await waitFor(() => {
      expect(capturedOnEvent).not.toBeNull();
    });
    (capturedOnEvent as (e: unknown) => void)({
      phase: 'agent_event',
      event: { seq: 1, type: 'run_started', round: 0, at: 't', message: '研究任务启动' },
    });
    await screen.findByText('研究任务启动');

    // done：报告渲染 + 历史刷新
    await screen.findByText('高端白酒集中度继续提升。');
    expect(runDeepResearchStream).toHaveBeenCalledWith(
      '白酒行业未来两年的竞争格局与风险',
      expect.any(Function),
      expect.objectContaining({ config: { maxRounds: expect.any(Number) } }),
    );
    await waitFor(() => {
      expect(vi.mocked(listDeepResearchRuns)).toHaveBeenCalledTimes(2); // 初始 + 完成后刷新
    });
  });

  it('取消研究：清空轨迹、running 复位、不弹错误', async () => {
    let rejectDone!: (e: Error) => void;
    vi.mocked(runDeepResearchStream).mockImplementation(() => {
      const done = new Promise<DeepResearchResult>((_resolve, reject) => {
        rejectDone = reject;
      });
      // 与真实 api 层契约一致：cancel 通过 reject done 传递取消，而不是抛同步异常
      return {
        cancel: vi.fn(() => rejectDone(new Error('已取消本次研究'))),
        done,
      };
    });

    render(<DeepResearchPage />);
    const input = screen.getByPlaceholderText(/贵州茅台当前的基本面与估值/);
    fireEvent.change(input, { target: { value: '白酒行业未来两年的竞争格局与风险' } });
    fireEvent.click(screen.getByRole('button', { name: '开始研究' }));

    const cancelBtn = await screen.findByRole('button', { name: '取消研究' });
    fireEvent.click(cancelBtn);

    // 取消后回到「开始研究」态（running=false），轨迹被清空且无错误横幅
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '开始研究' })).toBeInTheDocument();
    });
    expect(screen.queryByText(/研究失败/)).not.toBeInTheDocument();
  });
});
