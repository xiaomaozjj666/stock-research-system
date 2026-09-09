import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pushNotify, isNotifyConfigured } from '../notify.js';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  delete process.env.FEISHU_WEBHOOK_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pushNotify — 飞书 Webhook', () => {
  it('未配置 FEISHU_WEBHOOK_URL → 显式 no-op（sent:false，不抛错）', async () => {
    expect(isNotifyConfigured()).toBe(false);
    const r = await pushNotify('hello');
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('未配置');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('已配置 → POST 飞书 text 格式', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as unknown as Response);
    process.env.FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx';
    expect(isNotifyConfigured()).toBe(true);
    const r = await pushNotify('异动提醒\n600519 strong-bull');
    expect(r.sent).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('open.feishu.cn');
    const body = JSON.parse(String(init.body));
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toContain('600519');
  });

  it('HTTP 非 2xx → 降级为未发送且带原因（推送失败不影响主流程）', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    process.env.FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx';
    const r = await pushNotify('x');
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('HTTP 500');
  });

  it('网络异常 → 降级为未发送且带原因', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    process.env.FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx';
    const r = await pushNotify('x');
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('ECONNREFUSED');
  });
});
