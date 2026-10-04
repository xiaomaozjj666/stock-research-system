// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import App from './App';

/**
 * 标签页 ↔ location.hash 双向同步（深链 + 浏览器前进/后退）。
 * 用例只断言"哪个标签页被选中"和"URL 变成什么"，不碰任何页面的内部实现。
 */

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

vi.mock('./components/StockSelector', () => ({
  default: ({ onAnalyze }: { onAnalyze: (code: string) => void }) => (
    <div>
      <input id="global-stock-search" aria-label="股票代码" data-stock-code="600519" />
      <button onClick={() => onAnalyze('600519')}>发起分析</button>
    </div>
  ),
}));

// 懒加载页面：只关心"是否挂载"，不进入各页内部逻辑
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
  default: () => <div data-testid="history-page" />,
}));
vi.mock('./components/ChartsSection', () => ({ default: () => <div className="charts-mock" /> }));

const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('./lib/echarts', () => ({ default: { init: echartsMock.init } }));

/** 跳到某个 hash 并派发 hashchange，模拟浏览器前进/后退真正发生的事 */
function gotoHash(hash: string) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** 当前选中的标签页文案（tablist 里 aria-selected=true 的那个） */
function selectedTab(): string {
  return screen.getAllByRole('tab', { selected: true })[0].textContent ?? '';
}

beforeEach(() => {
  apiMock.analyzeStockStream.mockReset();
  toastMock.showToast.mockReset();
  echartsMock.init.mockReturnValue({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() });
  sessionStorage.clear();
  // 从"无 hash"的干净 URL 起步（setup.ts 也会在每个用例后复位，这里是双保险）
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App —— 标签页深链（location.hash）', () => {
  it('带 hash 进入：直接落在对应标签页，对应面板已挂载', async () => {
    window.history.replaceState(null, '', '#quant');
    render(<App />);

    expect(selectedTab()).toBe('量化研究');
    // 懒加载面板应随之挂载 —— 分享出去的链接必须是"打开就看到东西"
    expect(await screen.findByTestId('quant-page')).toBeInTheDocument();
  });

  it('点击标签页：地址栏 hash 同步更新，可直接复制分享', async () => {
    render(<App />);
    expect(window.location.hash).not.toBe('#watchlist');

    fireEvent.click(screen.getByRole('tab', { name: '自选股' }));

    await screen.findByTestId('watchlist-page');
    expect(window.location.hash).toBe('#watchlist');
  });

  it('无法识别的 hash：回落到默认的深度研究页，而不是渲染空白', async () => {
    // 旧版本/手改的链接都可能带上已下线的标签页 id
    window.history.replaceState(null, '', '#not-a-real-tab');
    render(<App />);

    expect(selectedTab()).toBe('深度研究');
    expect(await screen.findByRole('button', { name: '发起分析' })).toBeInTheDocument();
  });

  it('hash 前进/后退：标签页跟着地址栏走', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: '模拟盘' }));
    await screen.findByTestId('paper-page');
    fireEvent.click(screen.getByRole('tab', { name: '自选股' }));
    await screen.findByTestId('watchlist-page');

    // 后退到模拟盘
    act(() => gotoHash('#paper'));
    await waitFor(() => expect(selectedTab()).toBe('模拟盘'));
    // 再后退到量化页
    act(() => gotoHash('#quant'));
    await waitFor(() => expect(selectedTab()).toBe('量化研究'));
  });

  it('后退到空 hash：回落到默认页，且不会把空 hash 又写回去卡住后退键', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: '自选股' }));
    await screen.findByTestId('watchlist-page');

    act(() => gotoHash(''));
    await waitFor(() => expect(selectedTab()).toBe('深度研究'));
    // 关键：后退后 URL 仍为空。若这里被补写成 #research，
    // 就等于把刚退掉的历史又塞回栈里，用户会以为后退键失灵
    expect(window.location.hash).toBe('');
  });
});
