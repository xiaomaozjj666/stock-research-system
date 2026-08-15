/**
 * 合规审计查询（金融监管 8 号文）：可按类别/风险等级/时间/会话过滤。
 */
import { Router } from 'express';
import { auditLogger } from '../services/auditLog.js';
import logger from '../utils/logger.js';

const router = Router();

router.get('/api/audit', (req, res) => {
  try {
    const q = req.query;
    const filter: Parameters<typeof auditLogger.query>[0] = {
      ...(q.category ? { category: String(q.category) as never } : {}),
      ...(q.riskLevel ? { riskLevel: String(q.riskLevel) as never } : {}),
      ...(q.startTime ? { startTime: Number(q.startTime) } : {}),
      ...(q.endTime ? { endTime: Number(q.endTime) } : {}),
      ...(q.sessionId ? { sessionId: String(q.sessionId) } : {}),
    };
    const entries = auditLogger.query(filter);
    res.json({ count: entries.length, entries });
  } catch (error) {
    logger.error('Audit query error', { route: '/api/audit', err: error });
    res.status(500).json({ error: '审计查询失败', detail: (error as Error).message });
  }
});

export default router;
