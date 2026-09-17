// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ValuationPanel from '../ValuationPanel';
import type { ValuationModelResult } from '../../../api/client';

const api = vi.hoisted(() => ({ runValuationModelApi: vi.fn() }));

vi.mock('../../../api/client', () => ({
  runValuationModelApi: api.runValuationModelApi,
}));

/** 一份「典型成功」结果：DCF、敏感度、可比公司、假设来源、局限声明齐备 */
function makeResult(over: Partial<ValuationModelResult> = {}): ValuationModelResult {
  return {
    model: 'two_stage_eps_dcf',
    code: '600519',
    fairValue: 42.5,
    currentPrice: 35,
    upsidePct: 21.43,
    dcf: {
      fairValue: 42.5,
      explicitValue: 12.5,
      terminalValue: 45,
      discountedTerminalValue: 30,
      cashFlows: [
        { year: 1, eps: 1.2, discountFactor: 0.917, presentValue: 1.1 },
        { year: 2, eps: 1.344, discountFactor: 0.842, presentValue: 1.13 },
      ],
      assumptions: { growthRate1: 0.12 },
    },
    sensitivity: {
      discountRates: [0.09, 0.1],
      growthRates1: [0.1, 0.12],
      matrix: [
        [40.1, 45.25],
        [Number.POSITIVE_INFINITY, 41],
      ],
    },
    comparables: {
      peers: [{ code: '000858', name: '五粮液', pe: 20, pb: 5 }],
      sampleSize: 12,
      medianPe: 18.5,
      medianPb: 3.2,
      medianRoe: 0.22,
      pePremiumPct: -0.2,
      pbPremiumPct: -0.1,
      impliedValueByMedianPe: 30,
    },
    assumptions: {
      baseEps: 1.2,
      growthRate1: 0.12,
      growthRate1Source: 'eps_cagr_3y',
      growthRate2: 0.03,
      discountRate: 0.09,
      explicitYears: 5,
    },
    limitations: ['EPS 贴现近似，未考虑资本开支与债务结构', '假设小幅变动会显著改变结果'],
    ...over,
  };
}

function renderPanel() {
  return render(<ValuationPanel />);
}

const codeInput = () => screen.getByLabelText('待估值的股票代码（6 位数字）');
const runButton = () => screen.getByRole('button', { name: '开始建模' });

/** 取匹配元素合并后的可见文本（跨 text 节点，忽略子元素边界） */
function textOf(re: RegExp): string {
  return (screen.getByText(re).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 数值卡片：按标签取同一张卡片里的值元素 */
function cardValue(label: string): HTMLElement {
  const card = screen.getByText(label).parentElement as HTMLElement;
  return card.querySelector('.paper-stat-value') as HTMLElement;
}

describe('ValuationPanel —— 表单与入参校验', () => {
  beforeEach(() => {
    api.runValuationModelApi.mockReset();
    api.runValuationModelApi.mockResolvedValue(makeResult());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('首次进入：标题、四个带可访问名的输入框与「开始建模」按钮齐备', () => {
    renderPanel();

    expect(
      screen.getByRole('heading', { name: '估值建模（两阶段 EPS 贴现 + 可比公司表）' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/假设留空时自动推导/)).toBeInTheDocument();

    expect(screen.getByPlaceholderText('股票代码（6 位）')).toBeInTheDocument();
    expect(screen.getByLabelText(/显性期 EPS 增速/)).toBeInTheDocument();
    expect(screen.getByLabelText(/折现率/)).toBeInTheDocument();
    expect(screen.getByLabelText(/永续期增速/)).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
  });

  it('代码为空时提交被拦截并提示「请输入 6 位股票代码」，不发请求', () => {
    renderPanel();

    fireEvent.click(runButton());

    expect(screen.getByText('请输入 6 位股票代码')).toBeInTheDocument();
    expect(api.runValuationModelApi).not.toHaveBeenCalled();
  });

  it('代码不足 6 位或含非数字时同样被拦截', () => {
    renderPanel();

    fireEvent.change(codeInput(), { target: { value: '60051' } });
    fireEvent.click(runButton());
    expect(screen.getByText('请输入 6 位股票代码')).toBeInTheDocument();

    fireEvent.change(codeInput(), { target: { value: 'abcdef' } });
    fireEvent.click(runButton());
    expect(screen.getByText('请输入 6 位股票代码')).toBeInTheDocument();
    expect(api.runValuationModelApi).not.toHaveBeenCalled();
  });

  it('假设留空时不提交 assumptions 字段（交给服务端按年报推导）', async () => {
    renderPanel();

    fireEvent.change(codeInput(), { target: { value: '600519' } });
    fireEvent.click(runButton());

    await waitFor(() => expect(api.runValuationModelApi).toHaveBeenCalledTimes(1));
    expect(api.runValuationModelApi).toHaveBeenCalledWith({ code: '600519' });
  });

  it('显式填写的假设随请求提交，非数字输入被忽略', async () => {
    renderPanel();

    fireEvent.change(codeInput(), { target: { value: '600519' } });
    fireEvent.change(screen.getByLabelText(/显性期 EPS 增速/), { target: { value: '0.12' } });
    fireEvent.change(screen.getByLabelText(/折现率/), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText(/永续期增速/), { target: { value: '  ' } });
    fireEvent.click(runButton());

    await waitFor(() => expect(api.runValuationModelApi).toHaveBeenCalledTimes(1));
    expect(api.runValuationModelApi).toHaveBeenCalledWith({
      code: '600519',
      assumptions: { growthRate1: 0.12 },
    });
  });

  it('计算中：按钮变「计算中…」且禁用（防重复提交）', async () => {
    api.runValuationModelApi.mockReturnValue(new Promise(() => {}));
    renderPanel();

    fireEvent.change(codeInput(), { target: { value: '600519' } });
    fireEvent.click(runButton());

    const busy = screen.getByRole('button', { name: '计算中…' });
    expect(busy).toBeDisabled();
  });

  it('失败：显示中文错误横幅、按钮恢复可点，重试成功后横幅消失', async () => {
    api.runValuationModelApi.mockRejectedValueOnce(new Error('估值建模失败：缺少年报 EPS'));
    renderPanel();

    fireEvent.change(codeInput(), { target: { value: '600519' } });
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByText('估值建模失败：缺少年报 EPS')).toBeInTheDocument());
    expect(runButton()).toBeEnabled();

    api.runValuationModelApi.mockResolvedValueOnce(makeResult());
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByText('每股内在价值')).toBeInTheDocument());
    expect(screen.queryByText('估值建模失败：缺少年报 EPS')).toBeNull();
  });
  it('非 Error 失败时用兜底文案，不把 undefined 渲染进横幅', async () => {
    api.runValuationModelApi.mockRejectedValueOnce('boom');
    renderPanel();

    fireEvent.change(codeInput(), { target: { value: '600519' } });
    fireEvent.click(runButton());

    await waitFor(() => expect(screen.getByText('估值建模失败')).toBeInTheDocument());
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(runButton()).toBeEnabled();
  });
});

describe('ValuationPanel —— 结果渲染', () => {
  beforeEach(() => {
    api.runValuationModelApi.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runWith(result: ValuationModelResult) {
    api.runValuationModelApi.mockResolvedValue(result);
    renderPanel();
    fireEvent.change(codeInput(), { target: { value: '600519' } });
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByText('每股内在价值')).toBeInTheDocument());
  }

  it('成功结果：渲染内在价值、现价、隐含溢价与推导出来的假设', async () => {
    await runWith(makeResult());

    expect(cardValue('每股内在价值').textContent).toBe('42.50 元');
    expect(cardValue('现价').textContent).toBe('35.00 元');

    const upside = cardValue('现价隐含溢价（正=高估）');
    expect(upside.textContent).toBe('21.4%');
    // 正溢价 = 数值向上 → 红（与 lib/colors.ts 的 signCls / 红涨绿跌口径一致）
    expect(upside.className).toContain('val-positive');

    const assumptions = textOf(/g1 /);
    expect(assumptions).toContain('g1 12.0%（推导）');
    expect(assumptions).toContain('r 9.0%');
    expect(assumptions).toContain('g2 3.0% · 5 年');
  });

  it('折价时隐含溢价为负值并着绿（与全站 signCls 一致）', async () => {
    await runWith(makeResult({ upsidePct: -12.5 }));

    const upside = cardValue('现价隐含溢价（正=高估）');
    expect(upside.textContent).toBe('-12.5%');
    expect(upside.className).toContain('val-negative');
  });

  it('无法计算溢价（—）时用中性色，不被染成方向色', async () => {
    await runWith(makeResult({ upsidePct: null, fairValue: null }));

    const upside = cardValue('现价隐含溢价（正=高估）');
    expect(upside.textContent).toBe('—');
    expect(upside.className).toContain('val-neutral');
  });

  it('显式覆盖的增速不标「推导」，只展示覆盖后的取值', async () => {
    await runWith(
      makeResult({
        assumptions: {
          baseEps: 1.2,
          growthRate1: 0.15,
          growthRate1Source: 'input',
          growthRate2: 0.02,
          discountRate: 0.1,
          explicitYears: 7,
        },
      }),
    );

    const assumptions = textOf(/g1 /);
    expect(assumptions).toContain('g1 15.0% ·');
    expect(assumptions).not.toContain('（推导）');
    expect(assumptions).toContain('r 10.0%');
    expect(assumptions).toContain('7 年');
  });

  it('DCF 明细表：年份表头、逐年 EPS 与现值、终值现值落表', async () => {
    await runWith(makeResult());

    expect(screen.getByRole('columnheader', { name: '第 1 年' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '第 2 年' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '终值现值' })).toBeInTheDocument();

    expect(screen.getByText('1.200')).toBeInTheDocument();
    expect(screen.getByText('1.344')).toBeInTheDocument();
    expect(screen.getByText('1.10')).toBeInTheDocument();
    expect(screen.getByText('1.13')).toBeInTheDocument();
    expect(screen.getByText('30.00')).toBeInTheDocument();
  });

  it('dcf 为 null 时不渲染明细表，缺失数值一律显示破折号', async () => {
    await runWith(
      makeResult({
        dcf: null,
        fairValue: null,
        upsidePct: null,
        comparables: {
          peers: [],
          sampleSize: 0,
          medianPe: null,
          medianPb: null,
          medianRoe: null,
          pePremiumPct: null,
          pbPremiumPct: null,
          impliedValueByMedianPe: null,
        },
      }),
    );

    expect(screen.queryByRole('columnheader', { name: '终值现值' })).toBeNull();
    expect(cardValue('每股内在价值').textContent).toBe('—');
    expect(cardValue('现价隐含溢价（正=高估）').textContent).toBe('—');
    expect(screen.getByText('0 家')).toBeInTheDocument();
    // 卡片里的公允价值 / 隐含溢价 + 可比表的 PE / PB / 折溢价 / 隐含价值，全部走破折号
    expect(screen.getAllByText('—')).toHaveLength(6);
  });

  it('敏感度矩阵：增速做表头、折现率做行标，发散单元显示「发散」', async () => {
    await runWith(makeResult());

    expect(screen.getByRole('columnheader', { name: '10.0%' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '12.0%' })).toBeInTheDocument();
    expect(screen.getByText('r = 9.0%')).toBeInTheDocument();
    expect(screen.getByText('r = 10.0%')).toBeInTheDocument();

    expect(screen.getByText('40.10')).toBeInTheDocument();
    expect(screen.getByText('45.25')).toBeInTheDocument();
    // 折现率 ≤ 永续增速时贴现发散 → 不能用数字糊弄，必须显式标注
    expect(screen.getByText('发散')).toBeInTheDocument();
  });

  it('sensitivity 为 null 时不渲染敏感度表', async () => {
    await runWith(makeResult({ sensitivity: null }));

    expect(screen.queryByRole('columnheader', { name: '公允价值（元）' })).toBeNull();
    expect(screen.queryByText('发散')).toBeNull();
    // 其余结果照常渲染
    expect(cardValue('每股内在价值').textContent).toBe('42.50 元');
  });

  it('可比公司表：样本数、PE/PB 中位数与本股折溢价', async () => {
    await runWith(makeResult());

    expect(screen.getByRole('columnheader', { name: '可比样本' })).toBeInTheDocument();
    expect(screen.getByText('12 家')).toBeInTheDocument();
    expect(screen.getByText('18.50')).toBeInTheDocument();
    expect(screen.getByText('3.20')).toBeInTheDocument();
    expect(screen.getByText('-20.0%')).toBeInTheDocument();
    expect(screen.getByText('30.00 元')).toBeInTheDocument();
  });

  it('局限声明照实展示（每一条都是用户可见的免责说明）', async () => {
    await runWith(makeResult());

    expect(screen.getByText('EPS 贴现近似，未考虑资本开支与债务结构')).toBeInTheDocument();
    expect(screen.getByText('假设小幅变动会显著改变结果')).toBeInTheDocument();
  });
});
