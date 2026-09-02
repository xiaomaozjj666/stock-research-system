/**
 * computeCompositeAlphaForStrategy 单元测试：mock fetch 返回合法 K 线 → 结构正确；
 * fetch 抛错 → 优雅降级（基准不可用但组合仍算出）；空 K 线 → 抛「无法获取」。
 * 经由 DATA_CACHE_DIR 重定向到临时目录，避免写真实 quant/cache。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCompositeAlphaForStrategy,
  computeCompositeAlphaBatch,
} from '../compositeService.js';

let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
// 每个测试独立缓存目录：避免测试间 K 线缓存串扰（mock 解析结果被后续测试命中）
beforeEach(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-composite-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/** 生成 n 根 K 线（date,open=close=high=low,volume），确定性波动 */
function genKlines(n: number, start = '2024-01-01'): string[] {
  const out: string[] = [];
  const d = new Date(start);
  let close = 100;
  for (let i = 0; i < n; i++) {
    close *= 1 + 0.004 * Math.sin(i * 0.3) + 0.001;
    const date = new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    out.push(`${date},${close},${close},${close},${close},1000000`);
  }
  return out;
}

describe('computeCompositeAlphaForStrategy — 结构与降级', () => {
  it('合法 K 线 → 返回完整结构（市场/基准/组合 alpha/逐因子预测力）', async () => {
    const klines = genKlines(400);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines } }),
      ok: true,
    } as unknown as Response);

    const r = await computeCompositeAlphaForStrategy(
      '600519',
      '2024-01-01',
      '2025-03-01',
      [21, 63],
    );
    expect(r.market).toBe('A');
    expect(r.benchmarkSecid).toBe('1.000300');
    expect(r.bars).toBe(400);
    expect(r.horizons).toEqual([21, 63]);
    expect(r.compositeAlpha.horizons).toHaveLength(2);
    expect(r.factorPredictability).toHaveLength(11);
    // 指数与股票同序列（mock 忽略 secid）→ 基准对齐率 100%，可用
    expect(r.benchmarkAvailable).toBe(true);
    expect(['up', 'down', 'neutral']).toContain(r.compositeAlpha.overallDirection);
    expect(typeof r.compositeAlpha.hasSignal).toBe('boolean');
  });

  it('美股代码 → market=US、基准=100.SPX', async () => {
    const klines = genKlines(400);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines } }),
      ok: true,
    } as unknown as Response);

    const r = await computeCompositeAlphaForStrategy('AAPL', '2024-01-01', '2025-03-01');
    expect(r.market).toBe('US');
    expect(r.benchmarkSecid).toBe('100.SPX');
    expect(r.factorPredictability).toHaveLength(11);
  });

  it('基准拉取抛错 → 优雅降级（benchmarkAvailable=false，组合仍算出）', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'));
    const r = await computeCompositeAlphaForStrategy('600519', '2024-01-01', '2025-03-01');
    expect(r.benchmarkAvailable).toBe(false);
    expect(r.compositeAlpha.horizons).toHaveLength(2);
    expect(r.factorPredictability).toHaveLength(11);
  });

  it('空 K 线 → 抛「无法获取 K 线数据」', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: [] } }),
      ok: true,
    } as unknown as Response);
    await expect(
      computeCompositeAlphaForStrategy('600519', '2024-01-01', '2025-03-01'),
    ).rejects.toThrow(/无法获取/);
  });
});

describe('computeCompositeAlphaBatch — 批量测算', () => {
  /** 按 URL 区分代码：含 999999 的代码返回空 K 线（模拟该只拉不到数据） */
  function mockPerCodeFetch() {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const empty = url.includes('999999');
      return {
        json: async () => ({ data: { klines: empty ? [] : genKlines(400) } }),
        ok: true,
      } as unknown as Response;
    });
  }

  it('多只全部成功 → 计数正确、结果按输入顺序返回', async () => {
    mockPerCodeFetch();
    const r = await computeCompositeAlphaBatch(
      ['600519', 'AAPL', '00700'],
      '2024-01-01',
      '2025-03-01',
      [21, 63],
    );
    expect(r.requested).toBe(3);
    expect(r.succeeded).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.items.map((it) => it.stockCode)).toEqual(['600519', 'AAPL', '00700']);
    for (const it of r.items) {
      expect(it.ok).toBe(true);
      if (it.ok) {
        expect(it.result.compositeAlpha.horizons).toHaveLength(2);
        expect(it.result.factorPredictability).toHaveLength(11);
      }
    }
    // 公共参数回显
    expect(r.startDate).toBe('2024-01-01');
    expect(r.endDate).toBe('2025-03-01');
    expect(r.horizons).toEqual([21, 63]);
  });

  it('重复代码去重（按首次出现顺序），不重复请求', async () => {
    const spy = mockPerCodeFetch();
    const r = await computeCompositeAlphaBatch(
      ['600519', '00700', '600519'],
      '2024-01-01',
      '2025-03-01',
    );
    expect(r.requested).toBe(2);
    expect(r.items.map((it) => it.stockCode)).toEqual(['600519', '00700']);
    // 每只：K 线 + 基准 = 2 次请求；两只共 4 次（去重后不额外请求）
    expect(spy.mock.calls.length).toBe(4);
  });

  it('单只失败只标记该项，不拖垮整批', async () => {
    mockPerCodeFetch();
    const r = await computeCompositeAlphaBatch(
      ['600519', '999999', 'AAPL'],
      '2024-01-01',
      '2025-03-01',
    );
    expect(r.requested).toBe(3);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(1);
    // 顺序仍按输入：失败项落在第 2 位
    const [first, second, third] = r.items;
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/无法获取/);
    expect(third.ok).toBe(true);
  });

  it('空代码数组 → 返回空结果，不抛错', async () => {
    const r = await computeCompositeAlphaBatch([], '2024-01-01', '2025-03-01');
    expect(r.requested).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.succeeded).toBe(0);
    expect(r.failed).toBe(0);
  });

  it('全部代码空白/无效 → requested=0（过滤后为空）', async () => {
    const r = await computeCompositeAlphaBatch(['  ', ''], '2024-01-01', '2025-03-01');
    expect(r.requested).toBe(0);
    expect(r.items).toEqual([]);
  });
});
