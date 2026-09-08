import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordFactorExperiments,
  listFactorExperiments,
  summarizeFactorExperiments,
  clearFactorExperiments,
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

  it('台账留痕不丢表达式原文（可复盘）', () => {
    recordFactorExperiments([entry({ expression: 'close / mean(close, 20) - 1' })]);
    expect(listFactorExperiments()[0].expression).toBe('close / mean(close, 20) - 1');
  });
});
