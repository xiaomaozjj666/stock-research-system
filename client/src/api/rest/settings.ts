/**
 * 运行时设置域：告警 Webhook 与研究历史容量（前端「设置」页）
 * ----------------------------------------------------------------------------
 * 响应类型全部来自契约生成（`api/generated.ts`），服务端改了字段会在 tsc 立刻暴露。
 * Webhook 地址只以脱敏形式回显；保存时用户需重新输入完整地址（空 = 保持原值）。
 */
import type {
  GETApiSettingsResponse as SettingsResponse,
  POSTApiSettingsAlertWebhookTestResponse as WebhookTestResult,
  PUTApiSettingsRequestBody as SettingsPatch,
} from '../generated';
import { api, normalizeApiError } from './base';

export type { SettingsResponse, SettingsPatch, WebhookTestResult };

/** 读取当前生效设置（服务端会把 Webhook 地址脱敏） */
export async function fetchSettings(): Promise<SettingsResponse> {
  try {
    const response = await api.get<SettingsResponse>('/settings', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '设置读取失败');
  }
}

/** 保存设置补丁：字段省略 = 保持；null 或空字符串 = 清除并回退环境变量 */
export async function saveSettings(patch: SettingsPatch): Promise<SettingsResponse> {
  try {
    const response = await api.put<SettingsResponse>('/settings', patch, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '设置保存失败');
  }
}

/** 发送一条测试推送（与真实预警共用同一 POST 链路） */
export async function sendTestWebhook(): Promise<WebhookTestResult> {
  try {
    const response = await api.post<WebhookTestResult>('/settings/alert-webhook/test', undefined, {
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '测试推送失败');
  }
}
