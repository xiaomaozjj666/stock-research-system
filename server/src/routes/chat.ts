/**
 * 对话式助手：自然语言入口（POST + SSE 流式）与持久记忆清空。
 */
import { Router } from 'express';
import { chatLimiter, circuitBreakerGuard, respondIfQueueTimeout } from '../middleware.js';
import { chatAgent } from '../services/chatAgent.js';
import { clearHistory, isValidSessionId } from '../services/chatMemory.js';
import { errorDetail } from '../utils/errorDetail.js';
import { abortOnClientClose } from '../utils/clientAbort.js';
import { isQueueTimeoutError, validateChatHistory } from '../utils/limitGate.js';
import logger from '../utils/logger.js';
import { createSseChannel } from '../utils/sse.js';

const router = Router();

// === 对话式助手接口（自然语言入口） ===
router.post('/api/chat', chatLimiter, circuitBreakerGuard, async (req, res) => {
  // 断连感知：与同文件 SSE 路由、analysis POST 同范式——客户端断开后，
  // 最坏 ≈13 次 LLM 调用（工具回路 5 轮 + 校验 + 辩论）不应继续白烧。
  // 声明在 try 之外：catch 里要读 abort.signal 区分「取消」与真实错误
  const abort = abortOnClientClose(res);
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
    const result = await chatAgent.run(
      {
        message,
        // 仅在客户端确实传了数组时才带上 history（空数组也不落回持久记忆，保持既有语义）
        ...(Array.isArray(body.history) ? { history: history.turns } : {}),
        stockCode: typeof body.stockCode === 'string' ? body.stockCode : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      },
      abort.signal,
    );
    res.json(result);
  } catch (error) {
    // 客户端断开触发的取消：连接已关，按「取消」记日志而不是 500 错误
    if (abort.signal.aborted || (error as Error)?.message?.includes('abort')) {
      logger.info('客户端已断开，对话已取消', { route: '/api/chat' });
      return;
    }
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

  // M-5: close 即主动 abort 进行中的 LLM 调用（对齐 analysis.ts:150 的 isClosed 分流先例）。
  // 只靠「下一次 emit 抛错」是被动感知：工具回路/辩论阶段最坏 7 次 LLM 调用
  // 期间没有任何 emit，客户端早已断开、费用照烧。AbortSignal 经 runStream 透传到
  // 全部 LLM 调用点，中断在 HTTP 层真正发生。正常结束时 close 也会触发，
  // 但彼时 runStream 已返回，abort 一个已完成的调用无副作用。
  const llmAbort = new AbortController();
  res.on('close', () => llmAbort.abort());

  try {
    await chatAgent.runStream(
      {
        message,
        sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
      },
      (event) => sse.send(event),
      llmAbort.signal,
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
router.post('/api/chat/history/clear', chatLimiter, async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  if (!sessionId) return res.status(400).json({ error: '请提供 sessionId' });
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId 格式无效' });
  }
  await clearHistory(sessionId);
  res.json({ ok: true });
});

export default router;
