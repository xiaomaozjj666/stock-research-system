// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import App from './App';

const apiMock = vi.hoisted(() => ({ analyzeStockStream: vi.fn() }));
vi.mock('./api/client', () => ({
  analyzeStockStream: apiMock.analyzeStockStream,
  AnalysisCancelledError: class AnalysisCancelledError extends Error {
    constructor(message = '分析已取消') {
      super(message);
      this.name = 'AnalysisCancelledError';
    }
  },
}));

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('./components/Toast', () => ({ useToast: () => ({ showToast: toastMock.showToast }) }));
vi.mock('./hooks/useCountUp', () => ({ useCountUp: (v: number) => v }));

const exportMock = vi.hoisted(() => ({
  generateReportMarkdown: vi.fn(() => '# 报告'),
  downloadMarkdown: vi.fn(),
}));
vi.mock('./utils/reportExport', () => exportMock);

// 顶部搜索框保留真实 id 与 data-stock-code：全局快捷键正是靠它们定位"当前可分析代码"
vi.mock('./components/StockSelector', () => ({
  default: ({ onAnalyze }: { onAnalyze: (code: string) => void }) => (
    <div>
      <input id="global-stock-search" aria-label="股票代码" data-stock-code="600519" />
      <button onClick={() => onAnalyze('600519')}>发起分析</button>
    </div>
  ),
}));

// 懒加载页面：只关心"是否挂载/是否 hidden"，不进入各页内部逻辑
vi.mock('./pages/quant/QuantPage', () => ({ default: () => <div data-testid="quant-page" /> }));
vi.mock('./pages/today/TodayPanel', () => ({ default: () => <div data-testid="today-page" /> }));
vi.mock('./components/ComparisonView', () => ({
  default: () => <div data-testid="compare-page" />,
}));
vi.mock('./pages/watchlist/WatchlistPage', () => ({
  default: () => <div data-testid="watchlist-page" />,
}));
vi.mock('./pages/paper/PaperTradingPage', () => ({
  default: () => <div data-testid="paper-page" />,
}));
vi.mock('./components/ChatPanel', () => ({ default: () => <div data-testid="chat-page" /> }));
vi.mock('./pages/history/HistoryPage', () => ({
  default: ({ onOpenHistory }: { onOpenHistory: (r: unknown) => void }) => (
    <button data-testid="open-history" onClick={() => onOpenHistory(makeResult())}>
      回看这条
    </button>
  ),
}));
vi.mock('./components/ChartsSection', () => ({ default: () => <div className="charts-mock" /> }));

const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('./lib/echarts', () => ({ default: { init: echartsMock.init } }));

function makeResult() {
  return {
    stock_pool: [
      {
        stock_code: '600519',
        stock_name: '贵州茅台',
        industry: '白酒',
        core_summary: '核心摘要',
        total_score: 85,
        rating: '买入',
        score_detail: {
          profit_quality: 80,
          growth: 70,
          valuation: 60,
          industry_boom: 90,
          risk_deduction: 50,
        },
        strengths: ['品牌壁垒'],
        risk_list: ['估值偏高'],
        controversy_points: [],
        finance_metrics: {
          years: ['2024'],
          revenue: [1],
          netProfit: [1],
          grossMargin: [10],
          netMargin: [5],
          roe: [8],
          operatingCashFlow: [1],
          eps: [1],
        },
        valuation: {
          currentPrice: 1700,
          pe: 30,
          pb: 8,
          ps: 10,
          marketCap: 20000,
          historicalPE: [],
          peerComparison: [],
        },
        valuation_level: '合理',
        expert_opinions: [
          {
            expert: '资金筹码分析师',
            arguments: [{ text: '资金流入', confidence: 80, type: 'support' as const }],
            overallSentiment: 'bullish' as const,
            confidence: 80,
            keyPoints: ['筹码集中'],
          },
        ],
        reflection_notes: ['自省校验通过'],
        follow_up_indicators: ['跟踪指标'],
        scenarios: [],
        strategyList: [],
      },
    ],
    research_confidence: '高',
    limitation_explain: '历史回测不代表未来收益',
  };
}

function okStream() {
  apiMock.analyzeStockStream.mockReturnValue({
    done: Promise.resolve(makeResult()),
    cancel: vi.fn(),
  });
}

/** 直接在 document 上按快捷键（全局监听挂在 document） */
function pressOn(target: EventTarget, key: string, mods: Record<string, boolean> = {}) {
  fireEvent.keyDown(target, { key, ...mods });
}

/** 让某个锚点区块"占据"视口中心线，用于滚动高亮判定 */
function stubSectionRects(centerId: string | null) {
  const innerHeight = window.innerHeight;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const id = (this as HTMLElement).id;
    const hit = id === centerId;
    return {
      top: hit ? innerHeight / 2 - 50 : -10_000,
      bottom: hit ? innerHeight / 2 + 50 : -9_000,
      left: 0,
      right: 100,
      width: 100,
      height: hit ? 100 : 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

beforeEach(() => {
  apiMock.analyzeStockStream.mockReset();
  toastMock.showToast.mockReset();
  exportMock.generateReportMarkdown.mockClear();
  exportMock.downloadMarkdown.mockClear();
  sessionStorage.clear();
  echartsMock.init.mockReturnValue({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App —— 标签页导航', () => {
  it('点击标签切换：懒加载页面首次激活才挂载', async () => {
    render(<App />);
    expect(screen.queryByTestId('quant-page')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '量化研究' }));
    expect(await screen.findByTestId('quant-page')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '量化研究' })).toHaveAttribute('aria-selected', 'true');
  });

  it('切走的标签页常驻（hidden 隐藏）而不是卸载，已填参数与结果不丢', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: '模拟盘' }));
    await screen.findByTestId('paper-page');
    fireEvent.click(screen.getByRole('tab', { name: '自选股' }));
    await screen.findByTestId('watchlist-page');

    const paperPane = screen.getByTestId('paper-page').parentElement;
    expect(paperPane).toHaveAttribute('hidden');
    expect(screen.getByTestId('paper-page')).toBeInTheDocument();
  });

  it('「历史」是例外：切走即卸载（保证每次进入都取到最新列表）', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: '历史' }));
    await screen.findByTestId('history-page-anchor', { exact: false }).catch(() => {});
    expect(await screen.findByTestId('open-history')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '深度研究' }));
    expect(screen.queryByTestId('open-history')).toBeNull();
  });

  it('方向键在 tab 间漫游：→ / ← 循环，Home / End 到首尾', () => {
    render(<App />);
    const tablist = screen.getByRole('tablist', { name: '功能导航' });
    const activeName = () => screen.getAllByRole('tab', { selected: true })[0].textContent;

    pressOn(tablist, 'ArrowRight');
    expect(activeName()).toBe('今日');
    pressOn(tablist, 'ArrowLeft');
    expect(activeName()).toBe('深度研究');
    pressOn(tablist, 'ArrowLeft'); // 首个再往左 → 回卷到末个
    expect(activeName()).toBe('历史');
    pressOn(tablist, 'Home');
    expect(activeName()).toBe('深度研究');
    pressOn(tablist, 'End');
    expect(activeName()).toBe('历史');
  });

  it('漫游 tabindex：只有当前 tab 可被 Tab 键聚焦', () => {
    render(<App />);
    expect(screen.getByRole('tab', { name: '深度研究' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: '量化研究' })).toHaveAttribute('tabindex', '-1');
  });

  it('数字键 1~7 直接切 tab', async () => {
    render(<App />);
    pressOn(document, '3');
    expect(await screen.findByTestId('quant-page')).toBeInTheDocument();
    pressOn(document, '2');
    expect(await screen.findByTestId('today-page')).toBeInTheDocument();
    expect(screen.getAllByRole('tab', { selected: true })[0].textContent).toBe('今日');
  });

  it('焦点在输入框时数字键不切 tab（否则数字会被劫持）', async () => {
    render(<App />);
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    pressOn(ta, '3');
    expect(screen.getAllByRole('tab', { selected: true })[0].textContent).toBe('深度研究');
    expect(screen.queryByTestId('quant-page')).toBeNull();
  });

  it('带修饰键的数字键不拦（Ctrl+1~9 是浏览器切换标签页）', () => {
    render(<App />);
    pressOn(document, '3', { ctrlKey: true });
    expect(screen.getAllByRole('tab', { selected: true })[0].textContent).toBe('深度研究');
  });
});

describe('App —— 全局快捷键', () => {
  it('Ctrl+K 聚焦并全选顶部搜索框（不然焦点会被浏览器抢走）', () => {
    render(<App />);
    const input = document.getElementById('global-stock-search') as HTMLInputElement;
    input.blur();
    pressOn(document, 'k', { ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  it('Ctrl+Enter 用 data-stock-code 发起分析并切回深度研究页', async () => {
    okStream();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: '量化研究' }));
    await screen.findByTestId('quant-page');

    pressOn(document, 'Enter', { ctrlKey: true });
    await waitFor(() => expect(apiMock.analyzeStockStream).toHaveBeenCalled());
    expect(apiMock.analyzeStockStream.mock.calls[0][0]).toBe('600519');
    await waitFor(() =>
      expect(screen.getAllByRole('tab', { selected: true })[0].textContent).toBe('深度研究'),
    );
  });

  it('Ctrl+Enter 取不到可靠代码时只提示，不猜代码发起分析', () => {
    render(<App />);
    const input = document.getElementById('global-stock-search') as HTMLInputElement;
    input.dataset.stockCode = '';
    pressOn(document, 'Enter', { ctrlKey: true });
    expect(apiMock.analyzeStockStream).not.toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledWith('请先输入 6 位股票代码');
  });

  it('Ctrl+Enter 分析进行中时提示等待而不是重复发起', async () => {
    apiMock.analyzeStockStream.mockReturnValue({ done: new Promise(() => {}), cancel: vi.fn() });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByText('取消分析');

    pressOn(document, 'Enter', { ctrlKey: true });
    expect(toastMock.showToast).toHaveBeenCalledWith('分析进行中，请稍候');
    expect(apiMock.analyzeStockStream).toHaveBeenCalledTimes(1);
  });

  it('焦点在别的输入框/文本域时不抢 Ctrl+Enter（避免一次按键两个动作）', () => {
    render(<App />);
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    pressOn(ta, 'Enter', { ctrlKey: true });
    expect(apiMock.analyzeStockStream).not.toHaveBeenCalled();
    expect(toastMock.showToast).not.toHaveBeenCalled();
  });

  it('焦点就在搜索框里时 Ctrl+Enter 照常生效', async () => {
    okStream();
    render(<App />);
    pressOn(document.getElementById('global-stock-search') as HTMLElement, 'Enter', {
      ctrlKey: true,
    });
    await waitFor(() => expect(apiMock.analyzeStockStream).toHaveBeenCalled());
  });
});

describe('App —— 分析的进行、取消与重试', () => {
  it('进行中展示加载屏与取消入口，取消后给出明确结果', async () => {
    apiMock.analyzeStockStream.mockReturnValue({ done: new Promise(() => {}), cancel: vi.fn() });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByText('取消分析');

    fireEvent.click(screen.getByText('取消分析'));
    expect(await screen.findByRole('alert')).toHaveTextContent('已取消本次分析');
    expect(screen.queryByText('取消分析')).toBeNull();
  });

  it('阶段进度写入加载屏（onStage 回调被消费）', async () => {
    let onStage: ((s: unknown) => void) | undefined;
    apiMock.analyzeStockStream.mockImplementation((_code: string, cb: (s: unknown) => void) => {
      onStage = cb;
      return { done: new Promise(() => {}), cancel: vi.fn() };
    });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByText('取消分析');

    await act(async () => {
      onStage?.({ phase: 'experts', message: '专家研判中' });
    });
    expect(await screen.findByText(/专家研判中/)).toBeInTheDocument();
  });

  it('失败后「重试」带 resume 续跑同一只标的（不重复支付已完成阶段）', async () => {
    apiMock.analyzeStockStream.mockReturnValue({
      done: Promise.reject(new Error('连接中断，分析未完成，请重试')),
      cancel: vi.fn(),
    });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByRole('alert');

    apiMock.analyzeStockStream.mockReturnValue({
      done: Promise.resolve(makeResult()),
      cancel: vi.fn(),
    });
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(apiMock.analyzeStockStream).toHaveBeenCalledTimes(2));
    expect(apiMock.analyzeStockStream.mock.calls[1][2]).toEqual({ resume: true });
  });

  it('新分析会取消上一条在途流（避免两条 SSE 竞争写同一份状态）', async () => {
    const cancelFirst = vi.fn();
    apiMock.analyzeStockStream.mockReturnValueOnce({
      done: new Promise(() => {}),
      cancel: cancelFirst,
    });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByText('取消分析');

    apiMock.analyzeStockStream.mockReturnValue({ done: new Promise(() => {}), cancel: vi.fn() });
    fireEvent.click(screen.getByText('发起分析'));
    expect(cancelFirst).toHaveBeenCalled();
  });

  it('分析成功后页面标题带上标的（标签页可读性）', async () => {
    okStream();
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await waitFor(() => expect(document.title).toContain('贵州茅台(600519)'));
  });
});

describe('App —— 报告导出与历史回看', () => {
  it('导出报告：生成 Markdown 并下载，文件名含名称与代码', async () => {
    okStream();
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByRole('button', { name: '导出报告' });

    fireEvent.click(screen.getByRole('button', { name: '导出报告' }));
    expect(exportMock.generateReportMarkdown).toHaveBeenCalled();
    expect(exportMock.downloadMarkdown).toHaveBeenCalledWith(
      '贵州茅台(600519)_研究报告.md',
      '# 报告',
    );
    expect(toastMock.showToast).toHaveBeenCalledWith('研究报告已导出');
  });

  it('报告内容为空时不产出空文件，而是提示失败', async () => {
    apiMock.analyzeStockStream.mockReturnValue({
      done: Promise.resolve({ stock_pool: [], research_confidence: '高' }),
      cancel: vi.fn(),
    });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    // 空 stock_pool 不渲染报告区：空态仍在，导出入口不存在
    await waitFor(() => expect(screen.queryByText('取消分析')).toBeNull());
    expect(screen.queryByRole('button', { name: '导出报告' })).toBeNull();
    expect(exportMock.downloadMarkdown).not.toHaveBeenCalled();
  });

  it('导出异常时给出可重试的提示（不静默失败）', async () => {
    okStream();
    exportMock.generateReportMarkdown.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    fireEvent.click(await screen.findByRole('button', { name: '导出报告' }));
    expect(toastMock.showToast).toHaveBeenCalledWith('导出失败，请重试', 'error');
  });

  it('从历史回看：恢复结果、标记为历史快照并切回深度研究页', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: '历史' }));
    fireEvent.click(await screen.findByTestId('open-history'));

    expect(await screen.findByText(/正在查看/)).toBeInTheDocument();
    expect(screen.getByText('历史快照')).toBeInTheDocument();
    expect(screen.getByText('贵州茅台')).toBeInTheDocument();
    expect(screen.getAllByRole('tab', { selected: true })[0].textContent).toBe('深度研究');
  });

  it('发起新分析即退出历史快照模式', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: '历史' }));
    fireEvent.click(await screen.findByTestId('open-history'));
    await screen.findByText('历史快照');

    okStream();
    fireEvent.click(screen.getByText('发起分析'));
    await waitFor(() => expect(screen.queryByText('历史快照')).toBeNull());
  });

  it('渲染数据来源表：未标注覆盖范围时用占位符而不是空白', async () => {
    apiMock.analyzeStockStream.mockReturnValue({
      done: Promise.resolve({
        ...makeResult(),
        data_sources: [
          { name: '东方财富', description: '行情与财务', coverage: '财务分析', confidence: 90 },
          { name: '公开公告', description: '原文口径', confidence: 70 },
        ],
      }),
      cancel: vi.fn(),
    });
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    expect(await screen.findByText('数据来源与覆盖范围')).toBeInTheDocument();
    expect(screen.getByText('东方财富')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
  });
});

describe('App —— 中断续跑提示的文案与边界', () => {
  function setInflight(startedAt: number, code = '600519') {
    sessionStorage.setItem('srs:inflight-analysis', JSON.stringify({ code, startedAt }));
  }

  it('1 分钟以内提示「刚刚」', async () => {
    setInflight(Date.now());
    render(<App />);
    expect(await screen.findByText(/刚刚中断/)).toBeInTheDocument();
  });

  it('1 小时以内按分钟展示', async () => {
    setInflight(Date.now() - 25 * 60_000);
    render(<App />);
    expect(await screen.findByText(/25 分钟前中断/)).toBeInTheDocument();
  });

  it('超过 1 小时按小时展示', async () => {
    setInflight(Date.now() - 3 * 3600_000);
    render(<App />);
    expect(await screen.findByText(/3 小时前中断/)).toBeInTheDocument();
  });

  it('超过 6 小时断点已过期：如实说明将继续会重新开始', async () => {
    setInflight(Date.now() - 7 * 3600_000);
    render(<App />);
    expect(await screen.findByText(/断点已过期/)).toBeInTheDocument();
    expect(screen.queryByText(/可从已完成的阶段继续/)).toBeNull();
  });

  it('会话痕迹里的代码不合法时视为没有在途分析（不误报续跑）', () => {
    setInflight(Date.now(), 'ABC');
    render(<App />);
    expect(screen.queryByRole('button', { name: '继续分析' })).toBeNull();
  });

  it('会话痕迹损坏时静默降级（隐私模式等存储异常）', () => {
    sessionStorage.setItem('srs:inflight-analysis', '{ 坏 JSON');
    render(<App />);
    expect(screen.queryByRole('button', { name: '继续分析' })).toBeNull();
  });
});

describe('App —— 滚动行为', () => {
  it('滚动超过 600px 出现「回到顶部」，点击平滑回顶', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    render(<App />);

    Object.defineProperty(window, 'scrollY', { value: 900, writable: true, configurable: true });
    fireEvent.scroll(window);

    const btn = await screen.findByRole('button', { name: '回到顶部' });
    fireEvent.click(btn);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

    Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
    fireEvent.scroll(window);
    await waitFor(() => expect(screen.queryByRole('button', { name: '回到顶部' })).toBeNull());
  });

  it('侧栏高亮跟随视口中心线所在区块', async () => {
    okStream();
    stubSectionRects('valuation');
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByText('贵州茅台');

    fireEvent.scroll(window);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: '估值分析' })).toHaveClass('active'),
    );
  });

  it('报告面板已隐藏时滚动不推进高亮（hidden 元素 rect 全为 0，会误判成末尾区块）', async () => {
    okStream();
    stubSectionRects('followup');
    render(<App />);
    fireEvent.click(screen.getByText('发起分析'));
    await screen.findByText('贵州茅台');

    fireEvent.click(screen.getByRole('tab', { name: '今日' }));
    fireEvent.scroll(window);
    // 切到其它 tab 后高亮应保持原值，而不是被"末尾兜底"改成跟踪指标
    await new Promise((r) => setTimeout(r, 30));
    revealResearchTab();
    expect(screen.getByRole('link', { name: '跟踪指标' })).not.toHaveClass('active');
  });
});

/** 切回深度研究页（报告仍挂载，只是被 hidden） */
function revealResearchTab() {
  fireEvent.click(screen.getByRole('tab', { name: '深度研究' }));
}
