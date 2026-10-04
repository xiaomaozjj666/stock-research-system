// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

/**
 * 标签页面板的「常驻挂载白名单」行为。
 *
 * 白名单（compare / paper / chat）保存的是用户付出过、且服务端取不回来的本地状态，
 * 因此切走只能 hidden 隐藏、绝不能卸载；白名单之外的页签切走即卸载，
 * 避免"访问过的页签全都永久留在渲染树里"。
 *
 * 用例一律断言可见文本 / role / label 与输入框的取值，不碰 class 与 DOM 结构。
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

vi.mock('./utils/reportExport', () => ({
  generateReportMarkdown: vi.fn(() => '# 报告'),
  downloadMarkdown: vi.fn(),
}));

// 顶部搜索框保留真实 id 与 data-stock-code：全局快捷键靠它们定位"当前可分析代码"
vi.mock('./components/StockSelector', () => ({
  default: ({ onAnalyze }: { onAnalyze: (code: string) => void }) => (
    <div>
      <input id="global-stock-search" aria-label="股票代码" data-stock-code="600519" />
      <button onClick={() => onAnalyze('600519')}>发起分析</button>
    </div>
  ),
}));

// 白名单页签的替身带**真实的组件内状态**，才能验证"切回来状态还在"，
// 而不只是"节点还在"——只断言存在的话，卸载后重新挂载也能蒙混过关。
vi.mock('./pages/paper/PaperTradingPage', async () => {
  const { useState } = await import('react');
  // 组件名必须大写开头：oxlint 的 react-hooks/rules-of-hooks 会把
  // 匿名函数里的 useState 判成非法 Hook 调用
  function MockPaperTradingPage() {
    const [price, setPrice] = useState('');
    return (
      <div>
        <label htmlFor="mock-order-price">委托价</label>
        <input id="mock-order-price" value={price} onChange={(e) => setPrice(e.target.value)} />
      </div>
    );
  }
  return { default: MockPaperTradingPage };
});

vi.mock('./components/ComparisonView', async () => {
  const { useState } = await import('react');
  function MockComparisonView() {
    const [picked, setPicked] = useState('');
    return (
      <div>
        <label htmlFor="mock-compare-pick">对比标的</label>
        <input id="mock-compare-pick" value={picked} onChange={(e) => setPicked(e.target.value)} />
      </div>
    );
  }
  return { default: MockComparisonView };
});

vi.mock('./components/ChatPanel', async () => {
  const { useState } = await import('react');
  function MockChatPanel() {
    const [draft, setDraft] = useState('');
    return (
      <div>
        <label htmlFor="mock-chat-draft">向研究助手提问</label>
        <textarea id="mock-chat-draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
    );
  }
  return { default: MockChatPanel };
});

// 白名单之外的页签：只关心"还在不在树上"
vi.mock('./pages/quant/QuantPage', () => ({ default: () => <div>量化页内容</div> }));
vi.mock('./pages/today/TodayPanel', () => ({ default: () => <div>今日页内容</div> }));
vi.mock('./pages/watchlist/WatchlistPage', () => ({ default: () => <div>自选股页内容</div> }));
vi.mock('./pages/history/HistoryPage', () => ({ default: () => <div>历史页内容</div> }));
vi.mock('./components/ChartsSection', () => ({ default: () => <div className="charts-mock" /> }));

const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('./lib/echarts', () => ({ default: { init: echartsMock.init } }));

/** 切到某个标签页并等它的懒加载面板挂载完成 */
async function switchTo(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  apiMock.analyzeStockStream.mockReset();
  toastMock.showToast.mockReset();
  sessionStorage.clear();
  echartsMock.init.mockReturnValue({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() });
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App —— 白名单页签切走不卸载（本地状态不丢）', () => {
  it('模拟盘：已填的委托价在切走再切回后仍在', async () => {
    render(<App />);
    await switchTo('模拟盘');
    const price = await screen.findByLabelText('委托价');
    fireEvent.change(price, { target: { value: '1688.50' } });

    await switchTo('深度研究');
    await switchTo('模拟盘');

    // 关键断言：值还在 = 组件没被卸载重建，否则会是空串
    expect(await screen.findByLabelText('委托价')).toHaveValue('1688.50');
  });

  it('对比分析：已选对比标的在切走再切回后仍在', async () => {
    render(<App />);
    await switchTo('对比分析');
    const picked = await screen.findByLabelText('对比标的');
    fireEvent.change(picked, { target: { value: '600519' } });

    await switchTo('深度研究');
    await switchTo('对比分析');

    expect(await screen.findByLabelText('对比标的')).toHaveValue('600519');
  });

  it('研究助手：整段对话（含未发出的草稿）在切走再切回后仍在', async () => {
    render(<App />);
    await switchTo('研究助手');
    const draft = await screen.findByLabelText('向研究助手提问');
    fireEvent.change(draft, { target: { value: '这只票的估值合理吗' } });

    await switchTo('模拟盘');
    await switchTo('研究助手');

    expect(await screen.findByLabelText('向研究助手提问')).toHaveValue('这只票的估值合理吗');
  });

  it('多个白名单页签可交替访问，状态互不干扰', async () => {
    render(<App />);
    await switchTo('模拟盘');
    fireEvent.change(await screen.findByLabelText('委托价'), { target: { value: '100' } });
    await switchTo('对比分析');
    fireEvent.change(await screen.findByLabelText('对比标的'), { target: { value: '000001' } });

    // 来回切三趟，两边都应保住各自的值
    await switchTo('深度研究');
    await switchTo('模拟盘');
    expect(await screen.findByLabelText('委托价')).toHaveValue('100');
    await switchTo('对比分析');
    expect(await screen.findByLabelText('对比标的')).toHaveValue('000001');
  });
});

describe('App —— 白名单之外页签切走即卸载', () => {
  it('量化研究：切走后内容从树上消失（不再在隐藏状态下跑秒表）', async () => {
    render(<App />);
    await switchTo('量化研究');
    expect(await screen.findByText('量化页内容')).toBeInTheDocument();

    await switchTo('深度研究');
    expect(screen.queryByText('量化页内容')).toBeNull();
  });

  it('自选股 / 今日 / 历史：切走后各自卸载', async () => {
    render(<App />);
    for (const [tab, marker] of [
      ['自选股', '自选股页内容'],
      ['今日', '今日页内容'],
      ['历史', '历史页内容'],
    ] as const) {
      await switchTo(tab);
      expect(await screen.findByText(marker)).toBeInTheDocument();
      await switchTo('深度研究');
      expect(screen.queryByText(marker)).toBeNull();
    }
  });

  it('卸载后切回可正常重新挂载（面板不是一次性资源）', async () => {
    render(<App />);
    await switchTo('量化研究');
    await screen.findByText('量化页内容');
    await switchTo('深度研究');
    await switchTo('量化研究');

    expect(await screen.findByText('量化页内容')).toBeInTheDocument();
  });

  it('非白名单页签不会让隐藏面板的挂载集合无限增长', async () => {
    render(<App />);
    // 依次访问全部 8 个标签页：白名单只有 3 个，
    // 因此卸载后不应有任何非当前面板的内容残留在树上
    for (const name of ['今日', '量化研究', '对比分析', '自选股', '模拟盘', '研究助手', '历史']) {
      await switchTo(name);
    }
    await switchTo('深度研究');

    // 白名单 3 个面板仍在树上（hidden），白名单之外的都已卸载
    expect(screen.getByLabelText('委托价')).toBeInTheDocument();
    expect(screen.getByLabelText('对比标的')).toBeInTheDocument();
    expect(screen.getByLabelText('向研究助手提问')).toBeInTheDocument();
    expect(screen.queryByText('量化页内容')).toBeNull();
    expect(screen.queryByText('自选股页内容')).toBeNull();
    expect(screen.queryByText('今日页内容')).toBeNull();
    expect(screen.queryByText('历史页内容')).toBeNull();
  });
});
