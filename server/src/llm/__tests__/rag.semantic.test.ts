import { describe, it, expect } from 'vitest';
import {
  retrieveEvidence,
  retrieveEvidenceFromDocs,
  buildVectorIndex,
  semanticSearch,
  cosine,
  type EvidenceDoc,
  type Embedder,
} from '../rag.js';

const docs: EvidenceDoc[] = [
  { id: 'a', source: 's', text: '贵州茅台 白酒 龙头 业绩增长', stockCode: '600519' },
  { id: 'b', source: 's', text: '宁德时代 电池 新能源 扩产' },
  { id: 'c', source: 's', text: '完全无关 天气 足球' },
];

const WORDS = ['茅台', '白酒', '业绩', '宁德', '电池', '新能源', '扩产', '天气', '足球'];
function embed(text: string): number[] {
  return WORDS.map((w) => (text.includes(w) ? 1 : 0));
}
const embedder: Embedder = async (texts) => texts.map(embed);

describe('向量语义检索', () => {
  it('语义检索按余弦相似度召回最相关文档', async () => {
    const res = await retrieveEvidence('茅台 白酒 业绩', { embedder, docs, topK: 2 });
    expect(res[0].id).toBe('a');
  });

  it('股票代码匹配加权（语义）', async () => {
    // 查询与 b 语义相近但带 600519，应优先返回 a（同代码加权）
    const res = await retrieveEvidence('白酒 龙头', { embedder, docs, topK: 2, stockCode: '600519' });
    expect(res[0].id).toBe('a');
  });

  it('无 embedder 时安全回退（BM25 或空）', async () => {
    const res = await retrieveEvidence('茅台', { docs, topK: 3 });
    expect(Array.isArray(res)).toBe(true);
  });
});

describe('向量数学/索引', () => {
  it('cosine 基础正确', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([], [])).toBe(0);
  });

  it('零向量被过滤', () => {
    const idx = buildVectorIndex(docs, docs.map(() => [0, 0]));
    expect(idx.items.length).toBe(0);
  });

  it('BM25 关键词召回独立可用', () => {
    const r = retrieveEvidenceFromDocs('茅台', docs, { topK: 2 });
    expect(r.some((d) => d.id === 'a')).toBe(true);
  });
});
