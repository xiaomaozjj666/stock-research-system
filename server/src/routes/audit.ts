/**
 * 合规审计查询（金融监管 8 号文）：可按类别/风险等级/时间/会话过滤。
 * ----------------------------------------------------------------------------
 * 分页：支持 limit/offset，`count` 恒为**匹配总数**（不是本页条数），供前端「共 N 条 / 加载更多」。
 * 不传 limit/offset 时保持旧行为（返回全部匹配条目），避免破坏既有调用方。
 * 时间参数非法（如 ?startTime=abc）一律 400：此前 Number('abc') = NaN 被当成过滤条件，
 * 与任何 timestamp 比较都为 false → 静默返回空列表，调用方无从发现有参数写错了。
 */
import { Router } from 'express';
import { metaLimiter } from '../middleware.js';
import { auditLogger } from '../services/auditLog.js';
import { errorDetail } from '../utils/errorDetail.js';
import logger from '../utils/logger.js';

const router = Router();

/** 参数解析结果：`value === undefined` 表示调用方没传该参数 */
type ParsedParam = { value?: number } | { error: string };

/** 解析 epoch 毫秒时间参数（只接受单个数字；非法值报错而不是静默 NaN 过滤） */
function parseEpochMs(raw: unknown, name: string): ParsedParam {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: `${name} 需为单个 epoch 毫秒数字` };
  }
  const text = String(raw).trim();
  if (text === '') return { error: `${name} 不能为空` };
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { error: `${name} 需为 epoch 毫秒数字（如 1735689600000）` };
  }
  return { value };
}

/** 解析非负整数分页参数（limit = 本页条数，offset = 起始偏移） */
function parsePageParam(raw: unknown, name: string): ParsedParam {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: `${name} 需为单个非负整数` };
  }
  const text = String(raw).trim();
  if (text === '') return { error: `${name} 不能为空` };
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    return { error: `${name} 需为 >= 0 的整数` };
  }
  return { value };
}

// 审计台账是只读元数据（内存条目过滤 + 无网络），但一次查询可返回整个台账，
// 故用 metaLimiter(30/min)：够审计页面刷新用，又能挡住脚本连续全量拉取。
router.get('/api/audit', metaLimiter, (req, res) => {
  try {
    const q = req.query;
    const startTime = parseEpochMs(q.startTime, 'startTime');
    if ('error' in startTime) {
      return res.status(400).json({ error: '查询参数非法', detail: startTime.error });
    }
    const endTime = parseEpochMs(q.endTime, 'endTime');
    if ('error' in endTime) {
      return res.status(400).json({ error: '查询参数非法', detail: endTime.error });
    }
    const limit = parsePageParam(q.limit, 'limit');
    if ('error' in limit) {
      return res.status(400).json({ error: '查询参数非法', detail: limit.error });
    }
    const offset = parsePageParam(q.offset, 'offset');
    if ('error' in offset) {
      return res.status(400).json({ error: '查询参数非法', detail: offset.error });
    }

    const filter: Parameters<typeof auditLogger.query>[0] = {
      ...(q.category ? { category: String(q.category) as never } : {}),
      ...(q.riskLevel ? { riskLevel: String(q.riskLevel) as never } : {}),
      ...(startTime.value !== undefined ? { startTime: startTime.value } : {}),
      ...(endTime.value !== undefined ? { endTime: endTime.value } : {}),
      ...(q.sessionId ? { sessionId: String(q.sessionId) } : {}),
    };
    const matched = auditLogger.query(filter);

    // 未传分页参数：保持旧行为（全量下发），既有调用方不受影响
    if (limit.value === undefined && offset.value === undefined) {
      return res.json({ count: matched.length, entries: matched });
    }
    // 分页：count 仍是匹配总数，entries 只给本页；offset 越界返回空数组（客户端据此判断"没有更多"）
    const from = offset.value ?? 0;
    const entries =
      limit.value === undefined ? matched.slice(from) : matched.slice(from, from + limit.value);
    res.json({ count: matched.length, entries });
  } catch (error) {
    logger.error('Audit query error', { route: '/api/audit', err: error });
    res.status(500).json({ error: '审计查询失败', detail: errorDetail(error) });
  }
});

export default router;
