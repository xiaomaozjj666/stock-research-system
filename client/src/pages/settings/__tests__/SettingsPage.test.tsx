// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPage from '../SettingsPage';

const baseSettings = {
  alertWebhook: {
    configured: true,
    urlMasked: 'https://qyapi.weixin.qq.com/cgi-bin/…',
    timeoutMs: 3000,
    source: 'settings' as const,
  },
  history: {
    maxItems: 2000,
    source: 'default' as const,
    defaultMaxItems: 2000,
    hardMaxItems: 50000,
  },
};

vi.mock('../../../api/client', () => ({
  fetchSettings: vi.fn(async () => baseSettings),
  saveSettings: vi.fn(async (patch: Record<string, unknown>) => {
    const webhook = (patch.alertWebhook ?? {}) as { url?: string; timeoutMs?: number };
    const history = (patch.history ?? {}) as { maxItems?: number };
    if (webhook.url === null) {
      return {
        alertWebhook: { configured: false, urlMasked: null, timeoutMs: 3000, source: 'none' },
        history: { ...baseSettings.history, maxItems: history.maxItems ?? 2000 },
      };
    }
    return {
      alertWebhook: {
        configured: true,
        urlMasked: 'https://new.example.com/…',
        timeoutMs: webhook.timeoutMs ?? 3000,
        source: 'settings',
      },
      history: {
        ...baseSettings.history,
        maxItems: history.maxItems ?? 2000,
        source: 'settings',
      },
    };
  }),
  sendTestWebhook: vi.fn(async () => ({ sent: true, configured: true, status: 204 })),
  normalizeApiError: (error: unknown, fallback: string) =>
    new Error(error instanceof Error && error.message ? error.message : fallback),
}));

import { fetchSettings, saveSettings, sendTestWebhook } from '../../../api/client';

const mockedFetch = vi.mocked(fetchSettings);
const mockedSave = vi.mocked(saveSettings);
const mockedTest = vi.mocked(sendTestWebhook);

beforeEach(() => {
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue(baseSettings);
  mockedSave.mockClear();
  mockedTest.mockReset();
  mockedTest.mockResolvedValue({ sent: true, configured: true, status: 204 });
});

describe('SettingsPage 设置页', () => {
  it('展示当前生效配置（脱敏地址 / 来源 / 容量）', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/qyapi\.weixin\.qq\.com/)).toBeInTheDocument());
    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.getByText('2000 条')).toBeInTheDocument();
    expect(screen.getByText('SQLite')).toBeInTheDocument();
    // 地址输入框刻意不预填完整地址（避免把脱敏串/凭据写回）
    expect(screen.getByLabelText('Webhook 地址')).toHaveValue('');
  });

  it('保存：输入新地址与超时后提交补丁并回显新状态', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/qyapi\.weixin/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Webhook 地址'), {
      target: { value: 'https://new.example.com/hook?key=abc' },
    });
    fireEvent.change(screen.getByLabelText('推送超时（毫秒）'), { target: { value: '2500' } });
    fireEvent.change(screen.getByLabelText('保留条数'), { target: { value: '800' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);

    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({
        alertWebhook: { timeoutMs: 2500, url: 'https://new.example.com/hook?key=abc' },
        history: { maxItems: 800 },
      }),
    );
    await waitFor(() => expect(screen.getByText('设置已保存并立即生效')).toBeInTheDocument());
    expect(screen.getByText(/new\.example\.com/)).toBeInTheDocument();
    // 保存后清空输入框，避免用户误以为地址已回显
    expect(screen.getByLabelText('Webhook 地址')).toHaveValue('');
  });

  it('留空地址保存时不下发 url（保持原配置）', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/qyapi\.weixin/)).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);

    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({
        alertWebhook: { timeoutMs: 3000 },
        history: { maxItems: 2000 },
      }),
    );
  });

  it('客户端先校验越界输入，不发请求', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/qyapi\.weixin/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('推送超时（毫秒）'), { target: { value: '100' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('500–10000');
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('测试推送：成功/失败/未配置分别给出明确反馈', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/qyapi\.weixin/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '发送测试推送' }));
    await waitFor(() =>
      expect(screen.getByText('测试推送已发出，请检查接收端是否收到')).toBeInTheDocument(),
    );

    mockedTest.mockResolvedValueOnce({
      sent: false,
      configured: true,
      reason: '上游返回 HTTP 500',
    });
    fireEvent.click(screen.getByRole('button', { name: '发送测试推送' }));
    await waitFor(() =>
      expect(screen.getByText('测试推送未送达：上游返回 HTTP 500')).toBeInTheDocument(),
    );

    mockedTest.mockResolvedValueOnce({ sent: false, configured: false });
    fireEvent.click(screen.getByRole('button', { name: '发送测试推送' }));
    await waitFor(() =>
      expect(screen.getByText('尚未配置 Webhook 地址，无法测试')).toBeInTheDocument(),
    );
  });

  it('清除设置页配置：提交 null 并回显未配置', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText(/qyapi\.weixin/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '清除设置页配置' }));

    await waitFor(() =>
      expect(mockedSave).toHaveBeenCalledWith({ alertWebhook: { url: null, timeoutMs: null } }),
    );
    await waitFor(() => expect(screen.getByText('未配置')).toBeInTheDocument());
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('读取失败展示原因与重试入口', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('后端连接失败'));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('设置读取失败'));
    expect(screen.getByText(/后端连接失败/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText(/qyapi\.weixin/)).toBeInTheDocument());
  });
});
