// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ResearchEnhance from '../ResearchEnhance';

const apiMocks = vi.hoisted(() => ({
  ingestDocument: vi.fn(),
  listDocuments: vi.fn(),
  getModels: vi.fn(),
  getCostReport: vi.fn(),
  resetCostReport: vi.fn(),
  clearChatHistory: vi.fn(),
  startAutonomous: vi.fn(),
  stopAutonomous: vi.fn(),
  getAutonomousStatus: vi.fn(),
}));

vi.mock('../../api/client', () => apiMocks);

const MODELS = {
  available: true,
  embeddingEnabled: true,
  registry: [],
  routing: { chat: 'qwen-max', summary: 'qwen-turbo' },
};
const COST = {
  totalCost: 0.1234,
  totalPromptTokens: 1200,
  totalCompletionTokens: 800,
  callCount: 7,
  byModel: {},
};
const DOCS = {
  count: 1,
  docs: [{ id: 'd1', source: '研报.pdf', preview: '公司毛利率同比提升…' }],
};

/** 文件上传时避免依赖 jsdom 的 Blob.arrayBuffer 实现差异 */
function makePdf(name: string, bytes: Uint8Array) {
  const file = new File(['placeholder'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return file;
}

function fileInputOf(container: HTMLElement) {
  const el = container.querySelector('input[type="file"]');
  if (!el) throw new Error('未找到 PDF 上传输入框');
  return el as HTMLInputElement;
}

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockReset();
  apiMocks.listDocuments.mockResolvedValue(DOCS);
  apiMocks.getModels.mockResolvedValue(MODELS);
  apiMocks.getCostReport.mockResolvedValue(COST);
  apiMocks.getAutonomousStatus.mockResolvedValue({ running: false });
  apiMocks.ingestDocument.mockResolvedValue({ id: 'x', title: 't', ingested: true });
  apiMocks.clearChatHistory.mockResolvedValue({ ok: true });
  apiMocks.startAutonomous.mockResolvedValue({ running: true, started: true });
  apiMocks.stopAutonomous.mockResolvedValue({ stopped: true, lastAlerts: [] });
  apiMocks.resetCostReport.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResearchEnhance —— 挂载时的并行拉取', () => {
  it('同时拉取资料库 / 模型 / 成本 / 监控状态并渲染结果', async () => {
    render(<ResearchEnhance sessionId="s1" />);
    expect(await screen.findByText('研报.pdf')).toBeInTheDocument();
    expect(screen.getByText('公司毛利率同比提升…')).toBeInTheDocument();
    expect(screen.getByText('是')).toBeInTheDocument();
    expect(screen.getByText('向量模式')).toBeInTheDocument();
    expect(screen.getByText('chat:qwen-max')).toBeInTheDocument();
    expect(screen.getByText('7 次')).toBeInTheDocument();
    expect(screen.getByText('1200 / 800')).toBeInTheDocument();
    expect(screen.getByText('$0.1234')).toBeInTheDocument();
    // 币种必须写明：裸 $ 无法判断是 USD 还是折算后的人民币
    expect(screen.getByText('估算成本（USD，按计价汇率折算）')).toBeInTheDocument();
  });

  it('某一路失败不影响其余三路渲染（allSettled 降级）', async () => {
    apiMocks.getCostReport.mockRejectedValue(new Error('down'));
    render(<ResearchEnhance sessionId="s1" />);
    expect(await screen.findByText('研报.pdf')).toBeInTheDocument();
    expect(screen.getByText('chat:qwen-max')).toBeInTheDocument();
    // 成本区块整体不渲染，而不是渲染出 0 / NaN
    expect(screen.queryByText('累计调用')).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('LLM 不可用时如实标注"否（规则降级）"，语义检索降级为 BM25', async () => {
    apiMocks.getModels.mockResolvedValue({
      ...MODELS,
      available: false,
      embeddingEnabled: false,
    });
    render(<ResearchEnhance sessionId="s1" />);
    expect(await screen.findByText('否（规则降级）')).toBeInTheDocument();
    expect(screen.getByText('BM25 模式')).toBeInTheDocument();
  });

  it('资料库为空时给出空态文案（而不是一片空白）', async () => {
    apiMocks.listDocuments.mockResolvedValue({ count: 0, docs: [] });
    render(<ResearchEnhance sessionId="s1" />);
    expect(await screen.findByText('暂无已入库文档')).toBeInTheDocument();
  });
});

describe('ResearchEnhance —— 文档入库', () => {
  it('标题或内容缺失时拦截并提示，不发请求', async () => {
    render(<ResearchEnhance sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: '入库文本' }));
    expect(await screen.findByText('请填写标题与内容')).toBeInTheDocument();
    expect(apiMocks.ingestDocument).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('文档标题（必填）'), {
      target: { value: '   ' },
    });
    fireEvent.change(screen.getByPlaceholderText(/粘贴文本/), { target: { value: '正文' } });
    fireEvent.click(screen.getByRole('button', { name: '入库文本' }));
    expect(apiMocks.ingestDocument).not.toHaveBeenCalled();
  });

  it('入库成功后清空表单、提示成功并刷新资料库', async () => {
    render(<ResearchEnhance sessionId="s1" />);
    const title = screen.getByPlaceholderText('文档标题（必填）');
    const text = screen.getByPlaceholderText(/粘贴文本/);
    fireEvent.change(title, { target: { value: ' 半年报 ' } });
    fireEvent.change(text, { target: { value: ' 净利润同比增长 ' } });
    const callsBefore = apiMocks.listDocuments.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '入库文本' }));

    await waitFor(() =>
      expect(apiMocks.ingestDocument).toHaveBeenCalledWith({
        title: '半年报',
        text: '净利润同比增长',
      }),
    );
    expect(await screen.findByText('文档已入库，将参与后续对话的证据检索')).toBeInTheDocument();
    expect(title).toHaveValue('');
    expect(text).toHaveValue('');
    await waitFor(() =>
      expect(apiMocks.listDocuments.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('入库失败时把服务端文案原样展示（便于用户改内容重试）', async () => {
    apiMocks.ingestDocument.mockRejectedValue(new Error('文本过长，请分批入库'));
    render(<ResearchEnhance sessionId="s1" />);
    fireEvent.change(screen.getByPlaceholderText('文档标题（必填）'), {
      target: { value: '标题' },
    });
    fireEvent.change(screen.getByPlaceholderText(/粘贴文本/), { target: { value: '正文' } });
    fireEvent.click(screen.getByRole('button', { name: '入库文本' }));
    expect(await screen.findByText('文本过长，请分批入库')).toBeInTheDocument();
  });
});

describe('ResearchEnhance —— PDF 上传', () => {
  it('未填标题时用文件名（去掉 .pdf）作为标题，并转 base64 上传', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 fake');
    const { container } = render(<ResearchEnhance sessionId="s1" />);
    fireEvent.change(fileInputOf(container), {
      target: { files: [makePdf('2026半年报.pdf', bytes)] },
    });

    await waitFor(() =>
      expect(apiMocks.ingestDocument).toHaveBeenCalledWith({
        title: '2026半年报',
        pdfBase64: Buffer.from(bytes).toString('base64'),
      }),
    );
    expect(await screen.findByText('PDF 已解析并入库')).toBeInTheDocument();
  });

  it('已填标题时以标题为准（不覆盖用户输入）', async () => {
    const { container } = render(<ResearchEnhance sessionId="s1" />);
    fireEvent.change(screen.getByPlaceholderText('文档标题（必填）'), {
      target: { value: '自定义标题' },
    });
    fireEvent.change(fileInputOf(container), {
      target: { files: [makePdf('raw.pdf', new TextEncoder().encode('x'))] },
    });
    await waitFor(() =>
      expect(apiMocks.ingestDocument).toHaveBeenCalledWith(
        expect.objectContaining({ title: '自定义标题' }),
      ),
    );
  });

  it('超过 32KB 的 PDF 分块编码后仍是正确的 base64（不丢字节、不爆栈）', async () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const { container } = render(<ResearchEnhance sessionId="s1" />);
    fireEvent.change(fileInputOf(container), {
      target: { files: [makePdf('big.pdf', bytes)] },
    });

    await waitFor(() => expect(apiMocks.ingestDocument).toHaveBeenCalled());
    const payload = apiMocks.ingestDocument.mock.calls[0][0] as { pdfBase64: string };
    expect(payload.pdfBase64).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('PDF 解析失败时给出可读提示', async () => {
    apiMocks.ingestDocument.mockRejectedValue(new Error('PDF 解析失败'));
    const { container } = render(<ResearchEnhance sessionId="s1" />);
    fireEvent.change(fileInputOf(container), {
      target: { files: [makePdf('broken.pdf', new TextEncoder().encode('x'))] },
    });
    expect(await screen.findByText('PDF 解析失败')).toBeInTheDocument();
  });
});

describe('ResearchEnhance —— 消耗与记忆', () => {
  it('重置成本统计后提示成功并刷新', async () => {
    render(<ResearchEnhance sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: '重置成本统计' }));
    expect(await screen.findByText('成本统计已重置')).toBeInTheDocument();
    expect(apiMocks.resetCostReport).toHaveBeenCalledTimes(1);
    expect(apiMocks.getCostReport.mock.calls.length).toBeGreaterThan(1);
  });

  it('清空记忆按当前会话 ID 调用，并提示成功', async () => {
    render(<ResearchEnhance sessionId="session-42" />);
    fireEvent.click(screen.getByRole('button', { name: '清空记忆' }));
    await waitFor(() => expect(apiMocks.clearChatHistory).toHaveBeenCalledWith('session-42'));
    expect(await screen.findByText('对话记忆已清空')).toBeInTheDocument();
  });

  it('会话 ID 为空时禁用清空记忆（避免清错会话）', () => {
    render(<ResearchEnhance sessionId="" />);
    expect(screen.getByRole('button', { name: '清空记忆' })).toBeDisabled();
  });

  it('清空记忆失败时展示错误', async () => {
    apiMocks.clearChatHistory.mockRejectedValue(new Error('会话不存在'));
    render(<ResearchEnhance sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: '清空记忆' }));
    expect(await screen.findByText('会话不存在')).toBeInTheDocument();
  });
});

describe('ResearchEnhance —— 自动监控', () => {
  it('未运行时按钮是"启动监控"，点击以 10 分钟间隔启动', async () => {
    render(<ResearchEnhance sessionId="s1" />);
    const btn = await screen.findByRole('button', { name: '启动监控' });
    fireEvent.click(btn);
    await waitFor(() => expect(apiMocks.startAutonomous).toHaveBeenCalledWith(600_000));
    expect(
      await screen.findByText('已启动自动监控（每 10 分钟巡检自选股异动）'),
    ).toBeInTheDocument();
  });

  it('运行中展示巡检轮数 / 异动条数 / 失败次数，按钮变为"停止监控"', async () => {
    apiMocks.getAutonomousStatus.mockResolvedValue({
      running: true,
      runCount: 12,
      lastAlertCount: 3,
      errorCount: 2,
    });
    render(<ResearchEnhance sessionId="s1" />);
    expect(await screen.findByText('已运行 12 轮')).toBeInTheDocument();
    expect(screen.getByText('最近异动 3 条')).toBeInTheDocument();
    expect(screen.getByText('失败 2 次')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '停止监控' }));
    await waitFor(() => expect(apiMocks.stopAutonomous).toHaveBeenCalled());
    expect(await screen.findByText('已停止自动监控')).toBeInTheDocument();
  });

  it('无失败时不渲染"失败 0 次"（避免正常状态看起来像有问题）', async () => {
    apiMocks.getAutonomousStatus.mockResolvedValue({ running: true, runCount: 1, errorCount: 0 });
    render(<ResearchEnhance sessionId="s1" />);
    await screen.findByText('已运行 1 轮');
    expect(screen.queryByText(/失败 0 次/)).toBeNull();
  });

  it('运行中但缺少统计字段时以 0 兜底（不显示 undefined）', async () => {
    apiMocks.getAutonomousStatus.mockResolvedValue({ running: true });
    render(<ResearchEnhance sessionId="s1" />);
    expect(await screen.findByText('已运行 0 轮')).toBeInTheDocument();
    expect(screen.getByText('最近异动 0 条')).toBeInTheDocument();
  });

  it('启停失败时展示错误文案', async () => {
    apiMocks.startAutonomous.mockRejectedValue(new Error('监控已在运行'));
    render(<ResearchEnhance sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: '启动监控' }));
    expect(await screen.findByText('监控已在运行')).toBeInTheDocument();
  });
});
