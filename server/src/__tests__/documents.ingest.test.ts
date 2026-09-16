/**
 * ============================================================================
 * /api/ingest 的请求体上限回归测试
 *
 * 背景（审计）：全局 `express.json({ limit: '100kb' })` 对该路由同样生效，而它收的是
 * PDF（pdfBase64）——真实研报 >75KB，base64 后还要再膨胀约 1/3，必然 413，
 * 等于"PDF 上传功能被全局上限废掉"。
 *
 * 修复口径：全局上限保持 100kb 不动（不放宽所有路由的内存上限），
 * 只在 index.ts 里让 /api/ingest 跳过全局解析器，由 routes/documents.ts 挂
 * 8MB 解析器 + 大小预检（超限回可读 413）。
 *
 * 本文件锁定三点：
 *   1) 小体积 PDF 正常入库；
 *   2) **超过 100kb 但小于 8MB 的真实 PDF 也能通过**（这正是被废掉的场景）；
 *   3) 超过 8MB 回 413，且文案写明上限与两条可操作出路。
 * ============================================================================
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  ingestDocument: vi.fn(),
  extractDocumentInsights: vi.fn(),
  extractTextFromPdf: vi.fn(),
}));

vi.mock('../llm/rag.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/rag.js')>();
  return { ...actual, ingestDocument: mocks.ingestDocument };
});

vi.mock('../services/documentInsights.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/documentInsights.js')>();
  return {
    ...actual,
    extractDocumentInsights: mocks.extractDocumentInsights,
  };
});

vi.mock('../quant/pdfExtract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/pdfExtract.js')>();
  return { ...actual, extractTextFromPdf: mocks.extractTextFromPdf };
});

import { app } from '../index.js';
import { INGEST_BODY_LIMIT_BYTES } from '../routes/documents.js';

/** 伪造一段 PDF base64（内容不重要：extractTextFromPdf 已打桩） */
function fakePdfBase64(bytes: number): string {
  return Buffer.alloc(bytes, 0x41).toString('base64');
}

beforeEach(() => {
  mocks.ingestDocument.mockReset();
  mocks.extractDocumentInsights.mockReset();
  mocks.extractTextFromPdf.mockReset();
  mocks.extractDocumentInsights.mockResolvedValue({
    summary: '测试摘要',
    positives: ['利好一'],
    risks: ['风险一'],
    catalysts: ['催化一'],
  });
  mocks.extractTextFromPdf.mockResolvedValue('从 PDF 抽取出来的正文');
});

describe('POST /api/ingest — 请求体上限', () => {
  it('小体积 PDF base64：正常入库（走 PDF 抽取分支）', async () => {
    const pdfBase64 = fakePdfBase64(4 * 1024); // 4KB PDF

    const res = await request(app).post('/api/ingest').send({ title: '小研报', pdfBase64 });

    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(true);
    expect(mocks.extractTextFromPdf).toHaveBeenCalledTimes(1);
    expect(mocks.ingestDocument).toHaveBeenCalledTimes(1);
  });

  it('超过全局 100kb 的真实 PDF（约 300KB）不再被 413 误杀', async () => {
    // base64 后约 400KB：> 100kb 全局上限，< 8MB 路由上限 —— 修复前这里必然 413
    const pdfBase64 = fakePdfBase64(300 * 1024);
    expect(pdfBase64.length).toBeGreaterThan(100 * 1024);

    const res = await request(app).post('/api/ingest').send({ title: '真实研报', pdfBase64 });

    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(true);
    expect(mocks.extractTextFromPdf).toHaveBeenCalledTimes(1);
  });

  it('纯文本入库（text 字段）照旧可用，且其它路由仍受 100kb 全局上限保护', async () => {
    const ok = await request(app).post('/api/ingest').send({ title: '文本研报', text: '正文内容' });
    expect(ok.status).toBe(200);

    // 对照组：全局上限没有被放宽——/api/watchlist 超 100kb 依旧 413
    const tooBigElsewhere = await request(app)
      .post('/api/watchlist')
      .send({ code: '600519', pad: 'x'.repeat(150 * 1024) });
    expect(tooBigElsewhere.status).toBe(413);
  });

  it('超过 8MB 上限：413 + 可操作文案（不是 express 的通用 entity.too.large）', async () => {
    // 只声明 9MB 的 Content-Length、不真的写 9MB：预检正是按这个头判定的，
    // 而真写 9MB 会在服务端已回 413 之后撞上 ECONNRESET（客户端还在写，连接已被关）
    const declaredBytes = 9 * 1024 * 1024;
    const res = await request(app)
      .post('/api/ingest')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(declaredBytes))
      .send('{"title":"整本年报","pdfBase64":"AAAA"}');

    expect(res.status).toBe(413);
    expect(res.body.error).toContain('请求体过大');
    expect(res.body.error).toContain('上限 8MB');
    expect(res.body.error).toContain('9.0MB'); // 本次体积，便于用户判断要压到多少
    expect(res.body.detail).toContain('压缩 PDF');
    expect(res.body.detail).toContain('text 字段');
    expect(res.body.limitBytes).toBe(INGEST_BODY_LIMIT_BYTES);
    // 预检直接拒绝：连 PDF 抽取都不该被触发
    expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
  });

  it('缺少 text / pdfBase64：仍是 400（大小预检不影响既有校验）', async () => {
    const res = await request(app).post('/api/ingest').send({ title: '空文档' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('text 或 pdfBase64');
  });
});
