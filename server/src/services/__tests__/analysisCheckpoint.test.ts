import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  newRunId,
  stageLabel,
  type CheckpointDataPayload,
} from '../analysisCheckpoint.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'ckpt-'));
const origDir = process.env.ANALYSIS_CHECKPOINT_DIR;
const origTtl = process.env.ANALYSIS_CHECKPOINT_TTL_MS;

/** 本用例组的代次（saveCheckpoint 要求显式传 runId，防止跨代 merge） */
const GEN = 'gen-test';

function makeData(code: string): CheckpointDataPayload {
  return {
    info: { code, name: `股票${code}`, industry: '白酒' } as never,
    financial: { years: ['2024'] } as never,
    valuation: { currentPrice: 100 } as never,
    newsSignal: null,
    priceHistory: [{ date: '2024-01-01', close: 100 }] as never,
  };
}

beforeEach(() => {
  process.env.ANALYSIS_CHECKPOINT_DIR = tmpDir;
  process.env.ANALYSIS_CHECKPOINT_TTL_MS = '3600000';
});

afterEach(() => {
  clearCheckpoint('600519');
  clearCheckpoint('000001');
  if (origDir === undefined) delete process.env.ANALYSIS_CHECKPOINT_DIR;
  else process.env.ANALYSIS_CHECKPOINT_DIR = origDir;
  if (origTtl === undefined) delete process.env.ANALYSIS_CHECKPOINT_TTL_MS;
  else process.env.ANALYSIS_CHECKPOINT_TTL_MS = origTtl;
});

describe('analysisCheckpoint 断点续跑', () => {
  it('无断点时返回 null', () => {
    expect(loadCheckpoint('600519')).toBeNull();
  });

  it('保存后可原样读回，并记录已完成阶段与代次', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') }, GEN);
    const ck = loadCheckpoint('600519');
    expect(ck).not.toBeNull();
    expect(ck?.stage).toBe('data');
    expect(ck?.data?.info.code).toBe('600519');
    expect(ck?.data?.valuation.currentPrice).toBe(100);
    expect(ck?.runId).toBe(GEN); // 代次随断点落盘，供并发两代互相拒绝使用
  });

  it('多次保存按阶段合并，不覆盖已有产物', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') }, GEN);
    saveCheckpoint('600519', { stage: 'experts', expertOpinions: [{ expert: 'A' }] as never }, GEN);
    const ck = loadCheckpoint('600519');
    // data 阶段产物仍在，experts 阶段产物已追加
    expect(ck?.data?.info.code).toBe('600519');
    expect(ck?.expertOpinions).toHaveLength(1);
    expect(ck?.stage).toBe('experts');
  });

  it('代次不符时拒绝读取（并发另一代的断点视为无断点）', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') }, GEN);
    // 指定别的代次 → 视为无断点；不指定代次（续跑方）→ 可读到并采用其代次
    expect(loadCheckpoint('600519', 'gen-other')).toBeNull();
    expect(loadCheckpoint('600519', GEN)?.runId).toBe(GEN);
    expect(loadCheckpoint('600519')?.runId).toBe(GEN);
  });

  it('clearCheckpoint 传代次时只清本代，不误删另一代的在途断点', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') }, 'gen-other');
    clearCheckpoint('600519', GEN); // 本代并不存在 → 不应删掉 gen-other 的文件
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(true);
    clearCheckpoint('600519', 'gen-other'); // 代次相符才清
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(false);
  });

  it('newRunId 每次生成不同代次', () => {
    const ids = new Set([newRunId(), newRunId(), newRunId()]);
    expect(ids.size).toBe(3);
  });

  it('清除后读回 null，且磁盘文件被删除', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') }, GEN);
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(true);
    clearCheckpoint('600519');
    expect(loadCheckpoint('600519')).toBeNull();
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(false);
  });

  it('断点过期后返回 null 并顺带清理（避免陈旧行情被复用）', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') }, GEN);
    process.env.ANALYSIS_CHECKPOINT_TTL_MS = '0'; // 立即过期
    // 回归用例：写入与读取可能落在同一毫秒（age === 0）。
    // 判定必须是「age >= ttl 或 ttl <= 0」而非 age > ttl，否则 ttl=0 会被误判为未过期。
    expect(loadCheckpoint('600519')).toBeNull();
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(false);
  });

  it('有效期为 0 时，同一毫秒内写入也不复用（age===0 边界）', () => {
    process.env.ANALYSIS_CHECKPOINT_TTL_MS = '0';
    saveCheckpoint('000001', { stage: 'data', data: makeData('000001') }, GEN);
    expect(loadCheckpoint('000001')).toBeNull();
  });

  it('文件内容与股票代码不一致时视为无效断点', () => {
    writeFileSync(
      join(tmpDir, '600519.json'),
      JSON.stringify({ stockCode: '000001', updatedAt: new Date().toISOString(), stage: 'data' }),
    );
    expect(loadCheckpoint('600519')).toBeNull();
  });

  it('文件损坏（非法 JSON）时静默降级为无断点', () => {
    writeFileSync(join(tmpDir, '600519.json'), '{ this is not json');
    expect(loadCheckpoint('600519')).toBeNull();
  });

  it('写入为原子替换，不留临时文件', () => {
    saveCheckpoint('000001', { stage: 'data', data: makeData('000001') }, GEN);
    // 临时文件名带代次（并发两代各写各的 tmp），收尾后不得有任何残留
    expect(readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(join(tmpDir, '000001.json'), 'utf-8')).toContain('000001');
  });

  it('阶段标签可用于进度文案', () => {
    expect(stageLabel('data')).toBe('数据获取');
    expect(stageLabel('arbitration')).toBe('辩论仲裁');
  });
});

// 整个套件结束后清理临时目录（单个用例后删除会让后续用例的 beforeEach 依赖失效）
afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
});
