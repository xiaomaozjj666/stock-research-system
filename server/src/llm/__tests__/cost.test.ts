/**
 * LLM 成本台账的容量上限与累计口径
 * ----------------------------------------------------------------------------
 * 背景（审计）：llm/cost.ts 的 entries 是无界数组，长期运行会随调用次数单调增长。
 * 修复要点：加容量上限（COST_LEDGER_MAX_ENTRIES，默认 5000，超限按时间淘汰最旧），
 * 但 getCostReport 的 totalCost / callCount / byModel 必须仍是**生命周期累计**口径
 * ——/api/cost 面板、Prometheus 指标与预算护栏都直接消费它，若截断后只统计保留窗口，
 * 账面总额会随运行时长"缩水"。故淘汰时把用量并入累计值。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordUsage,
  getCostReport,
  getRetainedEntries,
  costLedgerMax,
  resetCostTracker,
} from '../cost.js';

/** 默认上限（与 cost.ts 内 COST_LEDGER_MAX_DEFAULT 一致） */
const DEFAULT_MAX = 5000;
const ORIGINAL = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
}

beforeEach(() => {
  resetCostTracker();
  delete process.env.COST_LEDGER_MAX_ENTRIES;
});

afterEach(() => {
  resetCostTracker();
  restoreEnv();
});

describe('costLedgerMax：env 解析与非法值回退', () => {
  it('未设置 / 空串 → 默认 5000', () => {
    expect(costLedgerMax()).toBe(DEFAULT_MAX);
    process.env.COST_LEDGER_MAX_ENTRIES = '';
    expect(costLedgerMax()).toBe(DEFAULT_MAX);
  });

  it('非法值（非数字 / 0 / 负数）一律回退默认，不产生 0 或 NaN 上限', () => {
    for (const bad of ['abc', '0', '-1', 'NaN', 'Infinity', ' ']) {
      process.env.COST_LEDGER_MAX_ENTRIES = bad;
      expect(costLedgerMax(), `非法值 ${JSON.stringify(bad)} 应回退默认`).toBe(DEFAULT_MAX);
    }
  });

  it('合法值（含小数）向下取整生效', () => {
    process.env.COST_LEDGER_MAX_ENTRIES = '3';
    expect(costLedgerMax()).toBe(3);
    process.env.COST_LEDGER_MAX_ENTRIES = '2.9';
    expect(costLedgerMax()).toBe(2);
  });
});

describe('容量上限：超限淘汰最旧，但累计口径不缩水', () => {
  it('上限 2：保留最近 2 条（淘汰最旧），report 仍是全量累计', () => {
    process.env.COST_LEDGER_MAX_ENTRIES = '2';
    recordUsage('m1', 10, 1, { cost: 0.1 });
    recordUsage('m2', 20, 2, { cost: 0.2 });
    recordUsage('m3', 30, 3, { cost: 0.3 });

    // 内存只留最近 2 条，且淘汰的是最旧的 m1
    const retained = getRetainedEntries();
    expect(retained).toHaveLength(2);
    expect(retained.map((e) => e.model)).toEqual(['m2', 'm3']);

    // 报告口径：3 次调用全部计入（含已被淘汰的 m1）
    const report = getCostReport();
    expect(report.callCount).toBe(3);
    expect(report.totalPromptTokens).toBe(60);
    expect(report.totalCompletionTokens).toBe(6);
    expect(report.totalCost).toBeCloseTo(0.6, 6);
    expect(report.byModel.m1).toEqual({ cost: 0.1, calls: 1 });
    expect(report.byModel.m3).toEqual({ cost: 0.3, calls: 1 });
  });

  it('长期运行（上限 10，记录 100 次）：内存有界、累计值等于全量真值', () => {
    process.env.COST_LEDGER_MAX_ENTRIES = '10';
    for (let i = 0; i < 100; i++) {
      recordUsage(i % 2 === 0 ? 'a' : 'b', 100, 10, { cost: 0.01 });
    }
    expect(getRetainedEntries()).toHaveLength(10);

    const report = getCostReport();
    expect(report.callCount).toBe(100);
    expect(report.totalPromptTokens).toBe(10000);
    expect(report.totalCompletionTokens).toBe(1000);
    expect(report.totalCost).toBeCloseTo(1, 6);
    // 两模型各 50 次（累计值按模型分别累加）
    expect(report.byModel.a.calls).toBe(50);
    expect(report.byModel.b.calls).toBe(50);
  });

  it('resetCostTracker 同时清空留存条目与累计值（不残留上一轮淘汰量）', () => {
    process.env.COST_LEDGER_MAX_ENTRIES = '1';
    recordUsage('m1', 10, 1, { cost: 0.1 });
    recordUsage('m2', 20, 2, { cost: 0.2 });
    expect(getCostReport().callCount).toBe(2);

    resetCostTracker();
    expect(getRetainedEntries()).toHaveLength(0);
    const report = getCostReport();
    expect(report.callCount).toBe(0);
    expect(report.totalCost).toBe(0);
    expect(report.byModel).toEqual({});
  });

  it('getRetainedEntries 返回副本：改动不影响台账内部状态', () => {
    recordUsage('m1', 10, 1, { cost: 0.1 });
    const copy = getRetainedEntries();
    copy[0].model = 'tampered';
    copy.length = 0;
    expect(getRetainedEntries()).toHaveLength(1);
    expect(getRetainedEntries()[0].model).toBe('m1');
  });

  it('未超上限时行为与修复前一致（不淘汰、累计=窗口）', () => {
    recordUsage('m1', 10, 1, { cost: 0.1 });
    recordUsage('m1', 20, 2, { cost: 0.2 });
    expect(getRetainedEntries()).toHaveLength(2);
    const report = getCostReport();
    expect(report.callCount).toBe(2);
    expect(report.totalCost).toBeCloseTo(0.3, 6);
  });
});
