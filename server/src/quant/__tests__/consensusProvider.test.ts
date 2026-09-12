import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchConsensusSnapshot, formatConsensusBrief } from '../consensusProvider.js';

/**
 * 机构一致预期快照单测：盈利预测/北向持股解析（字段口径以 2026-09-12 真实响应
 * 为准）、快照无数据 → null、北向失败不拖垮盈利预测、LLM 语境块格式化。
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录。
 */

let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
const origTtl = process.env.QUANT_CONSENSUS_CACHE_TTL_HOURS;

beforeEach(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-consensus-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
  delete process.env.QUANT_CONSENSUS_CACHE_TTL_HOURS;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (origTtl === undefined) delete process.env.QUANT_CONSENSUS_CACHE_TTL_HOURS;
  else process.env.QUANT_CONSENSUS_CACHE_TTL_HOURS = origTtl;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/** 东财 datacenter v1/get 响应体 */
function dcBody(rows: Record<string, unknown>[]) {
  return {
    json: async () => ({ success: true, result: { pages: 1, count: rows.length, data: rows } }),
  } as unknown as Response;
}

/** 真实响应裁剪（RPT_WEB_RESPREDICT @600519，2026-09-12） */
const PREDICT_ROWS = [
  {
    SECUCODE: '600519.SH',
    SECURITY_CODE: '600519',
    SECURITY_NAME_ABBR: '贵州茅台',
    RATING_ORG_NUM: 45,
    RATING_BUY_NUM: 36,
    RATING_ADD_NUM: 9,
    RATING_NEUTRAL_NUM: null,
    RATING_REDUCE_NUM: null,
    RATING_SALE_NUM: null,
    YEAR1: 2025,
    YEAR_MARK1: 'A',
    EPS1: 65.851754826108,
    YEAR2: 2026,
    YEAR_MARK2: 'E',
    EPS2: 67.656739130435,
    YEAR3: 2027,
    YEAR_MARK3: 'E',
    EPS3: 77.2,
    DEC_AIMPRICEMAX: 1800.5,
    DEC_AIMPRICEMIN: 1500.2,
  },
];

/** 真实响应裁剪（RPT_MUTUAL_HOLDSTOCKNORTH_STA @600519） */
const NORTH_ROWS = [
  {
    SECUCODE: '600519.SH',
    TRADE_DATE: '2026-06-30 00:00:00',
    SECURITY_CODE: '600519',
    SECURITY_NAME: '贵州茅台',
    MUTUAL_TYPE: '001',
    HOLD_SHARES: 53711656,
    HOLD_MARKET_CAP: 63674631071.44,
    HOLD_SHARES_RATIO: 4.29,
  },
];

describe('fetchConsensusSnapshot — 快照解析', () => {
  it('解析评级分布 / A-E 年度 EPS / 目标价 / 北向持股', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async (url) => {
      const u = String(url);
      return dcBody(u.includes('RESPREDICT') ? PREDICT_ROWS : NORTH_ROWS);
    });
    const snap = await fetchConsensusSnapshot('600519');
    expect(snap).not.toBeNull();
    expect(snap!.orgNum).toBe(45);
    expect(snap!.ratings).toEqual({
      buy: 36,
      add: 9,
      neutral: null,
      reduce: null,
      sale: null,
    });
    expect(snap!.forecasts).toEqual([
      { year: 2025, eps: 65.851754826108, mark: 'A' },
      { year: 2026, eps: 67.656739130435, mark: 'E' },
      { year: 2027, eps: 77.2, mark: 'E' },
    ]);
    expect(snap!.targetPriceMax).toBe(1800.5);
    expect(snap!.north?.holdSharesRatio).toBe(4.29);
    expect(snap!.north?.date).toBe('2026-06-30');
  });

  it('无研报覆盖 → null；北向失败只缺 north 字段', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ success: false, code: 9201, message: '返回数据为空' }),
    } as unknown as Response);
    expect(await fetchConsensusSnapshot('600000')).toBeNull();

    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('RESPREDICT')) return dcBody(PREDICT_ROWS);
      throw new Error('north source down');
    });
    const snap = await fetchConsensusSnapshot('600519');
    expect(snap).not.toBeNull();
    expect(snap!.north).toBeUndefined();
  });
});

describe('formatConsensusBrief — LLM 语境块', () => {
  it('呈现覆盖机构/评级/预测/目标价/北向，且明示快照口径', () => {
    const brief = formatConsensusBrief({
      code: '600519',
      orgNum: 45,
      ratings: { buy: 36, add: 9, neutral: null, reduce: null, sale: null },
      forecasts: [
        { year: 2025, eps: 65.85, mark: 'A' },
        { year: 2026, eps: 67.66, mark: 'E' },
      ],
      targetPriceMax: 1800.5,
      targetPriceMin: 1500.2,
      north: { date: '2026-06-30', holdSharesRatio: 4.29, holdMarketCap: 63674631071.44 },
    });
    expect(brief).toContain('【机构一致预期（当前快照，非时点序列）】');
    expect(brief).toContain('覆盖机构 45 家（买入36、增持9）');
    expect(brief).toContain('2026E 67.66元');
    expect(brief).toContain('目标价区间 1500.2 ~ 1800.5 元');
    expect(brief).toContain('北向持股（2026-06-30 季度披露）：占流通股比 4.29%，市值 636.7 亿');
    // 实际年份（A）不进「预测」行
    expect(brief).not.toContain('2025E');
  });

  it('字段缺失时安静省略（无评级/无北向/无目标价不出哑行）', () => {
    const brief = formatConsensusBrief({
      code: '600000',
      orgNum: 3,
      ratings: { buy: null, add: null, neutral: null, reduce: null, sale: null },
      forecasts: [],
      targetPriceMax: null,
      targetPriceMin: null,
    });
    expect(brief).toContain('覆盖机构 3 家。');
    expect(brief).not.toContain('EPS 预测');
    expect(brief).not.toContain('目标价区间');
    expect(brief).not.toContain('北向持股');
  });
});
