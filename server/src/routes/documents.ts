/**
 * 文档入库（研报/财报/公告）：PDF 或纯文本 → 洞察抽取 → 注入 RAG。
 */
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { chatLimiter, metaLimiter } from '../middleware.js';
import { ingestDocument, getIngestedDocs } from '../llm/rag.js';
import { extractDocumentInsights } from '../services/documentInsights.js';
import { extractTextFromPdf } from '../quant/pdfExtract.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';

const router = Router();

/** 本路由的挂载路径：index.ts 据此让全局 100kb 解析器放行（见下面的上限说明） */
export const INGEST_PATH = '/api/ingest';

/**
 * /api/ingest 的请求体上限：8MB。
 * 取值依据：真实研报/财报 PDF 常见 1~6MB，base64 后约 ×1.34（8MB body ≈ 6MB 原文件）；
 * 再大属于扫描版整本年报，应该离线抽文本而不是走 HTTP。全局上限仍是 100kb
 * （所有其它路由的内存占用不受影响），本路由单独挂这个更大的解析器。
 */
export const INGEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * title 硬上限 200 字符（超长一律截断，不 400）。
 * ----------------------------------------------------------------------------
 * 为什么必须有：8MB 的 body 上限只约束了 text/pdfBase64，title 此前**全程没有上限**，
 * 而它会被四处放大：
 *   1. 拼进 docText（`【${title}】...`）→ 进 RAG 内存语料，之后**每条** chat 检索
 *      都要 tokenize 它（单个请求即可把约 8MB 字符串压进语料，长期拖慢所有检索）；
 *   2. 拼进 source（`doc:${title}`）→ 同样进语料与 /api/documents 列表；
 *   3. 原样回显在响应里；
 *   4. 失败时整串进日志（日志体积与磁盘写入都被单个请求放大）。
 * 取 200：真实研报/财报/公告标题远短于此（中文标题常见 20~60 字），
 * 200 足以容纳"标题 + 副标题 + 报告期"的长尾，且截断后仍是可读标题而不是报错。
 * 截断而不是 400：标题超长多半是客户端把正文误填进 title，截断保住入库能力，
 * 同时把三类放大路径一并钉死（source/回显/日志都由截断后的 title 派生）。
 */
export const MAX_TITLE_CHARS = 200;

/** 超长 title 截断：trim 后再截（否则前导空白会吃掉有效配额） */
function clampTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_TITLE_CHARS);
}

/** 统一的 413 响应：说清上限、本次体积与两条可操作出路（而不是 express 的通用报错） */
function respondTooLarge(res: Response, sizeBytes?: number): void {
  const limitMb = INGEST_BODY_LIMIT_BYTES / (1024 * 1024);
  const actual =
    typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0
      ? `，本次约 ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`
      : '';
  res.status(413).json({
    error: `请求体过大（上限 ${limitMb}MB${actual}）`,
    detail:
      '请压缩 PDF 后重试，或先在本地抽取文本、改用 text 字段入库（pdfBase64 会额外膨胀约 1/3）',
    limitBytes: INGEST_BODY_LIMIT_BYTES,
    ...(typeof sizeBytes === 'number' && sizeBytes > 0 ? { sizeBytes } : {}),
  });
}

/**
 * 大小预检：Content-Length 已超限时直接 413，不读流。
 * 放在解析器之前，好处是超限请求连 body 都不进内存，且文案可控。
 */
function ingestSizeGuard(req: Request, res: Response, next: NextFunction): void {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > INGEST_BODY_LIMIT_BYTES) {
    respondTooLarge(res, declared);
    return;
  }
  next();
}

/** 路由级 JSON 解析器：兜住无 Content-Length（chunked）上传时的超限，同样回可读 413 */
const ingestJsonParser = express.json({ limit: INGEST_BODY_LIMIT_BYTES });
function ingestBodyParser(req: Request, res: Response, next: NextFunction): void {
  ingestJsonParser(req, res, (err?: unknown) => {
    if (err && (err as { type?: string }).type === 'entity.too.large') {
      respondTooLarge(res);
      return;
    }
    next(err);
  });
}

router.post(
  INGEST_PATH,
  chatLimiter,
  ingestSizeGuard,
  ingestBodyParser,
  async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const title = clampTitle(body.title);
      if (!title) return res.status(400).json({ error: '请提供文档标题 title' });
      let text = typeof body.text === 'string' ? body.text : '';
      if (!text && typeof body.pdfBase64 === 'string' && body.pdfBase64) {
        text = await extractTextFromPdf(Buffer.from(body.pdfBase64, 'base64'));
      }
      if (!text.trim()) return res.status(400).json({ error: '请提供 text 或 pdfBase64' });

      const insight = await extractDocumentInsights(text);
      const docText = [
        `【${title}】${insight.summary}`,
        `利好:${insight.positives.join(';')}`,
        `风险:${insight.risks.join(';')}`,
        `催化剂:${insight.catalysts.join(';')}`,
        text.slice(0, 1500),
      ].join('\n');
      const id = `ingested:${Date.now()}`;
      // source 由 title 派生（doc:<title>）：title 已被硬截断，故 source 长度同样有界
      const source = `doc:${title}`;
      ingestDocument({ id, source, text: docText });
      res.json({ id, title, insight, ingested: true });
    } catch (error) {
      // 只记 title 的**长度**，不记原文：否则单个超大 title 会把日志撑爆（且原文含用户数据）
      const rawTitle = (req.body as { title?: unknown } | undefined)?.title;
      logger.error('Ingest error', {
        route: INGEST_PATH,
        titleLength: typeof rawTitle === 'string' ? rawTitle.length : 0,
        err: error,
      });
      res.status(500).json({ error: '文档入库失败', detail: errorDetail(error) });
    }
  },
);

// 已入库文档列表：纯内存读取的只读元数据，用 metaLimiter(30/min) 挡脚本轮询
// （入库写接口 /api/ingest 仍走 chatLimiter，因为要跑 LLM 洞察抽取）
router.get('/api/documents', metaLimiter, (_req, res) => {
  const docs = getIngestedDocs();
  res.json({
    count: docs.length,
    docs: docs.map((d) => ({ id: d.id, source: d.source, preview: d.text.slice(0, 200) })),
  });
});

export default router;
