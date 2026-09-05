import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchOHLCVData, getBenchmarkCurve, marketOf, resolveSecid } from '../dataProvider.js';
import type { OHLCVData } from '../types.js';

/**
 * dataProvider 补充测试：覆盖 K 线拉取的缓存/解析/降级路径与基准曲线。
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录（dataProvider.ts 现支持 env 重定向），
 * 不再写真实 quant/cache，也不依赖 afterEach 删除（残留由 OS 清理，杜绝跨运行污染）。
 */
let CACHE_DIR = '';

const origCacheDir = process.env.DATA_CACHE_DIR;
beforeAll(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-quant-cache-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterAll(() => {
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/**
 * 用例专属的缓存键，避免与真实数据冲突。
 *
 * 缓存契约（2026-09-05 变更）：K 线**按 token 存合并后的完整历史**，文件名不再含
 * 日期区间。此前按 `{code}_{start}_{end}` 分片缓存，而截面/回测用的是滚动窗口
 * （end = 今天），导致每天为每只股票生成全新缓存文件并重拉全量历史——几百只
 * 全市场时这是主要瓶颈。现在：首次冷拉全量，之后每天只补拉尾部新增的几根。
 */
const klineCacheFile = (token: string) => path.join(CACHE_DIR, `kline_${token}.json`);

/** 按当前格式写缓存：{ data: { bars }, timestamp, ttlMs }（ttlMs 供 prune 逐文件判定） */
const writeKlineCache = (token: string, bars: OHLCVData[], ageMs = 0) =>
  fs.writeFileSync(
    klineCacheFile(token),
    JSON.stringify({
      data: { bars },
      timestamp: Date.now() - ageMs,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    }),
    'utf-8',
  );

describe('fetchOHLCVData — 合并历史缓存与增量补尾', () => {
  const code = '999001';
  const start = '2024-01-01';
  const end = '2024-01-31';

  afterEach(() => {
    fs.rmSync(klineCacheFile(code), { force: true });
    vi.restoreAllMocks();
  });

  it('区间被完整覆盖且缓存新鲜 → 零网络请求', async () => {
    const bars: OHLCVData[] = [
      { date: '2024-01-01', open: 10, close: 10.5, high: 11, low: 9.8, volume: 12345 },
      { date: '2024-01-31', open: 10, close: 11, high: 11.2, low: 9.9, volume: 22222 },
    ];
    writeKlineCache(code, bars);

    // spy 必须给 mock 实现：若缓存命中逻辑出 bug，call-through 会真发网络请求
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const result = await fetchOHLCVData(code, start, end);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual(bars);
  });

  it('滚动窗口次日只补拉尾部，不重拉全历史', async () => {
    // 缓存已覆盖至 2024-01-31（含一年前历史），次日请求 end 前移到 2024-02-01
    writeKlineCache(code, [
      { date: '2023-01-03', open: 1, close: 1, high: 1, low: 1, volume: 1 },
      { date: '2024-01-31', open: 10, close: 10.5, high: 11, low: 9.8, volume: 12345 },
    ]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: ['2024-02-01,10.5,11,11.5,10.4,999'] } }),
    } as Response);

    const result = await fetchOHLCVData(code, start, '2024-02-01');

    // 核心断言：请求起点应为缓存末端（增量），而非 startDate（全量重拉）
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('beg=20240131');
    expect(url).not.toContain('beg=20240101');

    // 合并后按请求区间切片：区间外的 2023 年历史被剔除，新增尾部在列
    expect(result.map((d) => d.date)).toEqual(['2024-01-31', '2024-02-01']);
    expect(result[1].close).toBe(11);
  });

  it('请求左边界早于缓存起点 → 从 startDate 拉取并合并', async () => {
    writeKlineCache(code, [
      { date: '2024-06-03', open: 10, close: 10.5, high: 11, low: 9.8, volume: 12345 },
    ]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        data: {
          klines: [
            '2023-06-01,1.00,1.10,1.20,0.90,100',
            '2024-06-03,10.00,10.50,11.00,9.80,123456',
          ],
        },
      }),
    } as Response);

    const result = await fetchOHLCVData(code, '2023-06-01', '2024-06-30');

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('beg=20230601');
    // 合并结果包含新拉到的早期历史
    expect(result[0].date).toBe('2023-06-01');
    expect(result.some((d) => d.date === '2024-06-03')).toBe(true);
  });

  it('缓存超出新鲜窗口 → 只补拉尾部，不丢弃已缓存的历史', async () => {
    // 写入于 13 小时前（超出 12h 新鲜窗口），但区间完整覆盖请求
    writeKlineCache(
      code,
      [
        { date: '2024-01-01', open: 10, close: 10.5, high: 11, low: 9.8, volume: 12345 },
        { date: '2024-01-31', open: 10, close: 10.8, high: 11, low: 9.8, volume: 12345 },
      ],
      13 * 60 * 60 * 1000,
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: ['2024-01-31,10.00,10.80,11.00,9.80,12345'] } }),
    } as Response);

    const result = await fetchOHLCVData(code, start, end);

    // 过期只触发尾部补拉（beg = 缓存末端），而非从 startDate 全量重拉
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('beg=20240131');
    expect(result.length).toBe(2);
  });

  it('同日重复数据以新值覆盖（容纳当日盘中修订）', async () => {
    writeKlineCache(code, [
      { date: '2024-01-02', open: 10, close: 10.5, high: 11, low: 9.8, volume: 12345 },
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: ['2024-01-02,10.00,99.99,100.00,9.80,777'] } }),
    } as Response);

    const result = await fetchOHLCVData(code, start, end);
    expect(result).toHaveLength(1);
    expect(result[0].close).toBe(99.99);
  });
});

describe('fetchOHLCVData — 网络解析与降级', () => {
  const code = '999002';
  const start = '2024-03-01';
  const end = '2024-03-29';

  beforeEach(() => {
    // 降级用例必须处于「无缓存」冷启动状态：按新策略，已缓存的真实历史优先于
    // 模拟数据（真实的部分数据比模拟噪声更有价值），有缓存就不会走模拟降级。
    fs.rmSync(klineCacheFile(code), { force: true });
  });
  afterEach(() => {
    fs.rmSync(klineCacheFile(code), { force: true });
    vi.restoreAllMocks();
  });

  it('解析东财 klines 文本行（date,open,close,high,low,volume）并写入缓存', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        data: {
          klines: [
            '2024-03-01,10.00,10.50,11.00,9.80,123456',
            '2024-03-04,10.50,10.20,10.80,10.10,234567',
          ],
        },
      }),
    } as Response);

    const result = await fetchOHLCVData(code, start, end);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      date: '2024-03-01',
      open: 10,
      close: 10.5,
      high: 11,
      low: 9.8,
      volume: 123456,
    });
    // 真实数据不带模拟标记
    expect(result[0].isSimulated).toBeUndefined();
    // 成功路径按新格式写缓存（合并历史 + ttlMs，供 prune 逐文件判定）
    const raw = JSON.parse(fs.readFileSync(klineCacheFile(code), 'utf-8')) as {
      data: { bars: OHLCVData[] };
      ttlMs: number;
    };
    expect(raw.data.bars).toHaveLength(2);
    expect(typeof raw.ttlMs).toBe('number');
  });

  it('网络失败降级为确定性模拟数据（isSimulated=true，跳过周末）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await fetchOHLCVData(code, start, end);
    expect(result.length).toBeGreaterThan(0);
    for (const d of result) {
      expect(d.isSimulated).toBe(true);
      expect(d.high).toBeGreaterThanOrEqual(d.low);
      // 不含周末
      const day = new Date(d.date).getDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
    }
  });

  it('模拟数据对同一代码/区间是确定性的（两次调用结果一致）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const first = await fetchOHLCVData(code, start, end);
    const second = await fetchOHLCVData(code, start, end);
    expect(second).toEqual(first);
  });

  it('响应缺少 klines 字段时同样降级为模拟数据', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: {} }),
    } as Response);
    const result = await fetchOHLCVData(code, start, end);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].isSimulated).toBe(true);
  });

  it('API 可达但 klines 为空数组 → 返回空结果，不降级为模拟、不写缓存', async () => {
    // 与「网络失败」严格区分：上游明确返回空（如退市/无数据）时，
    // 交由上层按「无法获取 K 线数据」处理，而不是用模拟数据伪装成功。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: [] } }),
    } as Response);
    const result = await fetchOHLCVData(code, start, end);
    expect(result).toEqual([]);
    expect(fs.existsSync(klineCacheFile(code))).toBe(false);
  });

  it('已有真实缓存但补拉失败 → 返回真实的部分历史，不降级为模拟', async () => {
    writeKlineCache(code, [
      { date: '2024-03-01', open: 10, close: 10.5, high: 11, low: 9.8, volume: 12345 },
    ]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await fetchOHLCVData(code, start, end);
    expect(result.length).toBeGreaterThan(0);
    // 真实数据优先于模拟噪声：不带 isSimulated 标记
    expect(result[0].isSimulated).toBeUndefined();
    expect(result[0].date).toBe('2024-03-01');
  });

  it('模拟降级数据不写入缓存（避免污染真实历史）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await fetchOHLCVData(code, start, end);
    expect(fs.existsSync(klineCacheFile(code))).toBe(false);
  });
});

describe('getBenchmarkCurve — 买入持有基准', () => {
  it('空数据返回空数组', () => {
    expect(getBenchmarkCurve([])).toEqual([]);
  });

  it('以首日收盘归一化为 100，保留两位小数', () => {
    const data: OHLCVData[] = [
      { date: '2024-01-02', open: 10, close: 10, high: 10, low: 10, volume: 1 },
      { date: '2024-01-03', open: 10, close: 11, high: 11, low: 10, volume: 1 },
      { date: '2024-01-04', open: 11, close: 9.5, high: 11, low: 9, volume: 1 },
    ];
    const curve = getBenchmarkCurve(data);
    expect(curve.map((p) => p.value)).toEqual([100, 110, 95]);
    expect(curve[0].date).toBe('2024-01-02');
  });
});

describe('marketOf / resolveSecid — 边界情况', () => {
  it('带空白的代码先 trim', () => {
    expect(marketOf(' 600519 ')).toBe('A');
    expect(resolveSecid(' 600519 ')).toBe('1.600519');
  });

  it('无法识别的代码回退为 A 股处理', () => {
    expect(marketOf('12')).toBe('A');
    expect(marketOf('1234567')).toBe('A');
    expect(resolveSecid('1234567')).toBe('0.1234567');
  });
});
