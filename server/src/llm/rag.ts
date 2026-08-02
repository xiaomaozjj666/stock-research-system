/**
 * 轻量 RAG 证据检索（Lightweight RAG）
 * ----------------------------------------------------------------------------
 * 不引入外部向量库/嵌入模型（避免沙箱与密钥耦合）。对已在本地缓存的结构化分析、
 * 财报、估值做关键词/BM25-lite 检索，供 LLM 引用证据，从而降低幻觉。
 *
 * 纯函数核心 retrieveEvidenceFromDocs 可单测；retrieveEvidence 包装文件索引（best-effort）。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface EvidenceDoc {
  id: string;
  source: string;
  text: string;
  stockCode?: string;
}

/** 把一段结构化对象拍平为可读文本片段 */
function flatten(obj: unknown, prefix = '', depth = 0): string[] {
  if (depth > 4) return [];
  if (obj === null || obj === undefined) return [];
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    return [String(obj)];
  }
  if (Array.isArray(obj)) {
    return obj.flatMap((o) => flatten(o, prefix, depth + 1));
  }
  if (typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1),
    );
  }
  return [];
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  // 英文/数字词
  const latin = lower.match(/[a-z0-9]+/g) || [];
  // 中文按二元组切分（简单但有效的子词）
  const cjk = lower.match(/[一-龥]/g) || [];
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...latin, ...bigrams];
}

/** BM25-lite 打分：IDF 近似为 1，仅用词频×长度归一 */
export function retrieveEvidenceFromDocs(
  query: string,
  docs: EvidenceDoc[],
  opts: { topK?: number; stockCode?: string } = {},
): EvidenceDoc[] {
  const topK = opts.topK ?? 4;
  const qTerms = new Set(tokenize(query));
  if (qTerms.size === 0 || docs.length === 0) return [];

  const scored = docs.map((doc) => {
    const docTerms = tokenize(doc.text);
    const freq = new Map<string, number>();
    for (const t of docTerms) freq.set(t, (freq.get(t) ?? 0) + 1);
    let score = 0;
    for (const qt of qTerms) {
      const f = freq.get(qt) ?? 0;
      if (f > 0) score += (f * (1 + 1)) / (f + 1.2); // BM25-lite 饱和
    }
    // 股票代码匹配加权
    if (opts.stockCode && doc.stockCode === opts.stockCode) score += 2;
    return { doc, score };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.doc);
}

/** 索引本地缓存目录下的 JSON 为证据文档（best-effort，忽略一切错误） */
export function indexCorpus(): EvidenceDoc[] {
  const roots = [
    path.join(import.meta.dirname, '..', 'data', 'cache'),
    path.join(import.meta.dirname, '..', 'quant', 'cache'),
  ];
  const docs: EvidenceDoc[] = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const files = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(root, f), 'utf-8');
          const json = JSON.parse(raw);
          const code = String(json?.stockCode || json?.code || '');
          const text = flatten(json).join(' ').slice(0, 2000);
          if (text.trim().length > 0) {
            docs.push({ id: f, source: `cache:${f}`, text, stockCode: code || undefined });
          }
        } catch { /* 单文件损坏忽略 */ }
      }
    } catch { /* 目录不可读忽略 */ }
  }
  return docs;
}

/** 对外检索：索引缓存 + 关键词召回 */
export function retrieveEvidence(query: string, opts: { topK?: number; stockCode?: string } = {}): EvidenceDoc[] {
  const docs = indexCorpus();
  return retrieveEvidenceFromDocs(query, docs, opts);
}
