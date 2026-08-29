import { describe, it, expect } from 'vitest';
import type { ExpertOpinion } from '../../types.js';
import { runExpertsWithDegradation, type ExpertTask } from '../expertRunner.js';

function opinion(expert: string): ExpertOpinion {
  return {
    expert,
    arguments: [{ text: '论点', confidence: 70, type: 'support', evidenceType: 'fact' }],
    overallSentiment: 'bullish',
    confidence: 70,
    keyPoints: ['要点'],
  };
}

function task(key: string, run: () => Promise<ExpertOpinion>): ExpertTask {
  return { key, name: `${key}专家`, run };
}

describe('expertRunner 多专家降级', () => {
  it('全部成功时返回全部结论，降级名单为空', async () => {
    const out = await runExpertsWithDegradation([
      task('a', async () => opinion('A')),
      task('b', async () => opinion('B')),
    ]);
    expect(out.opinions).toHaveLength(2);
    expect(out.degradedExperts).toEqual([]);
    expect(out.byKey.a?.expert).toBe('A');
    expect(out.byKey.b?.expert).toBe('B');
  });

  it('单个专家失败时剔除该专家，其余结论照常返回', async () => {
    const out = await runExpertsWithDegradation([
      task('a', async () => opinion('A')),
      task('b', async () => {
        throw new Error('LLM 超时');
      }),
      task('c', async () => opinion('C')),
    ]);
    // 失败的专家不进入仲裁输入，但被记入降级名单
    expect(out.opinions.map((o) => o.expert)).toEqual(['A', 'C']);
    expect(out.degradedExperts).toEqual(['b专家']);
    expect(out.byKey.b).toBeUndefined();
  });

  it('首次失败、重试成功后不计入降级（有限重试生效）', async () => {
    let calls = 0;
    const out = await runExpertsWithDegradation([
      task('a', async () => {
        calls += 1;
        if (calls === 1) throw new Error('瞬时抖动');
        return opinion('A');
      }),
    ]);
    expect(calls).toBe(2);
    expect(out.opinions).toHaveLength(1);
    expect(out.degradedExperts).toEqual([]);
  });

  it('返回结构不合法视为失败（脏数据不流入仲裁）', async () => {
    const out = await runExpertsWithDegradation([
      // 缺 keyPoints / 情绪取值非法
      task('a', async () => ({ expert: 'A', arguments: [] }) as unknown as ExpertOpinion),
    ]);
    expect(out.opinions).toHaveLength(0);
    expect(out.degradedExperts).toEqual(['a专家']);
  });

  it('全部失败时不抛错，交由调用方决定是否中止', async () => {
    const out = await runExpertsWithDegradation([
      task('a', async () => {
        throw new Error('down');
      }),
      task('b', async () => {
        throw new Error('down');
      }),
    ]);
    expect(out.opinions).toHaveLength(0);
    expect(out.degradedExperts).toEqual(['a专家', 'b专家']);
  });
});
