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
  answerSimilarity,
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

describe('runEnsemble — 语义聚类投票（自由文本）', () => {
  it('同义改写聚为一组：agreement=1 而不是退化成权重占比', async () => {
    // 旧实现按文本精确分组：两段同义长文各成一簇，agreement=0.5，失去语义
    mockedChat.mockImplementation(async (_m, opts?: { model?: string }) =>
      opts?.model === 'model-a'
        ? '综合估值与资金面，我们建议 逢低看多，目标价 1500 元。'
        : '建议逢低看多；目标价 1500 元（综合估值与资金面）。',
    );
    const r = await runEnsemble([{ role: 'user', content: 'x' }], {
      models: ['model-a', 'model-b'],
    });
    expect(r.agreement).toBeCloseTo(1, 6);
    expect(r.consensus).toContain('逢低看多');
  });

  it('观点相左分得开：agreement=0.5（各成一簇）', async () => {
    mockedChat.mockImplementation(async (_m, opts?: { model?: string }) =>
      opts?.model === 'model-a' ? '看多' : '看空',
    );
    const r = await runEnsemble([{ role: 'user', content: 'x' }], {
      models: ['model-a', 'model-b'],
    });
    expect(r.agreement).toBeCloseTo(0.5, 6);
  });

  it('consensus 取胜出簇内权重最高成员的原文', async () => {
    // model-b 权重 0.5（与 a 相同），但其答案与 model-c 同义 → 簇权重更高；
    // 簇代表应是先入簇（权重最高）的 model-b 原文
    for (let i = 0; i < 10; i++) recordModelOutcome('model-b', true);
    mockedChat.mockImplementation(async (_m, opts?: { model?: string }) => {
      if (opts?.model === 'model-a') return '完全不同的独立观点';
      if (opts?.model === 'model-b') return '建议逢低看多，基本面支撑较强。';
      return '建议逢低看多，基本面有支撑!';
    });
    const r = await runEnsemble([{ role: 'user', content: 'x' }], {
      models: ['model-a', 'model-b', 'model-c'],
    });
    expect(r.consensus).toContain('逢低看多');
    expect(r.agreement).toBeGreaterThan(0.5);
  });

  it('answerSimilarity：相同 → 1，同义改写高，无关低', () => {
    expect(answerSimilarity('看多', '看多')).toBe(1);
    expect(answerSimilarity('看多, 目标价上调', '看多目标价上调')).toBeGreaterThanOrEqual(0.8);
    expect(answerSimilarity('看多', '看空')).toBe(0);
    expect(answerSimilarity('基本面强劲利好', '技术面破位利空')).toBeLessThan(0.4);
  });

  it('answerSimilarity：短答案被长答案包含不判同义（重叠系数的否定词缺陷已修）', () => {
    // 旧重叠系数口径下 买入 ⊂ 不建议买入 → 相似度恒为 1，否定词直接丢失
    expect(answerSimilarity('买入', '不建议买入')).toBeLessThanOrEqual(0.5);
    expect(answerSimilarity('看多', '继续看多，维持买入评级')).toBeLessThan(0.62);
  });

  it('answerSimilarity：JSON 结构化输出只认逐字相同（骨架重叠不参与聚类）', () => {
    expect(answerSimilarity('{"sentiment":"bullish"}', '{"sentiment":"bearish"}')).toBe(0);
    expect(answerSimilarity('{"sentiment":"bullish"}', '{"sentiment":"bullish"}')).toBe(1);
  });

  it('similarityThreshold>1 退化为只认逐字相同', async () => {
    mockedChat.mockImplementation(async (_m, opts?: { model?: string }) =>
      opts?.model === 'model-a' ? '建议逢低看多' : '建议逢低看多。',
    );
    const r = await runEnsemble([{ role: 'user', content: 'x' }], {
      models: ['model-a', 'model-b'],
      similarityThreshold: 1.01,
    });
    // 只差一个句号也按不同簇处理
    expect(r.agreement).toBeCloseTo(0.5, 6);
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
