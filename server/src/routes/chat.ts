/**
 * 对话式助手：自然语言入口（POST + SSE 流式）与持久记忆清空。
 */
import { Router } from 'express';
import { chatLimiter, circuitBreakerGuard } from '../middleware.js';
import { chatAgent } from '../services/chatAgent.js';
import { clearHistory } from '../services/chatMemory.js';
import logger from '../utils/logger.js';

const router = Router();

// === 对话式助手接口（自然语言入口） ===
router.post('/api/chat', chatLimiter, circuitBreakerGuard, async (req, res) => {
  try {
    const body = req.body ?? {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ error: '请提供对话内容' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: '对话内容过长（上限 2000 字）' });
    }
    const result = await chatAgent.run({
      message,
      history: Array.isArray(body.history) ? body.history : undefined,
      stockCode: typeof body.stockCode === 'string' ? body.stockCode : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    });
    res.json(result);
  } catch (error) {
    logger.error('Chat error', { route: '/api/chat', err: error });
    res.status(500).json({ error: '对话处理失败', detail: (error as Error).message });
  }
});

// === 流式对话接口（SSE，真流式：逐阶段推送执行进度） ===
// 注意：message 长度上限 2000 字，与 POST /api/chat 一致
router.get('/api/chat/stream', chatLimiter, circuitBreakerGuard, async (req, res) => {
  const message = String(req.query.message || '').trim();
  // 与 POST /api/chat 对齐：限制消息长度，防止超长输入打满 LLM token 预算
  if (message.length > 2000) {
    return res.status(400).json({ error: '对话内容过长（上限 2000 字）' });
  }
  if (!message) {
    return res.status(400).json({ error: '请提供对话内容' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (data: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* 已断开 */
    }
  };

  try {
    await chatAgent.runStream(
      {
        message,
        sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
      },
      (event) => send(event),
    );
  } catch (error) {
    send({ phase: 'error', message: (error as Error).message || '对话处理失败' });
  } finally {
    res.end();
  }
});

// === 对话历史清空（持久记忆管理） ===
router.post('/api/chat/history/clear', (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  if (!sessionId) return res.status(400).json({ error: '请提供 sessionId' });
  clearHistory(sessionId);
  res.json({ ok: true });
});

export default router;
