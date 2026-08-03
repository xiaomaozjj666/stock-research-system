import { describe, it, expect } from 'vitest';
import { retrieveEvidenceFromDocs, type EvidenceDoc } from '../rag.js';

const docs: EvidenceDoc[] = [
  { id: '1', source: 'a', text: '贵州茅台 营收增长 高分红 现金流良好', stockCode: '600519' },
  { id: '2', source: 'b', text: '宁德时代 电池 产能 技术领先' },
  { id: '3', source: 'c', text: '苹果 iphone 销售 下滑' },
];

describe('retrieveEvidenceFromDocs', () => {
  it('returns docs matching query terms, ranked', () => {
    const r = retrieveEvidenceFromDocs('贵州茅台 分红', docs, { topK: 2 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe('1');
  });

  it('returns empty for empty query', () => {
    expect(retrieveEvidenceFromDocs('', docs)).toEqual([]);
  });

  it('boosts stock code match', () => {
    const r = retrieveEvidenceFromDocs('营收', docs, { stockCode: '600519' });
    expect(r[0]?.stockCode).toBe('600519');
  });

  it('supports chinese bigram matching', () => {
    const r = retrieveEvidenceFromDocs('电池产能', docs);
    expect(r.some((d) => d.id === '2')).toBe(true);
  });
});
