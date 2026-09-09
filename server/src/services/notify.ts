/**
 * 外部推送（借鉴 Sequoia-X 的飞书 Webhook 思路）
 * ------------------------------------------------------------------
 * 研究结论「会来找你」才算无人值守：异动预警 / 全市场初筛结果通过 Webhook
 * 推到飞书群。未配置 FEISHU_WEBHOOK_URL 时为显式 no-op（sent:false），
 * 绝不抛错——推送是锦上添花，不是数据源。
 */
const FEISHU_TEXT_LIMIT = 4000;

export function isNotifyConfigured(): boolean {
  const url = process.env.FEISHU_WEBHOOK_URL;
  return typeof url === 'string' && url.trim().length > 0;
}

/** 推送一段文本到飞书群（msg_type=text）。失败只降级，不抛错。 */
export async function pushNotify(text: string): Promise<{ sent: boolean; reason?: string }> {
  const url = process.env.FEISHU_WEBHOOK_URL?.trim();
  if (!url) return { sent: false, reason: '未配置 FEISHU_WEBHOOK_URL' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: text.slice(0, FEISHU_TEXT_LIMIT) },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}` };
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
