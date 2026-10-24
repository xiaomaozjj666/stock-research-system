import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../../utils/logger.js';
import { fetchOHLCVData } from '../dataProvider.js';
import type { OHLCVData } from '../types.js';

/**
 * 深度审查缺陷修复的防御性测试（dataProvider 侧）：
 * - H2：前复权缓存增量补尾的基准一致性校验（除权 → 两个复权基准混用 → 假跳空）
 * - H3①：解析层行级脏数据防御（close=0/NaN/Infinity 的行丢弃并告警）
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录（与 dataProvider.extra.test.ts 同模式）。
 */
let CACHE_DIR = '';

const origCacheDir = process.env.DATA_CACHE_DIR;
beforeAll(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-quant-fixes-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterAll(() => {
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

const klineCacheFile = (token: string) => path.join(CACHE_DIR, `kline_${token}.json`);

describe('H2：前复权基准一致性校验（增量补尾后校验重叠段）', () => {
  const code = '999003'; // 6 位数字 → A 股通道（secid 0.999003）

  beforeEach(() => {
    fs.rmSync(klineCacheFile(code), { force: true });
  });
  afterEach(() => {
    fs.rmSync(klineCacheFile(code), { force: true });
    vi.restoreAllMocks();
  });

  it('除权后增量补尾检测到重叠段基准漂移 → 放弃缓存全量重拉，合并结果无假跳空', async () => {
    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        // 冷启动全量：旧复权基准（除权前，价格 ~10）
        return {
          json: async () => ({
            data: {
              klines: [
                '2024-01-01,10.00,10.00,10.10,9.90,1000',
                '2024-01-02,10.20,10.20,10.30,10.10,1000',
              ],
            },
          }),
        } as Response;
      }
      if (call === 2) {
        // 次日尾部增量：新复权基准（除权后整体减半，重叠日 01-02 从 10.20 变 5.10）
        return {
          json: async () => ({
            data: {
              klines: [
                '2024-01-02,5.10,5.10,5.15,5.05,1000',
                '2024-01-08,5.20,5.20,5.25,5.15,1000',
              ],
            },
          }),
        } as Response;
      }
      // 第 3 次：全量重拉（fetchStart 移到缓存最早日期）→ 完整新基准
      return {
        json: async () => ({
          data: {
            klines: [
              '2024-01-01,5.00,5.00,5.05,4.95,1000',
              '2024-01-02,5.10,5.10,5.15,5.05,1000',
              '2024-01-08,5.20,5.20,5.25,5.15,1000',
            ],
          },
        }),
      } as Response;
    });

    // 第一次：冷启动全量（旧基准），写缓存
    await fetchOHLCVData(code, '2024-01-01', '2024-01-02');
    // 第二次：end 前移 → 尾部增量 → 重叠段 50% 漂移 → 触发全量重拉
    const result = await fetchOHLCVData(code, '2024-01-01', '2024-01-08');

    // 触发了全量重拉：共 3 次网络调用；第 2 次为增量（beg=缓存末端），
    // 第 3 次 beg 移到缓存最早日期（2024-01-01），而非沿用缓存
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[1][0])).toContain('beg=20240102');
    expect(String(fetchSpy.mock.calls[2][0])).toContain('beg=20240101');
    expect(String(fetchSpy.mock.calls[2][0])).toContain('end=20240108');

    // 合并结果：整段同为新基准，相邻日无 >10% 假跳空
    //（未修复时旧缓存 01-01 close=10 与新尾部 01-02 close=5.10 直接混合 → -49% 假跳空）
    expect(result.map((d) => d.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-08']);
    expect(result.map((d) => d.close)).toEqual([5, 5.1, 5.2]);
    for (let i = 1; i < result.length; i++) {
      const change = Math.abs(result[i].close / result[i - 1].close - 1);
      expect(change).toBeLessThan(0.1);
    }

    // 全量重拉成功后缓存已整体切换为新基准（旧基准不残留）
    const cached = JSON.parse(fs.readFileSync(klineCacheFile(code), 'utf-8')) as {
      data: { bars: OHLCVData[] };
    };
    expect(cached.data.bars.map((b) => b.close)).toEqual([5, 5.1, 5.2]);
  });

  it('全量重拉失败（网络错误）→ 返回已有数据并告警 staleAdjustment，缓存不被混合基准污染', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          json: async () => ({
            data: {
              klines: [
                '2024-01-01,10.00,10.00,10.10,9.90,1000',
                '2024-01-02,10.20,10.20,10.30,10.10,1000',
              ],
            },
          }),
        } as Response;
      }
      if (call === 2) {
        return {
          json: async () => ({
            data: {
              klines: [
                '2024-01-02,5.10,5.10,5.15,5.05,1000',
                '2024-01-08,5.20,5.20,5.25,5.15,1000',
              ],
            },
          }),
        } as Response;
      }
      // 第 3 次（全量重拉）网络失败
      throw new Error('refetch down');
    });

    await fetchOHLCVData(code, '2024-01-01', '2024-01-02');
    const result = await fetchOHLCVData(code, '2024-01-01', '2024-01-08');

    expect(fetchSpyCallCount()).toBe(3);
    // 返回已有的合并数据（真实数据优于报错：01-01 仍为旧基准 10，01-02 起为新基准 5.10）
    expect(result.map((d) => d.close)).toEqual([10, 5.1, 5.2]);
    // 以 staleAdjustment 关键词告警标注（决策：不改 OHLCVData[] 返回结构，logger.warning 为最小侵入方案）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('staleAdjustment'),
      expect.objectContaining({ secid: '0.999003' }),
    );
    // 缓存不被混合基准固化（下次请求仍会重试全量重拉）
    const cached = JSON.parse(fs.readFileSync(klineCacheFile(code), 'utf-8')) as {
      data: { bars: OHLCVData[] };
    };
    expect(cached.data.bars.map((b) => b.close)).toEqual([10, 10.2]);

    function fetchSpyCallCount(): number {
      return vi.mocked(globalThis.fetch).mock.calls.length;
    }
  });

  it('无除权（重叠段价格一致）→ 增量路径不变：仅 1 次补尾 fetch，不触发重拉', async () => {
    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          json: async () => ({
            data: {
              klines: [
                '2024-01-01,10.00,10.00,10.10,9.90,1000',
                '2024-01-02,10.20,10.20,10.30,10.10,1000',
              ],
            },
          }),
        } as Response;
      }
      // 尾部增量：重叠日 01-02 价格一致（同一复权基准）
      return {
        json: async () => ({
          data: {
            klines: [
              '2024-01-02,10.20,10.20,10.30,10.10,1000',
              '2024-01-08,10.30,10.30,10.40,10.20,1000',
            ],
          },
        }),
      } as Response;
    });

    await fetchOHLCVData(code, '2024-01-01', '2024-01-02');
    const result = await fetchOHLCVData(code, '2024-01-01', '2024-01-08');

    // 校验为纯本地比对：fetch 次数与无校验时完全一致（1 次冷启动 + 1 次增量补尾）
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain('beg=20240102');
    expect(result.map((d) => d.close)).toEqual([10, 10.2, 10.3]);
  });

  it('重叠段小幅盘中修订（<1% 阈值）→ 不误判为除权，正常增量合并', async () => {
    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          json: async () => ({ data: { klines: ['2024-01-02,10.00,10.50,11.00,9.80,12345'] } }),
        } as Response;
      }
      // 重叠日修订 10.50 → 10.52（偏差 0.19% < 1%）：盘中修订语义，非除权
      return {
        json: async () => ({
          data: {
            klines: [
              '2024-01-02,10.00,10.52,11.00,9.80,777',
              '2024-01-03,10.60,10.60,10.70,10.50,888',
            ],
          },
        }),
      } as Response;
    });

    await fetchOHLCVData(code, '2024-01-02', '2024-01-02');
    const result = await fetchOHLCVData(code, '2024-01-02', '2024-01-03');

    expect(fetchSpy).toHaveBeenCalledTimes(2); // 不触发第 3 次全量重拉
    expect(result.map((d) => d.close)).toEqual([10.52, 10.6]); // 新值覆盖旧值
  });
});

describe('H3①：解析层行级脏数据防御（畸形行丢弃并告警）', () => {
  const code = '999004';

  beforeEach(() => {
    fs.rmSync(klineCacheFile(code), { force: true });
  });
  afterEach(() => {
    fs.rmSync(klineCacheFile(code), { force: true });
    vi.restoreAllMocks();
  });

  it('close=0 / NaN / Infinity 的畸形行被丢弃并告警计数，正常行保留', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        data: {
          klines: [
            '2024-03-01,10.00,10.50,11.00,9.80,123456', // 正常行
            '2024-03-04,10.50,0,10.80,10.10,234567', // close=0 → 丢弃（旧行为：Infinity 动量假信号）
            '2024-03-05,abc,def,ghi,jkl,100', // parseFloat → NaN → 丢弃（旧行为：权益曲线被污染）
            '2024-03-06,Infinity,10.60,10.70,10.50,100', // open=Infinity → 丢弃
            '2024-03-07,10.60,10.70,10.80,10.50,100', // 正常行
          ],
        },
      }),
    } as Response);

    const result = await fetchOHLCVData(code, '2024-03-01', '2024-03-31');

    expect(result.map((d) => d.date)).toEqual(['2024-03-01', '2024-03-07']);
    expect(result[0].close).toBe(10.5);
    expect(result[1].close).toBe(10.7);
    // 丢弃计数聚合告警（3 行畸形）
    expect(warnSpy).toHaveBeenCalledWith(
      'K线存在畸形行（非有限价格/量或 close≤0），已丢弃',
      expect.objectContaining({ dropped: 3 }),
    );
    // 全部行均畸形 → 返回空（不降级为模拟数据：klines 字段存在且可达）
    // —— 用另一 token 验证
    const code2 = '999005';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: ['2024-03-01,0,0,0,0,0'] } }),
    } as Response);
    const empty = await fetchOHLCVData(code2, '2024-03-01', '2024-03-31');
    expect(empty).toEqual([]);
    expect(empty.every((d) => d.isSimulated === undefined)).toBe(true);
    fs.rmSync(klineCacheFile(code2), { force: true });
  });
});
