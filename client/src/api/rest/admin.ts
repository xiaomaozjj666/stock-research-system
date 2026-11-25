/**
 * 管理与运维域：模型路由 / 成本报表 / 自治监控 / 合规审计。
 */
import type { AuditQueryFilter } from '../../types';
import type {
  GETApiAuditResponse as AuditQueryResponse,
  GETApiModelsResponse as ModelRoutingResponse,
  GETApiCostResponse as CostResponse,
  POSTApiAutonomousStopResponse as AutonomousStopResponse,
  POSTApiCostResetResponse as OkResponse,
} from '../generated';
import { api, normalizeApiError } from './base';

// === 合规审计查询（金融监管 8 号文）：可按类别/风险等级/时间/会话过滤 ===

/** 审计查询参数：在既有过滤条件上补分页（limit/offset 由服务端 /api/audit 处理） */
export interface AuditLogQuery extends AuditQueryFilter {
  /** 本页条数；不传 = 全部 */
  limit?: number;
  /** 偏移量，从 0 开始；不传 = 0 */
  offset?: number;
}

export async function getAuditLog(query?: AuditLogQuery): Promise<AuditQueryResponse> {
  try {
    // 分页已由服务端实现（server/src/routes/audit.ts）：支持 limit/offset，
    // 且 count 恒为**匹配总数**（不是本页条数），offset 越界返回空数组。
    // 因此这里**直接透传**分页参数——原先的客户端 slice 已删除：服务端也切片后
    // 再本地切一次会二次偏移，返回错误的页（旧注释即已注明「后端真加上 limit/offset
    // 时务必删掉这里的 slice」）。非法值（负数/NaN）不下发，交由服务端按"未分页"处理。
    const { limit, offset, ...filters } = query ?? {};
    const params: Record<string, unknown> = { ...filters };
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      params.limit = Math.floor(limit);
    }
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
      params.offset = Math.floor(offset);
    }
    const response = await api.get<AuditQueryResponse>('/audit', {
      params,
      timeout: 15000,
    });
    const data = response.data;
    // count / entries 在契约里是必填，但审计查询是只读降级路径，
    // 这里仍保留兜底：宁可少显示一条，也不要因缺字段让整页崩掉。
    const entries = data.entries ?? [];
    return {
      count: typeof data.count === 'number' ? data.count : entries.length,
      entries,
    };
  } catch (error: unknown) {
    throw normalizeApiError(error, '审计查询失败');
  }
}

/** 多模型注册表与任务路由；类型来自生成的 GETApiModelsResponse。 */
export type ModelRoutingInfo = ModelRoutingResponse;
export async function getModels(): Promise<ModelRoutingInfo> {
  try {
    const response = await api.get<ModelRoutingInfo>('/models', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取模型信息失败');
  }
}

/** LLM 成本报表；类型来自生成的 GETApiCostResponse。 */
export type CostReport = CostResponse;
export async function getCostReport(): Promise<CostReport> {
  try {
    const response = await api.get<CostReport>('/cost', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取成本报告失败');
  }
}
export async function resetCostReport(): Promise<{ ok: boolean }> {
  try {
    const response = await api.post<OkResponse>('/cost/reset', {}, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '重置成本失败');
  }
}

export interface AutonomousState {
  running: boolean;
  intervalMs?: number;
  lastRunAt?: string;
  lastAlertCount?: number;
  runCount?: number;
  errorCount?: number;
  lastError?: string;
}
export async function startAutonomous(
  intervalMs?: number,
): Promise<AutonomousState & { started: boolean }> {
  try {
    // 服务端 res.json({ started: true, ...withCoverage(state) })
    const response = await api.post<AutonomousState & { started: boolean }>(
      '/autonomous/start',
      { intervalMs },
      { timeout: 15000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '启动自动监控失败');
  }
}
export async function stopAutonomous(): Promise<AutonomousStopResponse> {
  try {
    // 类型来自契约生成物：lastAlerts 的元素是 WatchlistAlert[]（此前内联写的是
    // unknown[]，等于把「最近一轮检出的预警」这个信息在类型层面丢掉了）。
    const response = await api.post<AutonomousStopResponse>(
      '/autonomous/stop',
      {},
      { timeout: 15000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '停止自动监控失败');
  }
}
export async function getAutonomousStatus(): Promise<AutonomousState> {
  try {
    // 未在运行时服务端只回 { running: false }，其余字段缺省 —— 故泛型里除 running 外均可选
    const response = await api.get<AutonomousState>('/autonomous/status', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取监控状态失败');
  }
}
