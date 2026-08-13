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
    // 查询 '电池 技术'：tokenize 后 bigram 为 {电池, 池技, 技术}，只命中 doc2 的 '电池'/'技术'
    // （BM25-lite ≈ 1.82）；doc1 命中 0 词。加权（+2，见 rag.ts retrieveEvidenceFromDocs）
    // 后同代码 doc1 反超 → 真正验证加权分支。（此前查询只命中单一文档，恒通过）
    const q = '电池 技术';
    const r1 = retrieveEvidenceFromDocs(q, docs);
    const r2 = retrieveEvidenceFromDocs(q, docs, { stockCode: '600519' });
    expect(r1[0]?.id).toBe('2');
    expect(r2[0]?.id).toBe('1');
  });

  it('supports chinese bigram matching', () => {
    const r = retrieveEvidenceFromDocs('电池产能', docs);
    expect(r.some((d) => d.id === '2')).toBe(true);
  });
});
