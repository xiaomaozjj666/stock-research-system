import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeTimeseries, TS_TESTS } from '../analyze.js';

// 只测「取数 → 校验 → 分派」这一层：五个计量实现各自已有单测，
// 这里把它们替换为哨兵值，就能精确断言参数是怎么被过滤与透传的。
// 每个替身都写全形参，mock.calls 才有可断言的元组类型。
const mocks = vi.hoisted(() => ({
  fetchOHLCVData: vi.fn((_code: string, _startDate: string, _endDate: string) =>
    Promise.resolve(undefined as unknown[] | undefined),
  ),
  adfTest: vi.fn((_series: number[], _opts?: { spec?: string; criterion?: string }) => ({
    statistic: -3.1,
    pValue: 0.02,
    stationary: true,
  })),
  fitVolatilityModels: vi.fn((_returns: number[]) => ({ best: 'garch11', models: [] })),
  engleGranger: vi.fn((_y: number[], _x: number[]) => ({ pValue: 0.01, cointegrated: true })),
  fitArima: vi.fn((_closes: number[], _opts?: { d?: number; pMax?: number }) => ({
    order: [1, 1, 1],
    aic: 12.3,
  })),
  timeVaryingBeta: vi.fn((_y: number[], _x: number[], _opts?: { qRatio?: number }) => ({
    intercept: Array.from({ length: 100 }, (_, i) => i / 100),
    hedgeRatio: Array.from({ length: 100 }, (_, i) => 1 + i / 100),
    oneStepErrors: Array.from({ length: 100 }, () => 0.01),
  })),
}));

vi.mock('../../dataProvider.js', () => ({ fetchOHLCVData: mocks.fetchOHLCVData }));
vi.mock('../adf.js', () => ({ adfTest: mocks.adfTest }));
vi.mock('../garch.js', () => ({ fitVolatilityModels: mocks.fitVolatilityModels }));
vi.mock('../cointegration.js', () => ({ engleGranger: mocks.engleGranger }));
vi.mock('../arima.js', () => ({ fitArima: mocks.fitArima }));
vi.mock('../kalman.js', () => ({ timeVaryingBeta: mocks.timeVaryingBeta }));

/** 与实现同口径的本地日期串：避免用例自身引入时区偏差 */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function today(): Date {
  return new Date();
}

/** 造 n 条连续日历日的 K 线（只需日期与收盘，实现不关心节假日） */
function makeKlines(n: number, opts: { startDate?: string; closeAt?: (i: number) => number } = {}) {
  const start = opts.startDate
    ? new Date(`${opts.startDate}T00:00:00`)
    : new Date('2023-01-01T00:00:00');
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return { date: localDate(d), close: opts.closeAt ? opts.closeAt(i) : 10 + i * 0.05 };
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockClear();
  mocks.fetchOHLCVData.mockResolvedValue(makeKlines(300));
  mocks.adfTest.mockReturnValue({ statistic: -3.1, pValue: 0.02, stationary: true });
  mocks.fitVolatilityModels.mockReturnValue({ best: 'garch11', models: [] });
  mocks.engleGranger.mockReturnValue({ pValue: 0.01, cointegrated: true });
  mocks.fitArima.mockReturnValue({ order: [1, 1, 1], aic: 12.3 });
  mocks.timeVaryingBeta.mockReturnValue({
    intercept: Array.from({ length: 100 }, (_, i) => i / 100),
    hedgeRatio: Array.from({ length: 100 }, (_, i) => 1 + i / 100),
    oneStepErrors: Array.from({ length: 100 }, () => 0.01),
  });
});

describe('analyzeTimeseries —— 参数校验', () => {
  it('test 不在白名单时列出全部合法取值', async () => {
    await expect(analyzeTimeseries({ test: 'var', code: '600519' })).rejects.toThrow(
      "test 需为 'adf' | 'garch' | 'coint' | 'arima' | 'kalman-beta' 之一",
    );
    expect(mocks.fetchOHLCVData).not.toHaveBeenCalled();
  });

  it('test 缺失 / 仅空白同样被拒（不落入任何分支）', async () => {
    await expect(analyzeTimeseries({ test: '', code: '600519' })).rejects.toThrow('test 需为');
    await expect(analyzeTimeseries({ test: '  ', code: '600519' })).rejects.toThrow('test 需为');
  });

  it('code 必填且会 trim', async () => {
    await expect(analyzeTimeseries({ test: 'adf', code: '   ' })).rejects.toThrow('code 必填');
    await analyzeTimeseries({ test: 'adf', code: '  600519  ' });
    expect(mocks.fetchOHLCVData.mock.calls[0][0]).toBe('600519');
  });

  it.each(['coint', 'kalman-beta'])('%s 缺第二条序列时明确报出需要 code2', async (test) => {
    await expect(analyzeTimeseries({ test, code: '600519' })).rejects.toThrow(
      `test='${test}' 需要第二条序列（code2）`,
    );
  });

  it('TS_TESTS 是唯一白名单来源（路由与 chat 工具据此提示）', () => {
    expect([...TS_TESTS]).toEqual(['adf', 'garch', 'coint', 'arima', 'kalman-beta']);
  });
});

describe('analyzeTimeseries —— 时间窗口', () => {
  it('不传日期时默认近 3 年（日频约 730 个观测）', async () => {
    await analyzeTimeseries({ test: 'adf', code: '600519' });

    const [, startDate, endDate] = mocks.fetchOHLCVData.mock.calls[0];
    expect(endDate).toBe(localDate(today()));
    const expectedStart = today();
    expectedStart.setFullYear(expectedStart.getFullYear() - 3);
    expect(startDate).toBe(localDate(expectedStart));
    expect(startDate < endDate).toBe(true);
  });

  it('合法日期原样透传（不做时区换算）', async () => {
    await analyzeTimeseries({
      test: 'adf',
      code: '600519',
      startDate: '2024-01-02',
      endDate: '2025-06-30',
    });
    expect(mocks.fetchOHLCVData.mock.calls[0].slice(1)).toEqual(['2024-01-02', '2025-06-30']);
  });

  it('日期格式非法时回退默认窗口，而不是把脏串发给数据源', async () => {
    await analyzeTimeseries({ test: 'adf', code: '600519', startDate: '2024/01/02' });
    const [, startDate] = mocks.fetchOHLCVData.mock.calls[0];
    expect(startDate).not.toBe('2024/01/02');
    expect(startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('窗口上限 10 年：更早的起始日被拒', async () => {
    const tooEarly = today();
    tooEarly.setFullYear(tooEarly.getFullYear() - 11);
    await expect(
      analyzeTimeseries({ test: 'adf', code: '600519', startDate: localDate(tooEarly) }),
    ).rejects.toThrow('时间窗口最多 10 年（startDate 过早）');
  });

  it('startDate 不早于 endDate 时被拒（含相等）', async () => {
    await expect(
      analyzeTimeseries({
        test: 'adf',
        code: '600519',
        startDate: '2025-06-30',
        endDate: '2025-06-30',
      }),
    ).rejects.toThrow('startDate 需早于 endDate');

    await expect(
      analyzeTimeseries({
        test: 'adf',
        code: '600519',
        startDate: '2025-07-01',
        endDate: '2025-06-30',
      }),
    ).rejects.toThrow('startDate 需早于 endDate');
  });
});

describe('analyzeTimeseries —— K 线取数与数据量门槛', () => {
  it('不足 60 条时报出实际条数（便于判断是代码错还是窗口窄）', async () => {
    mocks.fetchOHLCVData.mockResolvedValue(makeKlines(59));
    await expect(analyzeTimeseries({ test: 'adf', code: '600519' })).rejects.toThrow(
      '600519 的 K 线数据不足（59 条 < 60）',
    );
  });

  it('数据源返回空值时按 0 条处理', async () => {
    mocks.fetchOHLCVData.mockResolvedValue(undefined);
    await expect(analyzeTimeseries({ test: 'adf', code: '600519' })).rejects.toThrow(
      'K 线数据不足（0 条 < 60）',
    );
  });

  it('窗口元信息记录实际取到的观测数', async () => {
    mocks.fetchOHLCVData.mockResolvedValue(makeKlines(120));
    const out = await analyzeTimeseries({ test: 'garch', code: '600519' });
    expect(out.window.n).toBe(120);
  });
});

describe('analyzeTimeseries —— adf 分派', () => {
  it('默认按对数收益检验，并给出对应解读', async () => {
    const out = await analyzeTimeseries({ test: 'adf', code: '600519' });

    expect(out.test).toBe('adf');
    expect(out.input).toBe('return');
    expect(out.note).toContain('对数收益序列若不能拒绝单位根');
    const [series, opts] = mocks.adfTest.mock.calls[0];
    expect(series).toHaveLength(299); // n 条收盘 → n-1 个收益
    expect(opts).toEqual({ spec: 'c' });
  });

  it("options.on='price' 时改用价格序列，并切换解读文案", async () => {
    const out = await analyzeTimeseries({
      test: 'adf',
      code: '600519',
      options: { on: 'price' },
    });
    expect(out.input).toBe('price');
    expect(out.note).toContain('价格序列通常应拒绝失败');
    expect(mocks.adfTest.mock.calls[0][0]).toHaveLength(300);
  });

  it('on 取非法值时回落到 return（不把脏值当价格）', async () => {
    const out = await analyzeTimeseries({ test: 'adf', code: '600519', options: { on: 'log' } });
    expect(out.input).toBe('return');
  });

  it.each(['n', 'c', 'ct'])('spec=%s 合法并透传', async (spec) => {
    await analyzeTimeseries({ test: 'adf', code: '600519', options: { spec } });
    expect(mocks.adfTest.mock.calls[0][1]).toEqual({ spec });
  });

  it('spec 非法时直接拒绝（不静默用默认值蒙混）', async () => {
    await expect(
      analyzeTimeseries({ test: 'adf', code: '600519', options: { spec: 'ctt' } }),
    ).rejects.toThrow("spec 需为 'n' | 'c' | 'ct'");
  });

  it('criterion 仅接受 aic/bic，其它取值不下发', async () => {
    await analyzeTimeseries({ test: 'adf', code: '600519', options: { criterion: 'bic' } });
    expect(mocks.adfTest.mock.calls[0][1]).toEqual({ spec: 'c', criterion: 'bic' });

    await analyzeTimeseries({ test: 'adf', code: '600519', options: { criterion: 'hq' } });
    expect(mocks.adfTest.mock.calls[1][1]).toEqual({ spec: 'c' });
  });

  it('对数收益在遇到非正收盘价时跳过该点（脏数据不产生 -Infinity）', async () => {
    mocks.fetchOHLCVData.mockResolvedValue(
      makeKlines(100, { closeAt: (i) => (i === 50 ? 0 : 10 + i * 0.05) }),
    );
    await analyzeTimeseries({ test: 'adf', code: '600519' });
    const series = mocks.adfTest.mock.calls[0][0] as number[];
    expect(series.every((v) => Number.isFinite(v))).toBe(true);
    expect(series).toHaveLength(97); // 99 个相邻对里，涉及 0 价的两对被跳过
  });
});

describe('analyzeTimeseries —— garch / arima 分派', () => {
  it('garch 用对数收益拟合，且收益不足 60 条时给出专属提示', async () => {
    const out = await analyzeTimeseries({ test: 'garch', code: '600519' });
    expect(out.result).toEqual({ best: 'garch11', models: [] });
    expect(mocks.fitVolatilityModels.mock.calls[0][0]).toHaveLength(299);

    // K 线够 60 条，但有非正收盘价导致收益不足：错误文案要说清是"对数收益"不够
    mocks.fetchOHLCVData.mockResolvedValue(
      makeKlines(60, { closeAt: (i) => (i < 4 ? 0 : 10 + i) }),
    );
    await expect(analyzeTimeseries({ test: 'garch', code: '600519' })).rejects.toThrow(
      '对数收益观测不足 60 条，无法拟合 GARCH',
    );
  });

  it('arima 默认不指定 d / pMax（交给实现定阶）', async () => {
    await analyzeTimeseries({ test: 'arima', code: '600519' });
    expect(mocks.fitArima.mock.calls[0][0]).toHaveLength(300);
    expect(mocks.fitArima.mock.calls[0][1]).toEqual({});
  });

  it.each([0, 1, 2])('arima 透传合法 d=%s', async (d) => {
    await analyzeTimeseries({ test: 'arima', code: '600519', options: { d } });
    expect(mocks.fitArima.mock.calls[0][1]).toEqual({ d });
  });

  it('arima 丢弃越界参数（d=3 / pMax=-1 / 非数字）', async () => {
    await analyzeTimeseries({ test: 'arima', code: '600519', options: { d: 3, pMax: -1 } });
    expect(mocks.fitArima.mock.calls[0][1]).toEqual({});

    await analyzeTimeseries({ test: 'arima', code: '600519', options: { d: '1', pMax: '5' } });
    expect(mocks.fitArima.mock.calls[1][1]).toEqual({});
  });

  it('arima 透传合法 pMax（含 0）', async () => {
    await analyzeTimeseries({ test: 'arima', code: '600519', options: { pMax: 0 } });
    expect(mocks.fitArima.mock.calls[0][1]).toEqual({ pMax: 0 });
  });
});

describe('analyzeTimeseries —— 双序列（coint / kalman-beta）', () => {
  it('第二条序列不足 60 条时报出是哪只', async () => {
    mocks.fetchOHLCVData.mockImplementation((code: string) =>
      Promise.resolve(code === '600519' ? makeKlines(300) : makeKlines(12)),
    );
    await expect(
      analyzeTimeseries({ test: 'coint', code: '600519', code2: '000001' }),
    ).rejects.toThrow('000001 的 K 线数据不足（12 条 < 60）');
  });

  it('按日期取交集：不重叠的区间明确报出对齐后的条数', async () => {
    mocks.fetchOHLCVData.mockImplementation((code: string) =>
      Promise.resolve(
        code === '600519'
          ? makeKlines(80, { startDate: '2024-01-01' })
          : makeKlines(80, { startDate: '2025-01-01' }),
      ),
    );
    await expect(
      analyzeTimeseries({ test: 'coint', code: '600519', code2: '000001' }),
    ).rejects.toThrow(/两序列按日期对齐后仅 \d+ 条（<60），日期范围可能不重叠/);
  });

  it('coint 输出二元 code、对齐后的窗口与漂移提示', async () => {
    const out = await analyzeTimeseries({ test: 'coint', code: '600519', code2: '000001' });

    expect(out.code).toEqual(['600519', '000001']);
    expect(out.test).toBe('coint');
    expect(out.note).toContain('协整结构可能随时间漂移');
    const [y, x] = mocks.engleGranger.mock.calls[0];
    expect(y).toHaveLength(300);
    expect(x).toHaveLength(300);
  });

  it('交集只保留两序列共有的日期（缺一天就丢一天）', async () => {
    const a = makeKlines(100, { startDate: '2024-01-01' });
    const b = makeKlines(100, { startDate: '2024-01-01' }).filter((_, i) => i !== 10);
    mocks.fetchOHLCVData.mockImplementation((code: string) =>
      Promise.resolve(code === '600519' ? a : b),
    );
    const out = await analyzeTimeseries({ test: 'coint', code: '600519', code2: '000001' });
    expect(out.window.n).toBe(99);
    expect(mocks.engleGranger.mock.calls[0][0]).toHaveLength(99);
  });

  it('kalman-beta 只回末端 60 天并标注截断（避免超大 payload）', async () => {
    const out = await analyzeTimeseries({ test: 'kalman-beta', code: '600519', code2: '000001' });
    const result = out.result as {
      intercept: number[];
      hedgeRatio: number[];
      oneStepErrors: number[];
      tailLength: number;
      truncated: boolean;
    };

    expect(result.tailLength).toBe(60);
    expect(result.truncated).toBe(true);
    expect(result.hedgeRatio).toHaveLength(60);
    expect(result.intercept).toHaveLength(60);
    expect(result.oneStepErrors).toHaveLength(60);
    // 保留的是末端而不是开头
    expect(result.hedgeRatio[59]).toBeCloseTo(1.99, 5);
    expect(out.note).toContain('β_t 为状态随时间漂移的在线估计');
  });

  it('序列本就不足 60 天时不标截断', async () => {
    mocks.timeVaryingBeta.mockReturnValue({
      intercept: [0.1, 0.2],
      hedgeRatio: [1, 1.1],
      oneStepErrors: [0.01, 0.02],
    });
    const out = await analyzeTimeseries({ test: 'kalman-beta', code: '600519', code2: '000001' });
    const result = out.result as { tailLength: number; truncated: boolean; hedgeRatio: number[] };
    expect(result.tailLength).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.hedgeRatio).toEqual([1, 1.1]);
  });

  it('kalman-beta 仅透传正的 qRatio', async () => {
    await analyzeTimeseries({
      test: 'kalman-beta',
      code: '600519',
      code2: '000001',
      options: { qRatio: 0.05 },
    });
    expect(mocks.timeVaryingBeta.mock.calls[0][2]).toEqual({ qRatio: 0.05 });

    await analyzeTimeseries({
      test: 'kalman-beta',
      code: '600519',
      code2: '000001',
      options: { qRatio: -1 },
    });
    expect(mocks.timeVaryingBeta.mock.calls[1][2]).toEqual({});
  });
});
