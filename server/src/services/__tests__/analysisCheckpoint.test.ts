import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  stageLabel,
  type CheckpointDataPayload,
} from '../analysisCheckpoint.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'ckpt-'));
const origDir = process.env.ANALYSIS_CHECKPOINT_DIR;
const origTtl = process.env.ANALYSIS_CHECKPOINT_TTL_MS;

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

  it('保存后可原样读回，并记录已完成阶段', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') });
    const ck = loadCheckpoint('600519');
    expect(ck).not.toBeNull();
    expect(ck?.stage).toBe('data');
    expect(ck?.data?.info.code).toBe('600519');
    expect(ck?.data?.valuation.currentPrice).toBe(100);
  });

  it('多次保存按阶段合并，不覆盖已有产物', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') });
    saveCheckpoint('600519', { stage: 'experts', expertOpinions: [{ expert: 'A' }] as never });
    const ck = loadCheckpoint('600519');
    // data 阶段产物仍在，experts 阶段产物已追加
    expect(ck?.data?.info.code).toBe('600519');
    expect(ck?.expertOpinions).toHaveLength(1);
    expect(ck?.stage).toBe('experts');
  });

  it('清除后读回 null，且磁盘文件被删除', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') });
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(true);
    clearCheckpoint('600519');
    expect(loadCheckpoint('600519')).toBeNull();
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(false);
  });

  it('断点过期后返回 null 并顺带清理（避免陈旧行情被复用）', () => {
    saveCheckpoint('600519', { stage: 'data', data: makeData('600519') });
    process.env.ANALYSIS_CHECKPOINT_TTL_MS = '0'; // 立即过期
    expect(loadCheckpoint('600519')).toBeNull();
    expect(existsSync(join(tmpDir, '600519.json'))).toBe(false);
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
    saveCheckpoint('000001', { stage: 'data', data: makeData('000001') });
    expect(existsSync(join(tmpDir, '000001.json.tmp'))).toBe(false);
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
