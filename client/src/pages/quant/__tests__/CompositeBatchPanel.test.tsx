// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CompositeBatchPanel from '../CompositeBatchPanel';
import { ToastProvider } from '../../../components/Toast';
import type {
  CompositeAlphaBatchItem,
  CompositeAlphaBatchResult,
  CompositeAlphaHorizon,
  CompositeAlphaResult,
  CompositeContributor,
  CompositeDirection,
} from '../types';

/**
 * 批量组合 alpha 面板：用户可见行为的端到端（组件级）用例。
 * 只 mock 网络层（api/client）与真实计时，其余（signCls 着色、Toast、CSV 拼装）全走真实现，
 * 断言落在用户看得到的东西上：中文文案、数值、按钮可点性、红涨绿跌的类名、导出的文件内容。
 */

// 组件从 api/client 取三个符号，mock 工厂必须逐个导出，漏一个渲染时就报
// "No export is defined on the mock"。AnalysisCancelledError 放在 hoisted 里定义，
// 这样测试自己能 new 出同一个类引用（组件用 instanceof 判定，必须同一个类）。
const apiMocks = vi.hoisted(() => {
  class AnalysisCancelledError extends Error {
    constructor(message = '批量测算已取消') {
      super(message);
      this.name = 'AnalysisCancelledError';
    }
  }
  return { runBatchCompositeAlpha: vi.fn(), searchStocks: vi.fn(), AnalysisCancelledError };
});

vi.mock('../../../api/client', () => ({
  runBatchCompositeAlpha: apiMocks.runBatchCompositeAlpha,
  searchStocks: apiMocks.searchStocks,
  AnalysisCancelledError: apiMocks.AnalysisCancelledError,
}));

// ==== 测试夹具 ====

function contributor(
  name: CompositeContributor['name'],
  effectiveIc: number,
): CompositeContributor {
  return { name, effectiveIc, weight: 2, contribution: effectiveIc * 2 };
}

function makeHorizon(over: Partial<CompositeAlphaHorizon> = {}): CompositeAlphaHorizon {
  return {
    period: 21,
    alpha: 0.1,
    direction: 'up',
    significantCount: 1,
    evaluableCount: 3,
    agreement: 0.5,
    topContributors: [],
    ...over,
  };
}

function okItem(
  stockCode: string,
  over: {
    alpha?: number;
    direction?: CompositeDirection;
    horizons?: CompositeAlphaHorizon[];
    market?: CompositeAlphaResult['market'];
    benchmarkSecid?: string;
    benchmarkAvailable?: boolean;
    bars?: number;
  } = {},
): CompositeAlphaBatchItem {
  const horizons = over.horizons ?? [makeHorizon()];
  return {
    stockCode,
    ok: true,
    result: {
      stockCode,
      market: over.market ?? 'A',
      benchmarkSecid: over.benchmarkSecid ?? '1.000300',
      horizons: horizons.map((h) => h.period),
      compositeAlpha: {
        horizons,
        hasSignal: true,
        overallDirection: over.direction ?? 'up',
        overallAlpha: over.alpha ?? 0.1,
      },
      factorPredictability: [],
      bars: over.bars ?? 480,
      dataRange: { start: '2024-01-02', end: '2024-12-31' },
      benchmarkAvailable: over.benchmarkAvailable ?? true,
    },
  };
}

function failItem(stockCode: string, error: string): CompositeAlphaBatchItem {
  return { stockCode, ok: false, error };
}

function batch(items: CompositeAlphaBatchItem[]): CompositeAlphaBatchResult {
  const succeeded = items.filter((it) => it.ok).length;
  return {
    requested: items.length,
    succeeded,
    failed: items.length - succeeded,
    items,
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    horizons: [21, 63],
  };
}

/** 生成 n 个互不相同的 6 位代码 */
function manyCodes(n: number): string {
  return Array.from({ length: n }, (_, i) => String(600000 + i)).join('\n');
}

// ==== DOM 读取助手（都读用户看得见的文本） ====

function renderPanel() {
  return render(
    <ToastProvider>
      <CompositeBatchPanel />
    </ToastProvider>,
  );
}

const codesBox = () => screen.getByLabelText(/股票代码/);
const startDateBox = () => screen.getByLabelText(/开始日期/);
const endDateBox = () => screen.getByLabelText(/结束日期/);
const horizonsBox = () => screen.getByLabelText(/持有期/);
const startButton = () => screen.getByRole('button', { name: '开始测算' });

/** 去掉表头行后的数据行 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').slice(1);
}

function rowCodes(): string[] {
  return dataRows().map((tr) => tr.querySelector('td')?.textContent ?? '');
}

/** 第一条数据行的单元格文本，索引对应表头列顺序 */
function firstRowCells(): string[] {
  return Array.from(dataRows()[0].querySelectorAll('td')).map((td) => td.textContent ?? '');
}

function summaryText(): string {
  return document.querySelector('.batch-summary')?.textContent ?? '';
}

beforeEach(() => {
  apiMocks.runBatchCompositeAlpha.mockReset();
  apiMocks.searchStocks.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

describe('CompositeBatchPanel —— 初始形态与输入提示', () => {
  it('初始渲染：标题、20 只上限说明与预填示例代码，结果区尚未出现', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: /组合 alpha 批量测算/ })).toBeInTheDocument();
    expect(screen.getByText(/单次最多 20 只/)).toBeInTheDocument();

    // 预填可运行示例：占位符示例曾被误当成已填内容，点一下才发现是空的
    expect(codesBox()).toHaveValue('600519\n000858\nAAPL\n00700');
    expect(screen.getByText(/已识别 4 只代码/)).toBeInTheDocument();

    expect(startDateBox()).toHaveValue('');
    expect(endDateBox()).toHaveValue('');
    expect(horizonsBox()).toHaveValue('21,63');
    expect(screen.getByText('留空 = 近两年')).toBeInTheDocument();
    expect(screen.getByText('留空 = 今天')).toBeInTheDocument();
    expect(screen.getByText('默认 21,63（1月/3月）')).toBeInTheDocument();

    expect(startButton()).toBeEnabled();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
    expect(screen.queryByLabelText(/按综合 α 降序/)).toBeNull();
  });

  it('代码与名称混排时分别统计，并写明有几个名称将在测算时解析', () => {
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '600519, 000858\n贵州茅台' } });

    expect(screen.getByText(/已识别 2 只代码 · 1 个名称将在测算时解析/)).toBeInTheDocument();
  });

  it('超过 20 只时提示文字标红并写明超出上限', () => {
    const { container } = renderPanel();
    fireEvent.change(codesBox(), { target: { value: manyCodes(21) } });

    const hint = container.querySelector('.batch-hint');
    expect(hint).toHaveTextContent('已识别 21 只代码（超出上限 20）');
    expect(hint).toHaveClass('batch-hint-error');
  });

  it('只输入空白时提交：提示至少输入一个代码，且不发请求、不进加载态', () => {
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '  \n\n ' } });
    fireEvent.click(startButton());

    expect(screen.getByText('请至少输入一个股票代码或名称')).toBeInTheDocument();
    expect(apiMocks.runBatchCompositeAlpha).not.toHaveBeenCalled();
    expect(screen.queryByText(/正在逐只拉取/)).toBeNull();
  });
});

describe('CompositeBatchPanel —— 代码解析与请求参数', () => {
  it('纯代码大写后提交、重复去重；日期留空则这两个字段不下发', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(batch([okItem('600519')]));
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '600519\naapl\n600519' } });
    fireEvent.click(startButton());
    await screen.findByRole('table');

    expect(apiMocks.runBatchCompositeAlpha).toHaveBeenCalledWith(
      { stockCodes: ['600519', 'AAPL'], horizons: [21, 63] },
      expect.any(AbortSignal),
    );
  });

  it('填写区间后随请求下发；自定义持有期去重并丢弃非正数/非数字', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(batch([okItem('600519')]));
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '600519' } });
    fireEvent.change(startDateBox(), { target: { value: '2023-01-01' } });
    fireEvent.change(endDateBox(), { target: { value: '2023-12-31' } });
    fireEvent.change(horizonsBox(), { target: { value: '5, 10, 10, -3, abc' } });
    fireEvent.click(startButton());
    await screen.findByRole('table');

    expect(apiMocks.runBatchCompositeAlpha.mock.calls[0][0]).toEqual({
      stockCodes: ['600519'],
      startDate: '2023-01-01',
      endDate: '2023-12-31',
      horizons: [5, 10],
    });
  });

  it('持有期全部非法时回落默认 21,63，而不是发空数组', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(batch([okItem('600519')]));
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '600519' } });
    fireEvent.change(horizonsBox(), { target: { value: '0, -1, x' } });
    fireEvent.click(startButton());
    await screen.findByRole('table');

    expect(apiMocks.runBatchCompositeAlpha.mock.calls[0][0].horizons).toEqual([21, 63]);
  });

  it('名称唯一命中换成代码；未命中/多命中/查询失败只跳过并汇总提示', async () => {
    apiMocks.searchStocks.mockImplementation((kw: string) => {
      if (kw === '贵州茅台') return Promise.resolve([{ code: '600519', name: '贵州茅台' }]);
      if (kw === '银行') {
        return Promise.resolve([
          { code: '000001', name: '平安银行' },
          { code: '601398', name: '工商银行' },
        ]);
      }
      if (kw === '查无此股') return Promise.resolve([]);
      return Promise.reject(new Error('down'));
    });
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(batch([okItem('600519')]));

    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '贵州茅台\n银行\n查无此股\n腾讯' } });
    fireEvent.click(startButton());
    await screen.findByRole('table');

    // 只把唯一命中的名称解析成代码，其余不阻断
    expect(apiMocks.runBatchCompositeAlpha.mock.calls[0][0].stockCodes).toEqual(['600519']);
    const notice = screen.getByText(/已跳过无法识别的标的/);
    expect(notice).toHaveTextContent('银行：匹配到 2 只，请改用代码');
    expect(notice).toHaveTextContent('查无此股：无匹配');
    expect(notice).toHaveTextContent('腾讯：查询失败');
  });

  it('全部无法识别时报错并结束加载，不发起测算', async () => {
    apiMocks.searchStocks.mockResolvedValue([]);
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '查无此股\n也不存在' } });
    fireEvent.click(startButton());

    const banner = await screen.findByText(/未能识别任何标的/);
    expect(banner).toHaveTextContent('查无此股：无匹配');
    expect(banner).toHaveTextContent('也不存在：无匹配');
    expect(apiMocks.runBatchCompositeAlpha).not.toHaveBeenCalled();
    expect(startButton()).toBeEnabled();
  });

  it('解析去重后超过 20 只时拦截，并写明实际只数', async () => {
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: manyCodes(21) } });
    fireEvent.click(startButton());

    expect(await screen.findByText('解析去重后共 21 只，超出单次上限 20')).toBeInTheDocument();
    expect(apiMocks.runBatchCompositeAlpha).not.toHaveBeenCalled();
  });
});

describe('CompositeBatchPanel —— 结果渲染', () => {
  it('成功渲染：汇总、方向标签与红涨绿跌、主窗口汇总列与基准可用性', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(
      batch([
        okItem('600519', {
          alpha: 0.123,
          horizons: [
            makeHorizon({
              period: 21,
              alpha: 0.12,
              significantCount: 2,
              evaluableCount: 4,
              agreement: 0.75,
              topContributors: [contributor('reversal_1m', 0.123)],
            }),
            makeHorizon({
              period: 63,
              alpha: 0.06,
              significantCount: 1,
              evaluableCount: 4,
              agreement: 0.5,
              topContributors: [contributor('momentum_12_1', 0.02)],
            }),
          ],
        }),
        okItem('000858', {
          alpha: -0.045,
          direction: 'down',
          benchmarkAvailable: false,
          horizons: [
            makeHorizon({
              period: 21,
              alpha: -0.05,
              direction: 'down',
              significantCount: 1,
              evaluableCount: 3,
              agreement: 1,
              topContributors: [contributor('volatility_1m', -0.2)],
            }),
          ],
        }),
        okItem('AAPL', {
          alpha: 0,
          direction: 'neutral',
          market: 'US',
          benchmarkSecid: '10.ES:SPX',
          horizons: [
            makeHorizon({
              period: 21,
              alpha: 0.005,
              direction: 'neutral',
              significantCount: 0,
              evaluableCount: 3,
              agreement: 0,
              topContributors: [contributor('beta', 0.01)],
            }),
          ],
        }),
        failItem('BAD1', 'HTTP 500, 服务异常'),
      ]),
    );
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');

    expect(summaryText()).toContain('请求 4 只');
    expect(summaryText()).toContain('成功 3');
    expect(summaryText()).toContain('失败 1');
    expect(summaryText()).toContain('2024-01-01 ~ 2024-12-31');

    // 方向徽章：A 股口径红涨绿跌（up = 红），中性灰
    expect(screen.getByText('看多')).toHaveClass('val-positive');
    expect(screen.getByText('看空')).toHaveClass('val-negative');
    expect(screen.getByText('中性')).toHaveClass('val-neutral');

    // 综合 α：正数带 + 号且走红，负数走绿，0 走中性
    expect(screen.getByText('+0.123')).toHaveClass('batch-alpha', 'val-positive');
    expect(screen.getByText('-0.045')).toHaveClass('val-negative');
    expect(screen.getByText('+0.000')).toHaveClass('val-neutral');

    // 主窗口 = 显著因子最多的 21 日窗口
    const cells = firstRowCells();
    expect(cells[0]).toBe('600519');
    expect(cells[5]).toBe('2/4');
    expect(cells[6]).toBe('75%');
    expect(cells[7]).toBe('reversal_1m 0.123');
    expect(cells[9]).toBe('✓');

    // K 线数与数据区间走 title，鼠标悬停可见
    expect(screen.getAllByTitle('2024-01-02 ~ 2024-12-31')[0]).toHaveTextContent('480');
    // 基准：AAPL 与本行可用（✓），000858 不可用显示 —
    expect(screen.getAllByText('✓')).toHaveLength(2);
    expect(screen.getAllByText('—')).toHaveLength(1);

    // 失败行原样展示代码与中文原因
    expect(screen.getByText('HTTP 500, 服务异常')).toBeInTheDocument();

    // 有结果才出现的导出与排序入口
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeInTheDocument();
    expect(screen.getByLabelText(/按综合 α 降序/)).toBeChecked();
  });

  it('汇总列取「显著因子最多」的持有期，不把不同窗口的数字混在一起', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(
      batch([
        okItem('600519', {
          alpha: 0.125,
          horizons: [
            makeHorizon({
              period: 21,
              alpha: 0.05,
              significantCount: 1,
              evaluableCount: 4,
              agreement: 0.25,
              topContributors: [contributor('volatility_1m', 0.05)],
            }),
            makeHorizon({
              period: 63,
              alpha: 0.2,
              significantCount: 3,
              evaluableCount: 4,
              agreement: 0.8,
              topContributors: [contributor('momentum_12_1', 0.21)],
            }),
          ],
        }),
      ]),
    );
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');

    const cells = firstRowCells();
    expect(cells[5]).toBe('3/4');
    expect(cells[6]).toBe('80%');
    expect(cells[7]).toBe('momentum_12_1 0.210');
    // 两个窗口各自的 α 仍然都列在「各持有期」里
    const periods = Array.from(dataRows()[0].querySelectorAll('.batch-horizon')).map(
      (el) => el.textContent,
    );
    expect(periods).toEqual(['1月+0.050', '3月+0.200']);
  });

  it('失败行只占一行并显示中文失败原因', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(
      batch([failItem('BAD1', '无法连接后端服务'), okItem('600519')]),
    );
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');

    const rows = dataRows();
    expect(rows).toHaveLength(2);
    expect(rowCodes()).toEqual(['600519', 'BAD1']);
    // 失败行是「代码 + 跨 9 列的原因」，不会错位成两行
    expect(Array.from(rows[1].querySelectorAll('td'))).toHaveLength(2);
    expect(screen.getByText('无法连接后端服务')).toBeInTheDocument();
    expect(summaryText()).toContain('失败 1');
  });

  it('结果为空时显示「无有效结果」，且不给导出与排序入口', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(batch([]));
    renderPanel();
    fireEvent.click(startButton());

    expect(await screen.findByText('无有效结果')).toBeInTheDocument();
    expect(screen.getByText(/请求 0 只/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
    expect(screen.queryByLabelText(/按综合 α 降序/)).toBeNull();
  });

  it('持有期为空数组时汇总列用「—」占位，不抛异常', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(batch([okItem('600519', { horizons: [] })]));
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');

    const cells = firstRowCells();
    expect(cells[4]).toBe('');
    expect(cells[5]).toBe('—');
    expect(cells[6]).toBe('—');
    expect(cells[7]).toBe('—');
  });

  it('没有主导因子时主导因子列用「—」占位', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(
      batch([
        okItem('600519', {
          horizons: [
            makeHorizon({
              significantCount: 2,
              evaluableCount: 5,
              agreement: 0.4,
              topContributors: [],
            }),
          ],
        }),
      ]),
    );
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');

    const cells = firstRowCells();
    expect(cells[5]).toBe('2/5');
    expect(cells[7]).toBe('—');
    expect(screen.getAllByText('—')).toHaveLength(1);
  });

  it('持有期标签：21/63 显示 1月/3月，其余显示 N日', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(
      batch([
        okItem('600519', {
          horizons: [
            makeHorizon({ period: 5 }),
            makeHorizon({ period: 21 }),
            makeHorizon({ period: 63 }),
          ],
        }),
      ]),
    );
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');

    const labels = Array.from(dataRows()[0].querySelectorAll('.batch-horizon-period')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['5日', '1月', '3月']);
  });
});

describe('CompositeBatchPanel —— 排序与导出', () => {
  it('默认按综合 α 降序（失败行沉底），关闭开关后回到服务端顺序', async () => {
    apiMocks.runBatchCompositeAlpha.mockResolvedValue(
      batch([
        failItem('BAD1', '取数失败'),
        okItem('600519', { alpha: 0.02 }),
        okItem('000858', { alpha: 0.3 }),
      ]),
    );
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');

    expect(rowCodes()).toEqual(['000858', '600519', 'BAD1']);

    fireEvent.click(screen.getByLabelText(/按综合 α 降序/));
    expect(rowCodes()).toEqual(['BAD1', '600519', '000858']);
  });

  it('导出 CSV：文件名含区间，内容含 BOM 与中文表头，逗号/引号被转义', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:mock-url';
    });
    const revokeObjectURL = vi.fn();
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
    // 拦截 <a>.click()：既拿到下载文件名，也不让 jsdom 去"导航"
    let downloadedName = '';
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (
      this: HTMLElement,
    ) {
      downloadedName = this.getAttribute('download') ?? '';
    });

    apiMocks.runBatchCompositeAlpha.mockResolvedValue(
      batch([
        okItem('600519', {
          alpha: 0.123,
          horizons: [
            makeHorizon({
              significantCount: 2,
              evaluableCount: 4,
              agreement: 0.75,
              topContributors: [contributor('reversal_1m', 0.123)],
            }),
          ],
        }),
        failItem('BAD1', 'HTTP 500, 服务异常'),
        failItem('BAD2', '名称含"引号"'),
      ]),
    );
    renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloadedName).toBe('组合alpha批量测算_2024-01-01_2024-12-31.csv');

    // 文件含 UTF-8 BOM（Excel 直接打开不乱码）；Blob.text() 会吃掉 BOM，只能看原始字节
    const bytes = new Uint8Array(await blobs[0].arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    const lines = (await blobs[0].text()).split('\r\n');
    expect(lines[0]).toBe(
      '代码,市场,基准secid,综合方向,综合α,显著因子,一致率,主导因子,K线数,数据起,数据止,基准可用',
    );
    expect(lines[1]).toBe(
      '600519,A,1.000300,看多,0.1230,2/4,75%,reversal_1m(0.123),480,2024-01-02,2024-12-31,是',
    );
    // 失败行只填代码与原因，其余留空（代码,市场,基准secid,方向=失败,…）
    expect(lines[2].startsWith('BAD1,,,失败,')).toBe(true);
    expect(lines[2].endsWith(',"HTTP 500, 服务异常"')).toBe(true);
    expect(lines[3].endsWith(',"名称含""引号"""')).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    clickSpy.mockRestore();
  });
});

describe('CompositeBatchPanel —— 加载、计时与取消', () => {
  it('测算中：表单与提交按钮锁定，显示计时文案与「取消测算」入口（每秒 +1）', async () => {
    vi.useFakeTimers();
    apiMocks.runBatchCompositeAlpha.mockReturnValue(new Promise(() => {}));
    renderPanel();
    fireEvent.click(startButton());
    await act(async () => {});

    expect(screen.getByRole('button', { name: '测算中…' })).toBeDisabled();
    expect(codesBox()).toBeDisabled();
    expect(startDateBox()).toBeDisabled();
    expect(endDateBox()).toBeDisabled();
    expect(horizonsBox()).toBeDisabled();
    expect(screen.getByText(/已耗时 0 秒/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消测算' })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText(/已耗时 2 秒/)).toBeInTheDocument();
  });

  it('取消：AnalysisCancelledError 静默收尾，只提示已取消、不渲染失败横幅', async () => {
    const captured: { signal?: AbortSignal } = {};
    apiMocks.runBatchCompositeAlpha.mockImplementation((_payload: unknown, signal: AbortSignal) => {
      captured.signal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new apiMocks.AnalysisCancelledError('批量测算已取消')),
        );
      });
    });
    renderPanel();
    fireEvent.click(startButton());
    fireEvent.click(await screen.findByRole('button', { name: '取消测算' }));

    expect(captured.signal?.aborted).toBe(true);
    // 用户看到的只有一条轻提示，而不是红色失败横幅
    expect(await screen.findByText(/已取消本次测算/)).toBeInTheDocument();
    expect(document.querySelector('.error-banner')).toBeNull();
    expect(screen.queryByText(/批量测算已取消/)).toBeNull();
    expect(screen.queryByText(/请求 \d+ 只/)).toBeNull();
    // 取消后回到可再次提交的状态
    expect(startButton()).toBeEnabled();
    expect(screen.queryByRole('button', { name: '取消测算' })).toBeNull();
  });

  it('卸载面板会中止在途测算请求（不再向已卸载组件写状态）', async () => {
    const captured: { signal?: AbortSignal } = {};
    apiMocks.runBatchCompositeAlpha.mockImplementation((_payload: unknown, signal: AbortSignal) => {
      captured.signal = signal;
      return new Promise(() => {});
    });
    const { unmount } = renderPanel();
    fireEvent.click(startButton());
    await screen.findByRole('button', { name: '取消测算' });
    expect(captured.signal?.aborted).toBe(false);

    unmount();
    expect(captured.signal?.aborted).toBe(true);
  });
});

describe('CompositeBatchPanel —— 失败与重试', () => {
  it('失败时显示中文错误横幅、不渲染结果；再点一次可重试成功', async () => {
    apiMocks.runBatchCompositeAlpha
      .mockRejectedValueOnce(
        new Error(
          '无法连接后端服务（localhost:3001）。请确认服务已启动，或运行「启动系统.bat」后重试',
        ),
      )
      .mockResolvedValueOnce(batch([okItem('600519')]));
    renderPanel();
    fireEvent.click(startButton());

    expect(await screen.findByText(/无法连接后端服务/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    // 「开始测算」本身就是重试入口，失败后必须可再次点击
    expect(startButton()).toBeEnabled();

    fireEvent.click(startButton());
    await screen.findByRole('table');
    expect(screen.queryByText(/无法连接后端服务/)).toBeNull();
  });

  it('跳过的标的提示在整批失败时让位给错误横幅', async () => {
    apiMocks.searchStocks.mockResolvedValue([]);
    apiMocks.runBatchCompositeAlpha.mockRejectedValue(
      new Error('后端服务异常（500），请查看服务端日志'),
    );
    renderPanel();
    fireEvent.change(codesBox(), { target: { value: '600519\n查无此股' } });
    fireEvent.click(startButton());

    expect(await screen.findByText(/后端服务异常（500）/)).toBeInTheDocument();
    expect(screen.queryByText(/已跳过无法识别的标的/)).toBeNull();
  });
});
