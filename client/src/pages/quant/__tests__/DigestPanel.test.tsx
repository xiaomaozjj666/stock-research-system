// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/Toast';
import DigestPanel from '../DigestPanel';
import type { ResearchDigest } from '../../../api/client';

const api = vi.hoisted(() => ({
  getResearchDigests: vi.fn(),
  runResearchDigestNow: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  getResearchDigests: api.getResearchDigests,
  runResearchDigestNow: api.runResearchDigestNow,
}));

/**
 * 用「本地时间」构造快照时间，再以 ISO 喂给组件：
 * 组件按本地时区格式化，这样断言在任何时区下都成立。
 */
const LOCAL_AT = new Date(2026, 8, 15, 10, 30);
const LOCAL_AT_TEXT = '2026-09-15 10:30';

function digest(over: Partial<ResearchDigest> = {}): ResearchDigest {
  return {
    id: 'd1',
    createdAt: LOCAL_AT.toISOString(),
    screener: {
      at: LOCAL_AT.toISOString(),
      scanned: 320,
      eligible: 180,
      hitCount: 2,
      topHits: [
        { code: '600519', name: '贵州茅台', strategy: '放量突破', detail: '量比 3.2' },
        { code: '000858', name: '五粮液', strategy: '均线多头', detail: '站上年线' },
      ],
    },
    ledger: {
      total: 12,
      kept: 3,
      keptExpectedFalse: 0.15,
      keptOosShare: 0.67,
      bySource: { expression: 12 },
    },
    notes: ['初筛命中 2 只，其中 1 只与既有台账重合', '台账新增 0 条'],
    ...over,
  };
}

function renderPanel() {
  return render(
    <ToastProvider>
      <DigestPanel />
    </ToastProvider>,
  );
}

const generateButton = () => screen.getByRole('button', { name: /生成一份|生成中…/ });

/** 取匹配元素合并后的可见文本（跨 text 节点，忽略子元素边界） */
function textOf(re: RegExp): string {
  return (screen.getByText(re).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 代表性命中行的完整文本（代码在 <span> 里，需从 <li> 整体取） */
function hitLine(re: RegExp): string {
  return (screen.getByText(re).closest('li')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 展开第一条简报（表头按钮） */
function expandFirst() {
  fireEvent.click(screen.getByRole('button', { name: /初筛/ }));
}

describe('DigestPanel —— 加载、空态与失败', () => {
  beforeEach(() => {
    api.getResearchDigests.mockReset();
    api.runResearchDigestNow.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('首次加载：读取未返回时显示「加载中…」而不是空态或空白', async () => {
    api.getResearchDigests.mockReturnValue(new Promise(() => {}));
    renderPanel();

    await waitFor(() => expect(api.getResearchDigests).toHaveBeenCalledWith(10));
    expect(screen.getByText('加载中…')).toBeInTheDocument();
    expect(screen.queryByText(/还没有简报/)).toBeNull();
    expect(generateButton()).toBeEnabled();
  });

  it('从未生成过简报时显示引导而不是空白', async () => {
    api.getResearchDigests.mockResolvedValue({ items: [] });
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText('还没有简报：点「生成一份」创建第一份')).toBeInTheDocument(),
    );
    expect(screen.queryByText('加载中…')).toBeNull();
    // 空态下「生成一份」仍是唯一出口，且可点
    expect(generateButton()).toBeEnabled();
  });

  it('读取失败时显示错误文案，不再停留在「加载中…」', async () => {
    api.getResearchDigests.mockRejectedValue(new Error('研究简报读取失败：上游超时'));
    renderPanel();

    await waitFor(() => expect(screen.getByText('研究简报读取失败：上游超时')).toBeInTheDocument());
    expect(screen.queryByText('加载中…')).toBeNull();
    expect(screen.queryByText(/还没有简报/)).toBeNull();
  });

  it('非 Error 读取失败时用兜底文案', async () => {
    api.getResearchDigests.mockRejectedValue('boom');
    renderPanel();

    await waitFor(() => expect(screen.getByText('研究简报读取失败')).toBeInTheDocument());
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});

describe('DigestPanel —— 条目与展开细节', () => {
  beforeEach(() => {
    api.getResearchDigests.mockReset();
    api.runResearchDigestNow.mockReset();
    api.getResearchDigests.mockResolvedValue({ items: [digest()] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('折叠态：显示生成时间与「初筛 命中 N · 台账 X 条（采信 Y）」，结论默认不展开', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByText(LOCAL_AT_TEXT)).toBeInTheDocument());
    expect(screen.getByText(/初筛 命中 2 · 台账 12 条（采信 3）/)).toBeInTheDocument();
    expect(screen.getByText('▸')).toBeInTheDocument();
    expect(screen.queryByText('初筛命中 2 只，其中 1 只与既有台账重合')).toBeNull();
  });

  it('展开：显示结论 notes 与初筛代表性命中；再点收起', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(LOCAL_AT_TEXT)).toBeInTheDocument());

    expandFirst();

    expect(screen.getByText('初筛命中 2 只，其中 1 只与既有台账重合')).toBeInTheDocument();
    expect(screen.getByText('台账新增 0 条')).toBeInTheDocument();
    expect(screen.getByText('▾')).toBeInTheDocument();

    const screener = textOf(/扫描/);
    expect(screener).toContain(`初筛（${LOCAL_AT_TEXT}）`);
    expect(screener).toContain('扫描 320 只 / 合格 180 只 / 命中 2 条，代表性命中：');
    // 命中行 = 代码 + 名称 + 策略 + 细节（代码在子元素里，故按 <li> 整体取文本）
    expect(hitLine(/量比 3\.2/)).toBe('600519 贵州茅台 · 放量突破 · 量比 3.2');
    expect(hitLine(/站上年线/)).toBe('000858 五粮液 · 均线多头 · 站上年线');

    fireEvent.click(screen.getByRole('button', { name: /初筛/ }));
    expect(screen.queryByText('初筛命中 2 只，其中 1 只与既有台账重合')).toBeNull();
    expect(screen.getByText('▸')).toBeInTheDocument();
  });

  it('从未跑过初筛（at 为空）时表头写「无记录」，展开也不给初筛明细', async () => {
    api.getResearchDigests.mockResolvedValue({
      items: [
        digest({
          screener: { at: null, scanned: null, eligible: null, hitCount: null, topHits: [] },
        }),
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(LOCAL_AT_TEXT)).toBeInTheDocument());

    expect(screen.getByText(/初筛 无记录 · 台账 12 条（采信 3）/)).toBeInTheDocument();

    expandFirst();
    expect(screen.getByText('初筛命中 2 只，其中 1 只与既有台账重合')).toBeInTheDocument();
    expect(screen.queryByText(/扫描/)).toBeNull();
    expect(screen.queryByText(/代表性命中/)).toBeNull();
  });

  it('可选字段缺失：命中数按 0 计，扫描/合格数按破折号展示', async () => {
    api.getResearchDigests.mockResolvedValue({
      items: [
        digest({
          screener: {
            at: LOCAL_AT.toISOString(),
            scanned: null,
            eligible: null,
            hitCount: null,
            topHits: [
              { code: '600519', name: '贵州茅台', strategy: '放量突破', detail: '量比 3.2' },
            ],
          },
        }),
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/初筛 命中 0 · 台账 12 条/)).toBeInTheDocument());

    expandFirst();
    expect(textOf(/扫描/)).toContain('扫描 — 只 / 合格 — 只 / 命中 0 条，代表性命中：');
  });

  it('初筛有记录但没有代表性命中时不渲染明细块（只有结论）', async () => {
    api.getResearchDigests.mockResolvedValue({
      items: [
        digest({
          screener: {
            at: LOCAL_AT.toISOString(),
            scanned: 320,
            eligible: 180,
            hitCount: 0,
            topHits: [],
          },
        }),
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/初筛 命中 0 · 台账 12 条/)).toBeInTheDocument());

    expandFirst();
    expect(screen.getByText('台账新增 0 条')).toBeInTheDocument();
    expect(screen.queryByText(/扫描/)).toBeNull();
  });

  it('多份简报各自独立展开，互不影响', async () => {
    api.getResearchDigests.mockResolvedValue({
      items: [
        digest(),
        digest({
          id: 'd2',
          createdAt: new Date(2026, 8, 14, 9, 0).toISOString(),
          notes: ['上一份的结论'],
          screener: { at: null, scanned: null, eligible: null, hitCount: null, topHits: [] },
        }),
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('2026-09-14 09:00')).toBeInTheDocument());

    const heads = screen.getAllByRole('button', { name: /初筛/ });
    expect(heads).toHaveLength(2);
    fireEvent.click(heads[1]);

    expect(screen.getByText('上一份的结论')).toBeInTheDocument();
    expect(screen.queryByText('初筛命中 2 只，其中 1 只与既有台账重合')).toBeNull();
    expect(screen.getAllByText('▸')).toHaveLength(1);
  });
});

describe('DigestPanel —— 手动生成', () => {
  beforeEach(() => {
    api.getResearchDigests.mockReset();
    api.runResearchDigestNow.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('空态下点「生成一份」：调用生成接口、弹成功提示并回读列表', async () => {
    api.getResearchDigests
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [digest()] });
    api.runResearchDigestNow.mockResolvedValue(digest());
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText('还没有简报：点「生成一份」创建第一份')).toBeInTheDocument(),
    );

    fireEvent.click(generateButton());

    await waitFor(() => expect(screen.getByText(/研究简报已生成/)).toBeInTheDocument());
    expect(api.runResearchDigestNow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(LOCAL_AT_TEXT)).toBeInTheDocument());
    expect(api.getResearchDigests).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/还没有简报/)).toBeNull();
  });

  it('生成中：按钮禁用并显示「生成中…」', async () => {
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.runResearchDigestNow.mockReturnValue(new Promise(() => {}));
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText('还没有简报：点「生成一份」创建第一份')).toBeInTheDocument(),
    );

    fireEvent.click(generateButton());

    expect(screen.getByRole('button', { name: '生成中…' })).toBeDisabled();
  });

  it('非 Error 生成失败时用兜底文案', async () => {
    api.getResearchDigests.mockResolvedValue({ items: [] });
    api.runResearchDigestNow.mockRejectedValue('boom');
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText('还没有简报：点「生成一份」创建第一份')).toBeInTheDocument(),
    );

    fireEvent.click(generateButton());

    await waitFor(() => expect(screen.getByText(/生成失败/)).toBeInTheDocument());
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(generateButton()).toBeEnabled();
  });

  it('生成失败：以错误提示呈现后端消息，按钮恢复可点且列表不受影响', async () => {
    api.getResearchDigests.mockResolvedValue({ items: [digest()] });
    api.runResearchDigestNow.mockRejectedValue(new Error('研究简报生成失败：LLM 未配置'));
    renderPanel();
    await waitFor(() => expect(screen.getByText(LOCAL_AT_TEXT)).toBeInTheDocument());

    fireEvent.click(generateButton());

    await waitFor(() =>
      expect(screen.getByText(/研究简报生成失败：LLM 未配置/)).toBeInTheDocument(),
    );
    expect(generateButton()).toBeEnabled();
    expect(screen.getByText(LOCAL_AT_TEXT)).toBeInTheDocument();
    // 生成失败只走轻提示，不把已有列表替换成错误页
    expect(screen.queryByText('加载中…')).toBeNull();
  });

  it('手动生成成功后列表刷新为最新一份（新条目排在最前）', async () => {
    const older = digest({
      id: 'd0',
      createdAt: new Date(2026, 8, 10, 8, 0).toISOString(),
      notes: ['旧结论'],
    });
    api.getResearchDigests
      .mockResolvedValueOnce({ items: [older] })
      .mockResolvedValue({ items: [digest(), older] });
    api.runResearchDigestNow.mockResolvedValue(digest());
    renderPanel();
    await waitFor(() => expect(screen.getByText('2026-09-10 08:00')).toBeInTheDocument());

    fireEvent.click(generateButton());

    await waitFor(() => expect(screen.getByText(LOCAL_AT_TEXT)).toBeInTheDocument());
    const heads = screen.getAllByRole('button', { name: /初筛/ });
    expect(heads[0]).toHaveTextContent(LOCAL_AT_TEXT);
  });
});
