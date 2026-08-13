import { describe, it, expect } from 'vitest';
import { detectAlerts } from '../alerts.js';

const rows = [
  {
    code: '600519',
    name: '茅台',
    newsSentiment: { polarity: 0.8, weightedImpact: 0.7, hasNews: true },
  },
  {
    code: '000001',
    name: '平安',
    newsSentiment: { polarity: -0.6, weightedImpact: 0.3, hasNews: true },
  },
  {
    code: '300750',
    name: '宁德',
    newsSentiment: { polarity: 0.1, weightedImpact: 0.9, hasNews: true },
  },
  { code: '600000', name: null, newsSentiment: null },
  {
    code: '600519',
    name: '茅台',
    newsSentiment: { polarity: 0.1, weightedImpact: 0.2, hasNews: true },
  },
];

describe('detectAlerts', () => {
  const a = detectAlerts(rows);

  it('detects strong bull, strong bear and high impact', () => {
    expect(a.some((x) => x.level === 'strong-bull' && x.code === '600519')).toBe(true);
    expect(a.some((x) => x.level === 'strong-bear' && x.code === '000001')).toBe(true);
    expect(a.some((x) => x.level === 'high-impact' && x.code === '300750')).toBe(true);
  });

  it('忽略无新闻行；低信号行不产生告警', () => {
    expect(a.find((x) => x.code === '600000')).toBeUndefined(); // 无新闻 → 无告警
    // 600519 有两条：impact 0.7 → high-impact；impact 0.2 低信号 → 不产生任何告警
    expect(a.filter((x) => x.code === '600519' && x.level === 'high-impact')).toHaveLength(1);
    // 600519 全部告警 = strong-bull(1) + high-impact(1)，无低信号噪音
    expect(a.filter((x) => x.code === '600519')).toHaveLength(2);
  });

  it('total alert count matches thresholds', () => {
    // 600519: strong-bull + high-impact(2); 000001: strong-bear(1); 300750: high-impact(1) => 4
    expect(a.length).toBe(4);
  });
});
