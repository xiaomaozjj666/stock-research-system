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

/** 运行时注入的文档（研报/财报/用户粘贴），进入 RAG 语料，重启即失（演示用） */
const ingestedDocs: EvidenceDoc[] = [];

/** 注入一份文档到 RAG 语料（内存态） */
export function ingestDocument(doc: EvidenceDoc): void {
  ingestedDocs.push(doc);
}

/** 读取已注入文档（管理/测试用） */
export function getIngestedDocs(): EvidenceDoc[] {
  return ingestedDocs;
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
  // 先加入运行时注入的文档（研报/财报/用户粘贴）
  for (const d of ingestedDocs) docs.push(d);
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

/** 嵌入函数类型（由调用方注入真实 embed 或 mock） */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** 余弦相似度（维度不一致或空向量返回 0） */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface VectorIndexItem {
  doc: EvidenceDoc;
  vector: number[];
}
export interface VectorIndex {
  items: VectorIndexItem[];
}

/** 构建向量索引：过滤缺失、空向量、全零向量（余弦恒为 0，留着只会拖慢检索） */
export function buildVectorIndex(docs: EvidenceDoc[], vectors: number[][]): VectorIndex {
  const items: VectorIndexItem[] = [];
  for (let i = 0; i < docs.length; i++) {
    const v = vectors[i];
    if (!v || v.length === 0) continue;
    if (!v.some((x) => Number.isFinite(x) && x !== 0)) continue; // 全零/非法向量丢弃
    items.push({ doc: docs[i], vector: v });
  }
  return { items };
}

export function semanticSearch(
  queryVec: number[],
  index: VectorIndex,
  opts: { topK?: number; stockCode?: string } = {},
): EvidenceDoc[] {
  const topK = opts.topK ?? 4;
  const scored = index.items
    .map((it) => {
      let score = cosine(queryVec, it.vector);
      if (opts.stockCode && it.doc.stockCode === opts.stockCode) score += 0.2;
      return { doc: it.doc, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.doc);
}

/**
 * 对外检索：优先语义（若提供 embedder），否则回退 BM25-lite。
 * embedder 由调用方注入（默认走 llm/embed）；无 embedder 或嵌入失败时纯关键词召回。
 */
export async function retrieveEvidence(
  query: string,
  opts: { topK?: number; stockCode?: string; embedder?: Embedder; docs?: EvidenceDoc[] } = {},
): Promise<EvidenceDoc[]> {
  const docs = opts.docs ?? indexCorpus();
  if (opts.embedder && docs.length > 0) {
    try {
      const [qVec, dVecs] = await Promise.all([
        opts.embedder([query]),
        opts.embedder(docs.map((d) => d.text)),
      ]);
      if (qVec[0] && qVec[0].length > 0) {
        const idx = buildVectorIndex(docs, dVecs);
        const sem = semanticSearch(qVec[0], idx, opts);
        if (sem.length > 0) return sem;
      }
    } catch {
      // 嵌入失败（端点不可用/限流）→ 回退 BM25
    }
  }
  return retrieveEvidenceFromDocs(query, docs, opts);
}
