import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { chat } from '../client.js';
import { getModelRegistry, selectModel } from '../config.js';
import {
  runEnsemble,
  candidateModels,
  recordModelOutcome,
  getModelWeights,
  modelWeight,
  resetCalibration,
} from '../ensemble.js';

vi.mock('../client.js', () => ({ chat: vi.fn() }));
vi.mock('../config.js', () => ({
  getModelRegistry: vi.fn(),
  selectModel: vi.fn(() => 'model-a'),
}));

const mockedChat = vi.mocked(chat);
const mockedRegistry = vi.mocked(getModelRegistry);
const mockedSelect = vi.mocked(selectModel);

function reg(ids: string[]) {
  return ids.map((id, i) => ({
    id,
    label: id,
    costPer1kInput: i,
    costPer1kOutput: i,
    tasks: ['chat' as const],
  }));
}

beforeEach(() => {
  // 绝对路径：避免校准文件落到项目根目录污染工作树
  process.env.MODEL_CALIBRATION_FILE = path.join(
    os.tmpdir(),
    `model-calibration-test-${process.pid}.json`,
  );
  resetCalibration();
  mockedChat.mockReset();
  mockedRegistry.mockReturnValue(reg(['model-a', 'model-b', 'model-c']) as never);
  mockedSelect.mockReturnValue('model-a');
});

describe('candidateModels', () => {
  it('默认只取 1 个模型（等价关闭集成，既有链路零变更）', () => {
    delete process.env.LLM_ENSEMBLE_SIZE;
    expect(candidateModels('chat')).toHaveLength(1);
  });

  it('LLM_ENSEMBLE_SIZE>1 时按成本升序取多个', () => {
    process.env.LLM_ENSEMBLE_SIZE = '2';
    expect(candidateModels('chat')).toEqual(['model-a', 'model-b']);
    delete process.env.LLM_ENSEMBLE_SIZE;
  });

  it('注册表只有 1 个模型时退化为单模型（不凑数）', () => {
    mockedRegistry.mockReturnValue(reg(['only']) as never);
    const models = candidateModels('chat');
    expect(models).toHaveLength(1);
    expect(models[0]).toBe(mockedSelect('chat'));
  });
});

describe('runEnsemble — 加权投票', () => {
  it('全部一致 → consensus 为共同答案，agreement=1', async () => {
    mockedChat.mockResolvedValue('看多');
    const r = await runEnsemble([{ role: 'user', content: 'x' }], {
      models: ['model-a', 'model-b'],
    });
    expect(r.consensus).toBe('看多');
    expect(r.agreement).toBeCloseTo(1, 6);
    expect(r.effectiveModels).toBe(2);
  });

  it('二比一 → 多数派胜出，agreement 反映权重占比', async () => {
    mockedChat.mockImplementation(async (_m, opts?: { model?: string }) =>
      opts?.model === 'model-c' ? '看空' : '看多',
    );
    const r = await runEnsemble([{ role: 'user', content: 'x' }], {
      models: ['model-a', 'model-b', 'model-c'],
    });
    expect(r.consensus).toBe('看多');
    expect(r.agreement).toBeGreaterThan(0.5);
    expect(r.answers).toHaveLength(3);
  });

  it('单模型失败不影响其余（失败项权重 0）', async () => {
    mockedChat.mockImplementation(async (_m, opts?: { model?: string }) => {
      if (opts?.model === 'model-b') throw new Error('429');
      return '看多';
    });
    const r = await runEnsemble([{ role: 'user', content: 'x' }], {
      models: ['model-a', 'model-b'],
    });
    expect(r.effectiveModels).toBe(1);
    expect(r.consensus).toBe('看多');
    const failed = r.answers.find((a) => a.model === 'model-b');
    expect(failed?.ok).toBe(false);
    expect(failed?.weight).toBe(0);
  });

  it('全部失败 → 抛出（不静默返回空结论）', async () => {
    mockedChat.mockRejectedValue(new Error('上游不可用'));
    await expect(
      runEnsemble([{ role: 'user', content: 'x' }], { models: ['model-a'] }),
    ).rejects.toThrow(/上游不可用/);
  });
});

describe('校准（不编造准确率）', () => {
  it('无数据时权重为默认 0.5', () => {
    expect(modelWeight('model-a')).toBeCloseTo(0.5, 6);
  });

  it('记录结果后权重随命中率变化，且有下限 1/3', () => {
    for (let i = 0; i < 10; i++) recordModelOutcome('model-a', true);
    expect(modelWeight('model-a')).toBeGreaterThan(0.8);
    for (let i = 0; i < 50; i++) recordModelOutcome('model-b', false);
    expect(modelWeight('model-b')).toBeGreaterThanOrEqual(1 / 3);
  });

  it('getModelWeights 返回已记录模型的权重', () => {
    recordModelOutcome('model-a', true);
    expect(Object.keys(getModelWeights())).toContain('model-a');
  });
});
