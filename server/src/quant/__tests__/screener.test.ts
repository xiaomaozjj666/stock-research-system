import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadStockMaster } from '../../services/stockMaster.js';
import { fetchOHLCVData } from '../../quant/dataProvider.js';
import { runMarketScreener, readLatestScreenerRun } from '../screener.js';
import type { OHLCVData } from '../../quant/types.js';

vi.mock('../../services/stockMaster.js', () => ({ loadStockMaster: vi.fn() }));
vi.mock('../../quant/dataProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../quant/dataProvider.js')>();
  return { ...actual, fetchOHLCVData: vi.fn() };
});

const mockedMaster = vi.mocked(loadStockMaster);
const mockedBars = vi.mocked(fetchOHLCVData);

const RESULT_FILE = path.join(os.tmpdir(), `screener-test-${process.pid}.json`);

/** 造一段「横盘 60 根 + 放量阳线突破新高」的 K 线（满足 ≥60 根的入选门槛） */
function breakoutBars(): OHLCVData[] {
  const bars = Array.from({ length: 60 }, (_, i) => ({
    date: `2025-11-${String(i + 1).padStart(2, '0')}`,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 1000,
  }));
  bars.push({
    date: '2026-01-15',
    open: 10.2,
    high: 11,
    low: 10.1,
    close: 11,
    volume: 2500,
  });
  return bars;
}

function flatBars(): OHLCVData[] {
  return Array.from({ length: 60 }, (_, i) => ({
    date: `2025-11-${String(i + 1).padStart(2, '0')}`,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 1000,
  }));
}

beforeEach(() => {
  process.env.QUANT_SCREENER_FILE = RESULT_FILE;
  if (fs.existsSync(RESULT_FILE)) fs.rmSync(RESULT_FILE, { force: true });
  mockedMaster.mockResolvedValue([
    { code: '600001', name: '突破股' },
    { code: '600002', name: '横盘股' },
    { code: '600003', name: '坏数据股' },
  ] as never);
  mockedBars.mockReset();
});

describe('runMarketScreener — 全市场初筛', () => {
  it('形态触发进命中、横盘股无命中、坏数据计入 failed', async () => {
    mockedBars.mockImplementation(async (code: string) => {
      if (code === '600001') return breakoutBars();
      if (code === '600002') return flatBars();
      return []; // 600003：拉不到 K 线
    });
    const result = await runMarketScreener({ maxStocks: 3 });
    expect(result.scanned).toBe(3);
    expect(result.eligible).toBe(2);
    expect(result.failed).toBe(1);
    expect(
      result.hits.some((h) => h.code === '600001' && h.strategy === 'pat_turtle_breakout'),
    ).toBe(true);
    expect(result.hits.some((h) => h.code === '600002')).toBe(false);
    expect(result.strategies).toContain('rps_250');
    expect(fs.existsSync(RESULT_FILE)).toBe(true);
  });

  it('结果落盘后可经 readLatestScreenerRun 读回', async () => {
    mockedBars.mockImplementation(async () => breakoutBars());
    await runMarketScreener({ maxStocks: 1 });
    const latest = readLatestScreenerRun();
    expect(latest).not.toBeNull();
    expect(latest!.hits.length).toBeGreaterThan(0);
    expect(latest!.at).toBeTruthy();
  });

  it('RPS：250 日收益最高的股票获得 rps_250 命中（分位需 ≥10 只样本）', async () => {
    // 600001 缓涨 20%（宇宙内最强），其余 10 只横盘 → 共 11 只，满足分位样本要求
    const riser = Array.from({ length: 60 }, (_, i) => ({
      date: `2025-11-${String(i + 1).padStart(2, '0')}`,
      open: 10,
      high: 10,
      low: 10,
      close: 10 * (1 + (i / 59) * 0.2),
      volume: 1000,
    }));
    mockedMaster.mockResolvedValue(
      Array.from({ length: 11 }, (_, i) => ({
        code: i === 0 ? '600001' : `6001${String(i).padStart(2, '0')}`,
        name: `股${i}`,
      })) as never,
    );
    mockedBars.mockImplementation(async (code: string) => (code === '600001' ? riser : flatBars()));
    const result = await runMarketScreener({ maxStocks: 11 });
    expect(result.hits.some((h) => h.code === '600001' && h.strategy === 'rps_250')).toBe(true);
    // 横盘股不应获得 RPS 命中（收益 0 低于 87 分位阈值——11 只里阈值为 0，仅严格高于者命中）
    expect(result.hits.filter((h) => h.strategy === 'rps_250')).toHaveLength(1);
  });
});

describe('readLatestScreenerRun — 边界', () => {
  it('从未跑过 → null', () => {
    expect(readLatestScreenerRun()).toBeNull();
  });
});
