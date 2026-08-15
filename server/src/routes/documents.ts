/**
 * 文档入库（研报/财报/公告）：PDF 或纯文本 → 洞察抽取 → 注入 RAG。
 */
import { Router } from 'express';
import { chatLimiter } from '../middleware.js';
import { ingestDocument, getIngestedDocs } from '../llm/rag.js';
import { extractDocumentInsights } from '../services/documentInsights.js';
import { extractTextFromPdf } from '../quant/pdfExtract.js';
import logger from '../utils/logger.js';

const router = Router();

router.post('/api/ingest', chatLimiter, async (req, res) => {
  try {
    const body = req.body ?? {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
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
    ingestDocument({ id, source: `doc:${title}`, text: docText });
    res.json({ id, title, insight, ingested: true });
  } catch (error) {
    logger.error('Ingest error', { route: '/api/ingest', title: req.body?.title, err: error });
    res.status(500).json({ error: '文档入库失败', detail: (error as Error).message });
  }
});

router.get('/api/documents', (_req, res) => {
  const docs = getIngestedDocs();
  res.json({
    count: docs.length,
    docs: docs.map((d) => ({ id: d.id, source: d.source, preview: d.text.slice(0, 200) })),
  });
});

export default router;
