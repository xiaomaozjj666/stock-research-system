import { describe, it, expect } from 'vitest';
import {
  lexiconPolarity,
  aggregateNewsSentiment,
  fetchLatestNews,
  extractNewsSignal,
  NEWS_MODEL_CONSTANTS,
  type NewsItem,
} from '../newsSignal.js';

describe('lexiconPolarity', () => {
  it('看多词给出正向极性', () => {
    expect(lexiconPolarity('公司中标大单，金额超去年营收')).toBeGreaterThan(0);
    expect(lexiconPolarity('机构上调评级，回购增持')).toBeGreaterThan(0);
  });
  it('看空词给出负向极性', () => {
    expect(lexiconPolarity('机构下调评级至中性，商誉减值')).toBeLessThan(0);
    expect(lexiconPolarity('业绩爆雷，立案调查')).toBeLessThan(0);
  });
  it('中性文本极性为 0', () => {
    expect(lexiconPolarity('公司将于下周二召开股东大会')).toBe(0);
  });
  it('极性夹紧到 [-1,1]', () => {
    const p = lexiconPolarity('利好 利好 利好 利好 利好 利好 利好 利好');
    expect(p).toBeLessThanOrEqual(1);
    expect(p).toBeGreaterThanOrEqual(-1);
  });
});

const now = Date.now();
const daysAgo = (d: number): string => new Date(now - d * 24 * 60 * 60 * 1000).toISOString();

describe('aggregateNewsSentiment', () => {
  it('空输入返回中性信号（hasNews=false）', () => {
    const s = aggregateNewsSentiment([]);
    expect(s.hasNews).toBe(false);
    expect(s.polarity).toBe(0);
    expect(s.sentimentZ).toBe(0);
    expect(s.newsCount).toBe(0);
  });

  it('单条看多新闻 → 正极性、正 z、看多占比 1', () => {
    const items: NewsItem[] = [
      { id: '1', title: '公司业绩超预期，放量新高', publishedAt: daysAgo(0) },
    ];
    const s = aggregateNewsSentiment(items);
    expect(s.hasNews).toBe(true);
    expect(s.polarity).toBeGreaterThan(0);
    expect(s.sentimentZ).toBeGreaterThan(0);
    expect(s.bullishRatio).toBe(1);
    expect(s.freshness).toBeGreaterThan(0.99);
  });

  it('单条看空新闻 → 负极性、负 z', () => {
    const items: NewsItem[] = [{ id: '1', title: '业绩爆雷，下调评级', publishedAt: daysAgo(0) }];
    const s = aggregateNewsSentiment(items);
    expect(s.polarity).toBeLessThan(0);
    expect(s.sentimentZ).toBeLessThan(0);
  });

  it('时效性加权：新鲜看多盖过陈旧看空 → 净正向', () => {
    const items: NewsItem[] = [
      { id: 'fresh', title: '中标大单，量价齐升', publishedAt: daysAgo(0) },
      { id: 'old', title: '此前下调评级', publishedAt: daysAgo(30) },
    ];
    const s = aggregateNewsSentiment(items);
    expect(s.polarity).toBeGreaterThan(0); // 新鲜看多占主导
  });

  it('时效性加权：陈旧看多让位于新鲜看空 → 净负向', () => {
    const items: NewsItem[] = [
      { id: 'old', title: '较早前中标大单', publishedAt: daysAgo(40) },
      { id: 'fresh', title: '最新业绩爆雷，立案', publishedAt: daysAgo(0) },
    ];
    const s = aggregateNewsSentiment(items);
    expect(s.polarity).toBeLessThan(0);
  });

  it('新鲜度：全为当日新闻 → ≈1；陈旧 → 更低', () => {
    const fresh = aggregateNewsSentiment([{ id: 'a', title: '回购增持', publishedAt: daysAgo(0) }]);
    const old = aggregateNewsSentiment([{ id: 'b', title: '回购增持', publishedAt: daysAgo(60) }]);
    expect(fresh.freshness).toBeGreaterThan(old.freshness);
  });

  it('预标注 polarity 优先于词典法', () => {
    const items: NewsItem[] = [
      { id: 'x', title: '中性标题但人工标注利空', publishedAt: daysAgo(0), polarity: -1 },
    ];
    const s = aggregateNewsSentiment(items);
    expect(s.polarity).toBe(-1);
  });

  it('影响强度 = |极性| × 新鲜度 ∈ [0,1]', () => {
    const s = aggregateNewsSentiment([{ id: 'a', title: '中标大单', publishedAt: daysAgo(0) }]);
    expect(s.weightedImpact).toBeLessThanOrEqual(1);
    expect(s.weightedImpact).toBeGreaterThanOrEqual(0);
    expect(s.weightedImpact).toBeCloseTo(Math.abs(s.polarity) * s.freshness, 6);
  });

  it('半衰期常数合理（≈5.8 天）', () => {
    expect(NEWS_MODEL_CONSTANTS.HALF_LIFE_DAYS).toBeGreaterThan(5);
    expect(NEWS_MODEL_CONSTANTS.HALF_LIFE_DAYS).toBeLessThan(6.2);
  });
});

describe('fetchLatestNews / extractNewsSignal（尽力而为，不抛错）', () => {
  it('fetchLatestNews 返回数组且不抛错', async () => {
    await expect(fetchLatestNews('600519')).resolves.toBeInstanceOf(Array);
  });
  it('extractNewsSignal 返回 {signal, source} 结构', async () => {
    const r = await extractNewsSignal('600519');
    expect(r).toHaveProperty('signal');
    expect(r).toHaveProperty('source');
    expect(['live', 'none']).toContain(r.source);
    expect(r.signal).toHaveProperty('hasNews');
  });
});
