/**
 * 对话式助手：自然语言入口（POST + SSE 流式）与持久记忆清空。
 */
import { Router } from 'express';
import { chatLimiter, circuitBreakerGuard, respondIfQueueTimeout } from '../middleware.js';
import { chatAgent } from '../services/chatAgent.js';
import { clearHistory, isValidSessionId } from '../services/chatMemory.js';
import { validateChatHistory, isQueueTimeoutError } from '../utils/limitGate.js';
import { createSseChannel } from '../utils/sse.js';
import { errorDetail } from '../utils/errorDetail.js';
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
    // history：结构非法（非数组/user-assistant 之外的角色/content 非字符串）→ 400；
    // 条数与字符超限 → 夹紧（history 由客户端累积，400 会直接打断对话；
    // 上限值见 utils/limitGate.ts，服务层对持久记忆路径另有同样的兜底）。
    const history = validateChatHistory(body.history);
    if (!history.ok) {
      return res.status(400).json({ error: history.error });
    }
    const result = await chatAgent.run({
      message,
      // 仅在客户端确实传了数组时才带上 history（空数组也不落回持久记忆，保持既有语义）
      ...(Array.isArray(body.history) ? { history: history.turns } : {}),
      stockCode: typeof body.stockCode === 'string' ? body.stockCode : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    });
    res.json(result);
  } catch (error) {
    // LLM 闸门排队超时 → 429 + Retry-After，而不是笼统 500
    if (respondIfQueueTimeout(res, error, '/api/chat')) return;
    logger.error('Chat error', { route: '/api/chat', err: error });
    res.status(500).json({ error: '对话处理失败', detail: errorDetail(error) });
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

  // 断开感知：客户端关闭页面后，下一次 emit 抛错使对话在阶段边界提前中止
  const sse = createSseChannel(req, res);

  try {
    await chatAgent.runStream(
      {
        message,
        sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
      },
      (event) => sse.send(event),
    );
  } catch (error) {
    if (sse.isClosed()) {
      logger.info('SSE 客户端已断开，对话提前中止', { route: '/api/chat/stream' });
    } else if (isQueueTimeoutError(error)) {
      // SSE 已 flushHeaders，状态码无法再改成 429；改为在错误事件里给出可退避的
      // 明确文案（含建议等待秒数），并 warn 留痕（错误码仍是 LLM_QUEUE_TIMEOUT）
      logger.warn('[llm-gate] SSE 对话因 LLM 排队超时中止', {
        route: '/api/chat/stream',
        code: error.code,
        retryAfter: error.retryAfterSeconds,
      });
      sse.trySend({
        phase: 'error',
        message: `系统繁忙（LLM 排队超时），请 ${error.retryAfterSeconds} 秒后重试`,
      });
    } else {
      logger.error('Chat stream error', { route: '/api/chat/stream', err: error });
      // 与 /api/chat 的 detail 同口径：生产环境不回传原始 message（可能是上游 URL /
      // 内部路径），前端 data.message 为空时兜底显示 '流式对话失败'
      sse.trySend({ phase: 'error', message: errorDetail(error) || '对话处理失败' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// === 对话历史清空（持久记忆管理） ===
// 该端点此前既无限流也不校验 sessionId 形态：清空是"会抹掉状态"的写操作，
// 且 sessionId 直接用作记忆文件键，任意字符串（含路径分隔符）都能落进来。
// 与 chatMemory 的 load/append 用同一个校验函数，并挂 chatLimiter（10/min）。
router.post('/api/chat/history/clear', chatLimiter, (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  if (!sessionId) return res.status(400).json({ error: '请提供 sessionId' });
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId 格式无效' });
  }
  clearHistory(sessionId);
  res.json({ ok: true });
});

export default router;
