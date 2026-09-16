/**
 * RAG 语料索引：目录解析 / 快照缓存 / 失效判据 / 异步 I/O。
 *
 * 背景：缓存目录按 prune 上限可达 2000 文件 / 上百 MB，而语料索引原先发生在
 * **每条对话**里（sync readdir + readFile + JSON.parse 整目录），会把事件循环阻塞数秒；
 * 且索引的目录是硬编码相对路径，DATA_CACHE_DIR 生效时根本索引不到真实缓存。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  indexCorpus,
  ingestDocument,
  getIngestedDocs,
  resetCorpusCache,
  retrieveEvidence,
} from '../rag.js';

const origCacheDir = process.env.DATA_CACHE_DIR;
const origTtl = process.env.RAG_CORPUS_TTL_MS;
let cacheDir = '';

/** 哨兵关键词：只可能出现在本用例写入的缓存文件里（真实缓存目录不含它） */
const SENTINEL = 'zqmarker sentinel keyword';
/** 覆盖写入后的关键词（前缀不同，避免与 SENTINEL 共享词元导致误命中） */
const REPLACED = 'yqmarker replaced keyword';

function writeCacheFile(name: string, payload: unknown): void {
  fs.writeFileSync(join(cacheDir, name), JSON.stringify(payload), 'utf-8');
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'srs-rag-corpus-'));
  process.env.DATA_CACHE_DIR = cacheDir;
  process.env.RAG_CORPUS_TTL_MS = '60000';
  resetCorpusCache();
  getIngestedDocs().length = 0;
});

afterEach(() => {
  resetCorpusCache();
  getIngestedDocs().length = 0;
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (origTtl === undefined) delete process.env.RAG_CORPUS_TTL_MS;
  else process.env.RAG_CORPUS_TTL_MS = origTtl;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('RAG 语料索引：目录与异步读取', () => {
  it('索引 DATA_CACHE_DIR 指向的缓存目录（与缓存模块同一口径）', async () => {
    writeCacheFile('600519.json', {
      kind: 'stocks',
      stockCode: '600519',
      data: { info: { name: '贵州茅台' }, note: SENTINEL },
    });

    const hits = await retrieveEvidence(SENTINEL);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe('cache:600519.json');
    expect(hits[0].stockCode).toBe('600519');
  });

  it('异步读取：检索的同步段不包含整目录读盘（原实现会阻塞事件循环数秒）', async () => {
    // 造一个「同步读盘会明显卡住」的语料：100 个文件 × 约 150KB
    const blob = 'x'.repeat(150 * 1024);
    for (let i = 0; i < 100; i++) {
      writeCacheFile(`bulk_${i}.json`, { stockCode: '600519', text: `${SENTINEL} ${blob}` });
    }

    const t0 = performance.now();
    const pending = retrieveEvidence(SENTINEL); // 同步段在这一行内执行完
    const syncMs = performance.now() - t0;
    const hits = await pending;

    expect(hits.length).toBeGreaterThan(0);
    // 异步实现：同步段只做「判断快照是否新鲜 + 起一个 Promise」，应在毫秒级；
    // 同步实现：整目录 readFileSync + JSON.parse 都落在这段里（数十至数百毫秒）。
    expect(syncMs).toBeLessThan(50);
  });

  it('同名文件内容被覆盖后立即重新索引（逐文件 mtime/size 判据，无需等 TTL）', async () => {
    const file = join(cacheDir, '600519.json');
    writeCacheFile('600519.json', { stockCode: '600519', text: SENTINEL });
    expect((await retrieveEvidence(SENTINEL)).length).toBe(1);

    // 覆盖为新内容：逐文件签名（mtime/size）变化 → 立刻重读。
    // 此前只用「目录 mtime + 条目数」，覆盖同名文件签名不变，最长 TTL 内会检索到旧内容。
    fs.writeFileSync(file, JSON.stringify({ stockCode: '600519', text: REPLACED }));
    // 显式推进 mtime：同毫秒内完成写入时 mtime 可能不变，会让断言随机失败
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);

    const hits = await retrieveEvidence('yqmarker replaced');
    expect(hits).toHaveLength(1);
    // 用文档内容而非命中数判断新旧：SENTINEL 与 REPLACED 共享 "keyword" 词元，
    // 只数命中条数无法区分「读到了新内容」还是「旧快照仍被关键词命中」
    expect(hits[0].text).toContain('yqmarker');
    expect(hits[0].text).not.toContain('zqmarker');
  });

  it('关闭缓存（RAG_CORPUS_TTL_MS=0）时每次检索重扫，新内容可见', async () => {
    const file = join(cacheDir, '600519.json');
    writeCacheFile('600519.json', { stockCode: '600519', text: SENTINEL });
    expect((await retrieveEvidence(SENTINEL)).length).toBe(1);

    fs.writeFileSync(file, JSON.stringify({ stockCode: '600519', text: REPLACED }));
    process.env.RAG_CORPUS_TTL_MS = '0';
    expect((await retrieveEvidence('yqmarker replaced')).length).toBe(1);
  });

  it('目录签名失效判据：新增缓存文件后无需等 TTL 即可被检索到', async () => {
    writeCacheFile('600519.json', { stockCode: '600519', text: SENTINEL });
    expect((await retrieveEvidence(SENTINEL)).length).toBe(1);

    writeCacheFile('000858.json', { stockCode: '000858', text: 'yqmarker newcomer battery' });
    const hits = await retrieveEvidence('yqmarker newcomer');
    expect(hits.some((d) => d.source === 'cache:000858.json')).toBe(true);
  });

  it('indexCorpus 同步契约保留：冷启动可同步读语料，注入文档实时可见且排在前', () => {
    writeCacheFile('600519.json', { stockCode: '600519', text: SENTINEL });
    ingestDocument({ id: 'doc-1', source: 'user', text: '用户粘贴的研报正文' });

    const docs = indexCorpus();
    expect(docs.some((d) => d.source === 'cache:600519.json')).toBe(true);
    expect(docs[0].id).toBe('doc-1'); // 注入文档在前，且不受磁盘快照 TTL 影响
  });

  it('已注入文档在快照 TTL 内也立即可检索（不受磁盘快照缓存影响）', async () => {
    writeCacheFile('600519.json', { stockCode: '600519', text: SENTINEL });
    await retrieveEvidence(SENTINEL); // 先建快照

    ingestDocument({ id: 'doc-2', source: 'user', text: 'zq injected evidence' });
    const hits = await retrieveEvidence('zq injected');
    expect(hits.some((d) => d.id === 'doc-2')).toBe(true);
  });

  it('目录不存在时静默降级为空语料（不抛错）', async () => {
    process.env.DATA_CACHE_DIR = join(cacheDir, 'no-such-dir');
    resetCorpusCache();
    await expect(retrieveEvidence(SENTINEL)).resolves.toEqual([]);
  });
});
