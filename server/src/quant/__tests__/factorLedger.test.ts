import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordFactorExperiments,
  listFactorExperiments,
  summarizeFactorExperiments,
  clearFactorExperiments,
  resetFactorLedgerCache,
  type FactorExperimentInput,
} from '../factorLedger.js';

const LEDGER_FILE = path.join(os.tmpdir(), `factor-ledger-test-${process.pid}.json`);

function entry(over: Partial<FactorExperimentInput> = {}): FactorExperimentInput {
  return {
    source: 'expression',
    name: 'cs_test',
    universe: { requested: 6, included: 6, board: 'BK0475' },
    horizon: 21,
    sampleSize: 400,
    icMean: 0.05,
    pValue: 0.01,
    oosStable: true,
    kept: true,
    ...over,
  };
}

beforeAll(() => {
  process.env.FACTOR_LEDGER_FILE = LEDGER_FILE;
});

beforeEach(() => {
  clearFactorExperiments();
});

describe('因子实验台账', () => {
  it('同毫秒写入也保持"新在前"（相等键的比较器必须返回 0）', () => {
    // 回归：比较器原为 a.createdAt < b.createdAt ? 1 : -1，相等键两个方向都返回 -1，
    // 违反排序契约。改进台账那边因此被 CI 抓出「本地绿、CI 红」（2026-09-19），
    // 此处的写法同源。顺序还直接决定改进循环「较早 70% 训练 / 较新 30% 验证」的切分，
    // 不确定就等于每轮拿到的训练/验证集都在变。用 5 条而非 2 条：元素太少时排序算法
    // 可能恰好保住原序，测不出病态比较器。
    const same = new Date().toISOString();
    const items = ['e', 'd', 'c', 'b', 'a'].map((v) => ({
      ...entry({ name: v }),
      id: v,
      createdAt: same,
    }));
    fs.writeFileSync(LEDGER_FILE, JSON.stringify({ items }), 'utf-8');
    resetFactorLedgerCache();
    expect(listFactorExperiments().map((i) => i.name)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('批量记录并返回写入条目（含 id 与时间戳）', () => {
    const added = recordFactorExperiments([entry(), entry({ name: 'cs_other', kept: false })]);
    expect(added).toHaveLength(2);
    expect(added[0].id).toBeTruthy();
    expect(added[0].createdAt).toBeTruthy();
    expect(fs.existsSync(LEDGER_FILE)).toBe(true);
  });

  it('空输入不写盘', () => {
    expect(recordFactorExperiments([])).toEqual([]);
    expect(listFactorExperiments()).toEqual([]);
  });

  it('列表按时间倒序（后记录的在前）', () => {
    recordFactorExperiments([entry({ name: 'first' })]);
    recordFactorExperiments([entry({ name: 'second' })]);
    const items = listFactorExperiments();
    expect(items.length).toBe(2);
    expect(items[0].createdAt >= items[1].createdAt).toBe(true);
  });

  it('按来源与采信状态过滤', () => {
    recordFactorExperiments([
      entry({ source: 'cross-section', kept: true }),
      entry({ source: 'expression', kept: false }),
      entry({ source: 'hypothesis', kept: true }),
    ]);
    expect(listFactorExperiments({ source: 'expression' })).toHaveLength(1);
    expect(listFactorExperiments({ kept: true })).toHaveLength(2);
    expect(listFactorExperiments({ source: 'cross-section', kept: false })).toHaveLength(0);
  });

  it('limit 截断', () => {
    recordFactorExperiments([entry(), entry(), entry()]);
    expect(listFactorExperiments({ limit: 2 })).toHaveLength(2);
  });

  it('汇总：总量、采信数、按来源分组', () => {
    recordFactorExperiments([
      entry({ source: 'expression', kept: true }),
      entry({ source: 'expression', kept: false }),
      entry({ source: 'hypothesis', kept: true }),
    ]);
    const s = summarizeFactorExperiments();
    expect(s.total).toBe(3);
    expect(s.kept).toBe(2);
    expect(s.bySource).toEqual({ expression: 2, hypothesis: 1 });
    expect(s.lastAt).toBeTruthy();
  });

  it('FDR 视角：期望假阳性上界 = 采信数 × 5%，OOS 稳定占比', () => {
    recordFactorExperiments([
      entry({ name: 'a', kept: true, pValue: 0.03, oosStable: true }),
      entry({ name: 'b', kept: true, pValue: 0.04, oosStable: false }),
      entry({ name: 'c', kept: false, pValue: 0.4, oosStable: false }),
    ]);
    const s = summarizeFactorExperiments();
    expect(s.kept).toBe(2);
    // 上界只看采信数（最坏情形：采信集全部为真原假设）：2 × 0.05 = 0.1；
    // 旧实现用 Σp（0.03+0.04）当期望假发现数——p 值不是 P(H0|采信)，公式无解释含义
    expect(s.keptExpectedFalse).toBeCloseTo(0.1, 6);
    expect(s.keptOosShare).toBeCloseTo(0.5, 6);
  });

  it('台账留痕不丢表达式原文（可复盘）', () => {
    recordFactorExperiments([entry({ expression: 'close / mean(close, 20) - 1' })]);
    expect(listFactorExperiments()[0].expression).toBe('close / mean(close, 20) - 1');
  });
});
