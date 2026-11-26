/**
 * 异动预警外部推送（Webhook）
 * ----------------------------------------------------------------------------
 * 自选股异动此前只能打开页面看「最近一次快照」，无人值守时触达不到人。本模块把
 * **同一条**监控快照 POST 到可配置的 Webhook（企业微信 / 飞书机器人、自建网关均可）：
 *
 *   POST {ALERT_WEBHOOK_URL}
 *   Content-Type: application/json
 *   {
 *     "event": "watchlist.alerts",
 *     "source": "monitor" | "autonomous" | "settings",
 *     "generatedAt": "2026-11-26T10:00:00.000Z",
 *     "monitored": 20,
 *     "alerts": [...],
 *     "requested": 25,   // 仅清单超过单次上限、真的发生裁剪时出现
 *     "skipped": 5       // 同上
 *   }
 *
 * 配置来源（优先级从高到低，见 services/settings.ts）：
 *   1. 设置页写入的 `settings.json`（`/api/settings`）；
 *   2. 环境变量 `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_TIMEOUT_MS`；
 *   3. 都未配置 = 关闭，只保留站内 /api/watchlist/alerts 快照。
 *
 * 设计约束：
 *  - 只接受 http/https；非法环境变量只告警一次并在进程内记住，不随每次监控重复尝试。
 *  - 超时默认 3000，夹紧到 [500, 10000]；经 utils/timeout 的 withAbortableTimeout
 *    到点 abort 底层连接，而不是只让调用方提前放弃。
 *  - 最佳努力：网络错误 / 超时 / 非 2xx 只记 warning，绝不向调用方抛错；调用方仍应
 *    fire-and-forget 调用（见 routes/watchlist.ts），不阻塞监控响应。
 *  - 无预警（alerts 为空）不推送：定时巡检多数轮次无信号，推空消息只会刷屏。
 *  - 日志不打印完整 URL：企业微信的 key 与飞书的 hook token 都在 URL 里，等同凭据。
 */
import type { WatchlistAlertsSnapshot } from './watchlistService.js';
import {
  isHttpWebhookUrl,
  resolveAlertWebhookConfig,
  type ResolvedAlertWebhook,
} from './settings.js';
import logger from '../utils/logger.js';
import { withAbortableTimeout } from '../utils/timeout.js';

export type AlertWebhookSource = 'monitor' | 'autonomous' | 'settings';

/** 推送体（event 固定为 watchlist.alerts，便于接收端按事件类型分发） */
export interface AlertWebhookPayload {
  event: 'watchlist.alerts';
  source: AlertWebhookSource;
  generatedAt: string | null;
  monitored: number;
  alerts: WatchlistAlertsSnapshot['alerts'];
  requested?: number;
  skipped?: number;
}

/**
 * 已判定为非法的**环境变量**原文（进程内缓存，只用于去重告警）。
 * 按「原值」缓存而不是一个固定布尔：同一个错误值不会在每轮巡检重复告警、
 * 重复发起注定失败的连接；进程环境换成合法值后立即恢复推送，不需要清缓存。
 */
const invalidEnvUrls = new Set<string>();

/** 日志写失败（如 stdout EPIPE）不得把「最佳努力」的推送变成异常 */
function warnSafely(message: string, context?: Record<string, unknown>): void {
  try {
    logger.warn(message, context);
  } catch {
    // 有意吞掉：日志只是旁路，推送主流程不因它失败
  }
}

/**
 * 解析最终生效的推送配置：设置文件优先；环境变量非法时只告警一次。
 * 返回 null 表示未配置（不是错误，不打 warning）。
 */
function resolveConfig(): ResolvedAlertWebhook | null {
  const resolved = resolveAlertWebhookConfig();
  if (resolved) return resolved;
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  // 走到这里说明 resolve 拒绝了它：设置文件未覆盖 + 环境变量非法
  if (!invalidEnvUrls.has(raw)) {
    invalidEnvUrls.add(raw);
    if (!isHttpWebhookUrl(raw)) {
      // 不打印 URL 本身：其中的 key/token 等同凭据
      warnSafely('[alertWebhook] ALERT_WEBHOOK_URL 不是合法的 http/https URL，已禁用外部推送');
    }
  }
  return null;
}

/** 组装推送体：requested/skipped 只在快照里确有有效值时出现 */
function buildPayload(
  snapshot: WatchlistAlertsSnapshot,
  source: AlertWebhookSource,
): AlertWebhookPayload {
  const coverage: { requested?: number; skipped?: number } = {};
  if (typeof snapshot.requested === 'number' && Number.isFinite(snapshot.requested)) {
    coverage.requested = snapshot.requested;
  }
  if (typeof snapshot.skipped === 'number' && Number.isFinite(snapshot.skipped)) {
    coverage.skipped = snapshot.skipped;
  }
  return {
    event: 'watchlist.alerts',
    source,
    generatedAt: snapshot.generatedAt,
    monitored: snapshot.monitored,
    alerts: snapshot.alerts,
    ...coverage,
  };
}

export interface WebhookPushResult {
  ok: boolean;
  /** 失败原因（可读中文）；成功时为 undefined */
  reason?: string;
  status?: number;
}

/**
 * 真正发一次 POST。**永不 reject**：网络错误 / 超时 / 非 2xx 都在内部消化，
 * 返回结构化结果供「测试推送」接口如实回显。
 */
async function postWebhook(
  config: ResolvedAlertWebhook,
  payload: AlertWebhookPayload,
  context: { source: AlertWebhookSource; alertCount: number },
): Promise<WebhookPushResult> {
  try {
    const response = await withAbortableTimeout(
      (signal) =>
        fetch(config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        }),
      config.timeoutMs,
      // 超时不仅让这里提前失败，还会 abort 掉底层连接（withAbortableTimeout 的语义）
      { message: `alertWebhook timeout: ${config.timeoutMs}ms 未完成` },
    );

    // real Response 一定有 ok；极简桩（只给 status）按状态码兜底，避免假告警
    const ok =
      typeof response.ok === 'boolean'
        ? response.ok
        : response.status >= 200 && response.status < 300;
    if (!ok) {
      warnSafely('[alertWebhook] 推送失败：上游返回非 2xx', {
        status: response.status,
        source: context.source,
        alerts: context.alertCount,
      });
    }
    // 不消费响应体时连接不会被放回连接池：无论成功失败都显式丢弃（同 utils/http.ts）。
    // 内层 try：body 已结束/桩对象不支持 cancel 都不该把「推送成功」误报成失败。
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // 有意吞掉：只是连接回收，不影响推送结果
      }
    }
    return ok
      ? { ok: true, status: response.status }
      : {
          ok: false,
          reason: `上游返回 HTTP ${response.status}`,
          status: response.status,
        };
  } catch (error) {
    warnSafely('[alertWebhook] 推送失败（网络错误或超时），已忽略', {
      source: context.source,
      err: error,
    });
    return { ok: false, reason: '网络错误或超时，未送达' };
  }
}

/**
 * 把一条监控快照推送到外部 Webhook（最佳努力）。
 *
 * 该函数**永不 reject**：未配置 / 无预警 / 非法 URL / 网络失败 / 超时 / 非 2xx
 * 全部在内部消化，最多留下一条 warning。调用方可以 `void pushAlerts(...)` 直接
 * fire-and-forget，不必 catch，也不会拖慢 HTTP 响应。
 */
export async function pushAlerts(
  snapshot: WatchlistAlertsSnapshot,
  meta: { source: AlertWebhookSource },
): Promise<void> {
  // 无预警不推送：这是正常的「本轮没信号」，不是失败，也不该产生日志
  if (!snapshot || !Array.isArray(snapshot.alerts) || snapshot.alerts.length === 0) return;
  const config = resolveConfig();
  if (!config) return;
  await postWebhook(config, buildPayload(snapshot, meta.source), {
    source: meta.source,
    alertCount: snapshot.alerts.length,
  });
}

/** 设置页「测试推送」用的示例快照：内容与真实预警同形，便于接收端直接验证渲染 */
function testSnapshot(): WatchlistAlertsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    monitored: 1,
    alerts: [
      {
        code: '600519',
        name: '示例股票',
        level: 'high-impact',
        polarity: 0.62,
        weightedImpact: 0.75,
        detail: '示例股票 新闻影响强度高（这是一条来自设置页的测试推送）',
      },
    ],
  };
}

/**
 * 发送一条测试推送（设置页使用）。未配置时显式返回原因，而不是静默成功。
 * 与 pushAlerts 共用同一套配置解析与 POST 实现，验证的就是真实链路。
 */
export async function pushTestWebhook(): Promise<WebhookPushResult & { configured: boolean }> {
  const config = resolveConfig();
  if (!config) {
    return { ok: false, configured: false, reason: '尚未配置 Webhook 地址' };
  }
  const result = await postWebhook(config, buildPayload(testSnapshot(), 'settings'), {
    source: 'settings',
    alertCount: 1,
  });
  return { ...result, configured: true };
}
