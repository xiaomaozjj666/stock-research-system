/**
 * 运行时设置接口（前端「设置」页）
 * ----------------------------------------------------------------------------
 * GET  /api/settings                      当前生效配置（Webhook 脱敏回显 + 历史容量）
 * PUT  /api/settings                      修改配置（立即生效，无需重启）
 * POST /api/settings/alert-webhook/test   发一条真实测试推送，验证链路
 *
 * 安全约定：Webhook 地址里的 key/token 等同凭据，GET 只回脱敏后的主机与一级路径，
 * PUT 时用户重新输入完整地址；空字符串/null 表示清除该项、回到环境变量。
 */
import { Router } from 'express';

import { metaLimiter, writeLimiter } from '../middleware.js';
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  maskWebhookUrl,
  saveSettings,
  resolveAlertWebhookConfig,
  type SettingsPatch,
} from '../services/settings.js';
import {
  DEFAULT_HISTORY_MAX_ITEMS,
  HISTORY_MAX_ITEMS_HARD_LIMIT,
  historyMaxItemsStatus,
  trimHistoryToLimit,
} from '../services/historyService.js';
import { pushTestWebhook } from '../services/alertWebhook.js';
import logger from '../utils/logger.js';

const router = Router();

/** 与 GET /api/settings 的响应形状保持一致（PUT 成功后也回它，前端无需二次拉取） */
function buildSettingsResponse() {
  const webhook = resolveAlertWebhookConfig();
  const history = historyMaxItemsStatus();
  return {
    alertWebhook: {
      configured: webhook !== null,
      urlMasked: webhook ? maskWebhookUrl(webhook.url) : null,
      timeoutMs: webhook?.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
      source: webhook?.source ?? ('none' as const),
    },
    history: {
      maxItems: history.value,
      source: history.source,
      defaultMaxItems: DEFAULT_HISTORY_MAX_ITEMS,
      hardMaxItems: HISTORY_MAX_ITEMS_HARD_LIMIT,
    },
  };
}

type Body = Record<string, unknown>;
type ParsedPatch = { ok: true; patch: SettingsPatch } | { ok: false; error: string };

/** 把请求体收敛成受控补丁：只认已知字段，类型不对直接 400（不静默丢弃） */
function parsePatch(body: unknown): ParsedPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const input = body as Body;
  const patch: SettingsPatch = {};

  if (input.alertWebhook !== undefined) {
    const raw = input.alertWebhook;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'alertWebhook 必须是对象' };
    }
    const webhook = raw as Body;
    if ('url' in webhook) {
      if (webhook.url !== null && typeof webhook.url !== 'string') {
        return { ok: false, error: 'alertWebhook.url 必须是字符串或 null' };
      }
      patch.alertWebhookUrl = (webhook.url as string | null) ?? null;
    }
    if ('timeoutMs' in webhook) {
      if (
        webhook.timeoutMs !== null &&
        (typeof webhook.timeoutMs !== 'number' || !Number.isFinite(webhook.timeoutMs))
      ) {
        return { ok: false, error: 'alertWebhook.timeoutMs 必须是数字或 null' };
      }
      patch.alertWebhookTimeoutMs = (webhook.timeoutMs as number | null) ?? null;
    }
  }

  if (input.history !== undefined) {
    const raw = input.history;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'history 必须是对象' };
    }
    const history = raw as Body;
    if ('maxItems' in history) {
      if (
        history.maxItems !== null &&
        (typeof history.maxItems !== 'number' || !Number.isFinite(history.maxItems))
      ) {
        return { ok: false, error: 'history.maxItems 必须是数字或 null' };
      }
      patch.historyMaxItems = (history.maxItems as number | null) ?? null;
    }
  }

  return { ok: true, patch };
}

router.get('/api/settings', metaLimiter, (_req, res) => {
  res.json(buildSettingsResponse());
});

router.put('/api/settings', writeLimiter, async (req, res) => {
  const parsed = parsePatch(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const saved = saveSettings(parsed.patch);
  if (!saved.ok) return res.status(400).json({ error: saved.error });

  // 上限调低后立即裁剪：否则用户看到「已设为 500」而列表仍是 2000 条，
  // 要等下一次分析保存才生效，像是没保存成功。
  if (parsed.patch.historyMaxItems !== undefined) {
    await trimHistoryToLimit();
  }

  res.json(buildSettingsResponse());
});

/**
 * 测试推送：走与真实预警**完全相同**的配置解析与 POST 链路，
 * 验证的就是生产路径。未配置时也回 200（结果里 configured=false），
 * 这不是请求错误，而是「还差一步配置」的正常状态。
 */
router.post('/api/settings/alert-webhook/test', writeLimiter, async (_req, res) => {
  const result = await pushTestWebhook();
  if (result.configured && result.ok) {
    logger.info('设置页测试推送成功');
  }
  res.json({
    sent: result.ok,
    configured: result.configured,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(typeof result.status === 'number' ? { status: result.status } : {}),
  });
});

export default router;
