import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchJson } from '../../utils/http.js';
import { fetchQuarterlyFinancials, parseQuarterlyRecords } from '../quarterlyFinancials.js';

vi.mock('../../utils/http.js', () => ({ fetchJson: vi.fn() }));
const mockedFetchJson = vi.mocked(fetchJson);

/** 模拟 datacenter 返回行：货币字段为元、比率为百分比、缺失为 null/'-' */
function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    REPORT_DATE: '2026-06-30 00:00:00',
    NOTICE_DATE: '2026-08-15 00:00:00',
    TOTALOPERATEREVE: 92_278_072_083.21,
    PARENTNETPROFIT: 44_516_880_421.86,
    ROEJQ: 16.75,
    XSMLL: 89.56,
    ZCFZL: 15.19,
    TOTALOPERATEREVETZ: 1.3,
    PARENTNETPROFITTZ: -1.95,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(fetchJson).mockReset();
});

describe('parseQuarterlyRecords', () => {
  it('日期截断、元转亿元、同比为百分比口径', () => {
    const series = parseQuarterlyRecords([row({})], '600519');
    expect(series.code).toBe('600519');
    expect(series.source).toBe('eastmoney_f10');
    expect(series.reports).toHaveLength(1);
    const r = series.reports[0];
    expect(r.reportDate).toBe('2026-06-30');
    expect(r.noticeDate).toBe('2026-08-15');
    expect(r.revenue).toBeCloseTo(922.78, 1); // 元 → 亿元
    expect(r.netProfit).toBeCloseTo(445.17, 1);
    expect(r.roe).toBe(16.75);
    expect(r.revenueYoY).toBeCloseTo(1.3, 6);
    expect(r.netProfitYoY).toBeCloseTo(-1.95, 6);
  });

  it('输出按报告期升序；同报告期保留公告日较新的一行', () => {
    const series = parseQuarterlyRecords(
      [
        row({
          REPORT_DATE: '2026-06-30 00:00:00',
          NOTICE_DATE: '2026-08-15 00:00:00',
          ROEJQ: 16.75,
        }),
        row({ REPORT_DATE: '2026-03-31 00:00:00', NOTICE_DATE: '2026-04-22 00:00:00', ROEJQ: 8.1 }),
        // 同报告期的更正公告：公告日更新 → 保留这行
        row({ REPORT_DATE: '2026-03-31 00:00:00', NOTICE_DATE: '2026-05-01 00:00:00', ROEJQ: 8.3 }),
      ],
      '600519',
    );
    expect(series.reports.map((r) => r.reportDate)).toEqual(['2026-03-31', '2026-06-30']);
    expect(series.reports[0].roe).toBe(8.3);
  });

  it('缺失字段 → null（绝不洗成 0）；非法报告期行剔除', () => {
    const series = parseQuarterlyRecords(
      [
        row({ REPORT_DATE: 'garbage' }),
        row({
          REPORT_DATE: '2026-03-31 00:00:00',
          NOTICE_DATE: null,
          TOTALOPERATEREVE: null,
          ROEJQ: '-',
          PARENTNETPROFITTZ: null,
        }),
      ],
      '600519',
    );
    expect(series.reports).toHaveLength(1);
    const r = series.reports[0];
    expect(r.reportDate).toBe('2026-03-31');
    expect(r.noticeDate).toBeNull();
    expect(r.revenue).toBeNull();
    expect(r.roe).toBeNull();
    expect(r.netProfitYoY).toBeNull();
  });
});

describe('fetchQuarterlyFinancials', () => {
  it('组装 SECUCODE 过滤与条数上限并解析结果', async () => {
    mockedFetchJson.mockResolvedValue({
      result: { data: [row({}), row({ REPORT_DATE: '2026-03-31 00:00:00' })] },
    });
    const series = await fetchQuarterlyFinancials('600519', 8);
    const url = mockedFetchJson.mock.calls[0][0] as string;
    expect(url).toContain('SECUCODE="600519.SH"');
    expect(url).toContain('ps=8');
    expect(series.reports).toHaveLength(2);
  });

  it('深交所代码用 .SZ 后缀；limit 越界收敛到 [4, 40]', async () => {
    mockedFetchJson.mockResolvedValue({ result: { data: [row({})] } });
    await fetchQuarterlyFinancials('000858', 100);
    const url = mockedFetchJson.mock.calls[0][0] as string;
    expect(url).toContain('000858.SZ');
    expect(url).toContain('ps=40');
  });

  it('返回为空 → 抛错由调用方降级', async () => {
    mockedFetchJson.mockResolvedValue({ result: { data: [] } });
    await expect(fetchQuarterlyFinancials('600519')).rejects.toThrow('无法获取');
  });

  it('解析后无有效报告期 → 抛错', async () => {
    mockedFetchJson.mockResolvedValue({
      result: { data: [row({ REPORT_DATE: 'bad', ROEJQ: null, PARENTNETPROFITTZ: null })] },
    });
    await expect(fetchQuarterlyFinancials('600519')).rejects.toThrow('解析为空');
  });
});
