/**
 * 轻量 RAG 证据检索（Lightweight RAG）
 * ----------------------------------------------------------------------------
 * 不引入外部向量库/嵌入模型（避免沙箱与密钥耦合）。对已在本地缓存的结构化分析、
 * 财报、估值做关键词/BM25-lite 检索，供 LLM 引用证据，从而降低幻觉。
 *
 * 纯函数核心 retrieveEvidenceFromDocs 可单测；retrieveEvidence 包装文件索引（best-effort）。
 *
 * 语料索引的性能约束：缓存目录按 prune 上限可达 2000 文件 / 上百 MB，而检索发生在
 * **每条对话**里。因此磁盘索引做「快照 + 失效判据」缓存，并把读盘全部改为异步
 * （fs/promises）——原先每条消息 sync readdir/readFile/JSON.parse 整目录，
 * 会把事件循环阻塞数秒。对外契约不变（同样的语料内容与 topK 结果）。
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getDataCacheDir } from '../services/dataService.js';
import { getQuantCacheDir } from '../quant/quantCache.js';

export interface EvidenceDoc {
  id: string;
  source: string;
  text: string;
  stockCode?: string;
}

/** 运行时注入的文档（研报/财报/用户粘贴），进入 RAG 语料，重启即失（演示用） */
const ingestedDocs: EvidenceDoc[] = [];
/** 注入文档上限：超出后淘汰最早注入的（FIFO），防长驻进程内存缓慢膨胀 */
const INGESTED_DOCS_MAX = 1000;

/** 注入一份文档到 RAG 语料（内存态） */
export function ingestDocument(doc: EvidenceDoc): void {
  ingestedDocs.push(doc);
  while (ingestedDocs.length > INGESTED_DOCS_MAX) {
    ingestedDocs.shift();
  }
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

  const scored = docs
    .map((doc) => {
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
    })
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.doc);
}

/** 语料索引快照（仅磁盘部分；运行时注入文档实时拼接，不受快照 TTL 影响） */
interface CorpusSnapshot {
  docs: EvidenceDoc[];
  /** 目录签名：各根目录的 mtime + .json 条目数（新增/删除缓存文件即变化） */
  signature: string;
  loadedAt: number;
}

/** 语料快照默认有效期（`RAG_CORPUS_TTL_MS` 可覆盖；<=0 表示每次检索都重扫） */
const DEFAULT_CORPUS_TTL_MS = 60_000;

let corpusSnapshot: CorpusSnapshot | null = null;
let corpusRefreshInFlight: Promise<void> | null = null;

function corpusTtlMs(): number {
  const raw = process.env.RAG_CORPUS_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_CORPUS_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CORPUS_TTL_MS;
}

/**
 * 语料根目录：与两个缓存模块共用同一套目录解析（DATA_CACHE_DIR 生效），
 * 而不是硬编码相对路径——否则 DATA_CACHE_DIR 生效时索引的是空目录。
 * 共享同一目录时去重，避免同一份文档被索引两次。
 */
function corpusRoots(): string[] {
  return [...new Set([getDataCacheDir(), getQuantCacheDir()])];
}

/**
 * 目录签名（异步，只 stat + readdir，不读文件内容）：
 * 文件新增/删除会改变目录 mtime 或条目数 → 判为「语料变了」。
 * 同名单文件的内容覆盖不改变签名，由 TTL 兜底（见 loadCorpus）。
 */
async function corpusSignature(): Promise<string> {
  const parts: string[] = [];
  for (const root of corpusRoots()) {
    try {
      const st = await fsp.stat(root);
      const count = (await fsp.readdir(root)).filter((f) => f.endsWith('.json')).length;
      parts.push(`${root}:${st.mtimeMs}:${count}`);
    } catch {
      parts.push(`${root}:missing`);
    }
  }
  return parts.join('|');
}

/** 把单个缓存文件解析为证据文档；不可读/无文本时返回 null */
function docFromCacheFile(file: string, raw: string): EvidenceDoc | null {
  try {
    const json = JSON.parse(raw);
    const code = String(json?.stockCode || json?.code || '');
    const text = flatten(json).join(' ').slice(0, 2000);
    if (text.trim().length === 0) return null;
    return { id: file, source: `cache:${file}`, text, stockCode: code || undefined };
  } catch {
    return null; // 单文件损坏忽略
  }
}

/** 异步索引磁盘缓存目录（生产路径：全程 fs/promises，不阻塞事件循环） */
async function indexCorpusFromDisk(): Promise<EvidenceDoc[]> {
  const docs: EvidenceDoc[] = [];
  for (const root of corpusRoots()) {
    try {
      const files = (await fsp.readdir(root)).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        const doc = docFromCacheFile(f, await fsp.readFile(path.join(root, f), 'utf-8'));
        if (doc) docs.push(doc);
      }
    } catch {
      /* 目录不可读忽略 */
    }
  }
  return docs;
}

/** 同步索引磁盘缓存目录（仅冷启动兜底，见 indexCorpus；热路径不再走这里） */
function indexCorpusFromDiskSync(): EvidenceDoc[] {
  const docs: EvidenceDoc[] = [];
  for (const root of corpusRoots()) {
    try {
      if (!fs.existsSync(root)) continue;
      const files = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const doc = docFromCacheFile(f, fs.readFileSync(path.join(root, f), 'utf-8'));
          if (doc) docs.push(doc);
        } catch {
          /* 单文件损坏忽略 */
        }
      }
    } catch {
      /* 目录不可读忽略 */
    }
  }
  return docs;
}

/** 拼接最终语料：注入文档在前且实时生效（不受磁盘快照 TTL 影响） */
function composeCorpus(diskDocs: EvidenceDoc[]): EvidenceDoc[] {
  return ingestedDocs.length > 0 ? [...ingestedDocs, ...diskDocs] : [...diskDocs];
}

/** 触发一次异步重建（single-flight：并发检索共享同一次读盘） */
function refreshCorpus(): Promise<void> {
  if (corpusRefreshInFlight) return corpusRefreshInFlight;
  corpusRefreshInFlight = (async () => {
    const signature = await corpusSignature();
    const docs = await indexCorpusFromDisk();
    corpusSnapshot = { docs, signature, loadedAt: Date.now() };
  })()
    .catch(() => {
      // 读盘失败：不写快照（下次检索重试），保留旧快照继续服务
    })
    .finally(() => {
      corpusRefreshInFlight = null;
    });
  return corpusRefreshInFlight;
}

/**
 * 异步取语料：每次检索做一次**廉价的**目录签名比对（stat + readdir，异步、不读文件内容），
 * 仅在「目录签名变化（有缓存文件新增/删除）」或「TTL 到期（同名单文件内容被覆盖）」时全量重建。
 */
async function loadCorpus(): Promise<EvidenceDoc[]> {
  const snapshot = corpusSnapshot;
  const ttl = corpusTtlMs();
  if (!snapshot || ttl <= 0) {
    // 无快照（冷启动）或显式关闭缓存（ttl<=0）：直接重建，保证内容最新
    await refreshCorpus();
    return composeCorpus(corpusSnapshot?.docs ?? []);
  }
  const signatureChanged = (await corpusSignature()) !== snapshot.signature;
  const expired = Date.now() - snapshot.loadedAt >= ttl;
  if (signatureChanged || expired) await refreshCorpus();
  // 重建失败时退回旧快照（缓存是加速器，不是数据源）
  return composeCorpus(corpusSnapshot?.docs ?? snapshot.docs);
}

/**
 * 索引本地缓存目录下的 JSON 为证据文档（best-effort，忽略一切错误）。
 *
 * 同步契约保留（既有调用方无需改动）：命中快照直接返回；冷启动（进程内首次调用）
 * 做一次同步读盘兜底，之后不再同步读盘。生产热路径经 retrieveEvidence 走异步加载。
 */
export function indexCorpus(): EvidenceDoc[] {
  if (!corpusSnapshot) {
    // signature 留空：下次异步加载时会与真实签名不同，从而补建完整快照
    corpusSnapshot = { docs: indexCorpusFromDiskSync(), signature: '', loadedAt: Date.now() };
  }
  return composeCorpus(corpusSnapshot.docs);
}

/** 清空语料快照（测试/运维用：下次检索强制重扫缓存目录） */
export function resetCorpusCache(): void {
  corpusSnapshot = null;
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
 *
 * 性能：文档向量按 id+文本指纹缓存，语料不变时跨查询复用（此前每次查询都对
 * 全量语料重新嵌入，成本与延迟随语料线性膨胀）；新增/变更文档分批嵌入，
 * 避免语料变大后单请求超过嵌入端点批量上限。
 */
const vectorCache = new Map<string, number[]>();
const VECTOR_CACHE_MAX = 2000;
const EMBED_BATCH_SIZE = 64;

/** 文本指纹：长度 + FNV-1a 变体哈希，足够区分语料文档的变更 */
function textFingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

function vectorCacheKey(doc: EvidenceDoc): string {
  return `${doc.id}::${textFingerprint(doc.text)}`;
}

async function embedInBatches(
  embedder: Embedder,
  texts: string[],
  batchSize = EMBED_BATCH_SIZE,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    out.push(...(await embedder(texts.slice(i, i + batchSize))));
  }
  return out;
}

export async function retrieveEvidence(
  query: string,
  opts: { topK?: number; stockCode?: string; embedder?: Embedder; docs?: EvidenceDoc[] } = {},
): Promise<EvidenceDoc[]> {
  // 未显式传入语料时走异步索引（快照 + 失效判据），每条对话不再同步重扫缓存目录
  const docs = opts.docs ?? (await loadCorpus());
  const embedder = opts.embedder;
  if (embedder && docs.length > 0) {
    try {
      // 命中缓存的向量直接复用，仅嵌入新增/变更文档（与查询嵌入并行）
      const docVecs: (number[] | undefined)[] = docs.map((d) => vectorCache.get(vectorCacheKey(d)));
      const [qVecArr] = await Promise.all([
        embedder([query]),
        (async () => {
          const missingIdx: number[] = [];
          docs.forEach((_, i) => {
            if (!docVecs[i]) missingIdx.push(i);
          });
          if (missingIdx.length === 0) return;
          const missingVecs = await embedInBatches(
            embedder,
            missingIdx.map((i) => docs[i].text),
          );
          for (let j = 0; j < missingIdx.length; j++) {
            const vec = missingVecs[j];
            const docIdx = missingIdx[j];
            docVecs[docIdx] = vec;
            if (vec && vec.length > 0) {
              vectorCache.set(vectorCacheKey(docs[docIdx]), vec);
              // 容量上限：FIFO 淘汰（Map 迭代顺序即插入顺序）
              while (vectorCache.size > VECTOR_CACHE_MAX) {
                const oldest = vectorCache.keys().next().value;
                if (oldest === undefined) break;
                vectorCache.delete(oldest);
              }
            }
          }
        })(),
      ]);
      if (qVecArr[0] && qVecArr[0].length > 0) {
        const vectors = docVecs.map((v) => v ?? []);
        const idx = buildVectorIndex(docs, vectors);
        const sem = semanticSearch(qVecArr[0], idx, opts);
        if (sem.length > 0) return sem;
      }
    } catch {
      // 嵌入失败（端点不可用/限流）→ 回退 BM25
    }
  }
  return retrieveEvidenceFromDocs(query, docs, opts);
}
