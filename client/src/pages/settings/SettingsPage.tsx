import { useCallback, useEffect, useState } from 'react';
import {
  fetchSettings,
  normalizeApiError,
  saveSettings,
  sendTestWebhook,
  type SettingsPatch,
  type SettingsResponse,
} from '../../api/client';

/**
 * 设置页。
 * ----------------------------------------------------------------------------
 * 此前告警 Webhook、历史容量只能改 `server/.env` 再重启：普通用户既找不到，
 * 也不敢直接动环境变量。这里把「部署后才会调」的两项收进界面，保存即生效。
 *
 * 约定（与服务端一致）：
 *  - 优先级：设置页 > 环境变量 > 默认值；清空设置项即回退；
 *  - Webhook 地址只回显脱敏后的主机与一级路径（key/token 等同凭据），
 *    要修改必须重新输入完整地址，输入框刻意不预填；
 *  - 「测试推送」走与真实预警完全相同的 POST 链路，未配置时如实提示而不是静默成功。
 */

const SOURCE_LABEL: Record<string, string> = {
  settings: '设置页',
  env: '环境变量',
  none: '未配置',
  default: '默认值',
};

type Feedback = { kind: 'ok' | 'err'; text: string } | null;

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // 输入框全部用字符串维护：空串 = 「保持原值」，避免被 number 输入的 0 语义误伤
  const [urlInput, setUrlInput] = useState('');
  const [timeoutInput, setTimeoutInput] = useState('3000');
  const [maxItemsInput, setMaxItemsInput] = useState('2000');

  const applyData = useCallback((next: SettingsResponse) => {
    setData(next);
    setUrlInput('');
    setTimeoutInput(String(next.alertWebhook.timeoutMs));
    setMaxItemsInput(String(next.history.maxItems));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      applyData(await fetchSettings());
    } catch (error: unknown) {
      setLoadError(normalizeApiError(error, '设置读取失败').message);
    } finally {
      setLoading(false);
    }
  }, [applyData]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!data) return;

      const timeoutMs = Number(timeoutInput);
      const maxItems = Number(maxItemsInput);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000) {
        setFeedback({ kind: 'err', text: '推送超时需为 500–10000 之间的整数毫秒' });
        return;
      }
      if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > data.history.hardMaxItems) {
        setFeedback({
          kind: 'err',
          text: `历史保留条数需为 1–${data.history.hardMaxItems} 之间的整数`,
        });
        return;
      }

      const patch: SettingsPatch = {
        alertWebhook: { timeoutMs },
        history: { maxItems },
      };
      const url = urlInput.trim();
      if (url !== '') patch.alertWebhook = { ...patch.alertWebhook, url };

      setSaving(true);
      setFeedback(null);
      try {
        applyData(await saveSettings(patch));
        setFeedback({ kind: 'ok', text: '设置已保存并立即生效' });
      } catch (error: unknown) {
        setFeedback({ kind: 'err', text: normalizeApiError(error, '设置保存失败').message });
      } finally {
        setSaving(false);
      }
    },
    [applyData, data, maxItemsInput, timeoutInput, urlInput],
  );

  /** 清空 Webhook 设置：回退到环境变量（若也未配置则关闭外部推送） */
  const handleClearWebhook = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    setFeedback(null);
    try {
      applyData(await saveSettings({ alertWebhook: { url: null, timeoutMs: null } }));
      setFeedback({ kind: 'ok', text: '已清除设置页的 Webhook，回退到环境变量配置' });
    } catch (error: unknown) {
      setFeedback({ kind: 'err', text: normalizeApiError(error, '清除失败').message });
    } finally {
      setSaving(false);
    }
  }, [applyData, data]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setFeedback(null);
    try {
      const result = await sendTestWebhook();
      if (!result.configured) {
        setFeedback({ kind: 'err', text: '尚未配置 Webhook 地址，无法测试' });
      } else if (result.sent) {
        setFeedback({ kind: 'ok', text: '测试推送已发出，请检查接收端是否收到' });
      } else {
        setFeedback({
          kind: 'err',
          text: `测试推送未送达：${result.reason ?? '未知原因'}`,
        });
      }
    } catch (error: unknown) {
      setFeedback({ kind: 'err', text: normalizeApiError(error, '测试推送失败').message });
    } finally {
      setTesting(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="settings-page">
        <p className="settings-loading" role="status">
          设置加载中…
        </p>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="settings-page">
        <div className="error-banner" role="alert">
          <div className="error-banner-body">
            <span className="error-banner-icon" aria-hidden="true">
              !
            </span>
            <span className="error-banner-text">设置读取失败：{loadError}</span>
          </div>
          <button className="error-banner-retry" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const webhook = data.alertWebhook;
  const history = data.history;

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>设置</h2>
        <p className="history-sub">
          运行时配置，保存后立即生效、无需重启。设置页的优先级高于 <code>.env</code>{' '}
          环境变量；清空某项即回退到环境变量或默认值。
        </p>
      </header>

      {/* noValidate：用页面内一致的中文错误提示，而不是浏览器原生气泡（样式与文案都不可控） */}
      <form className="settings-grid" noValidate onSubmit={(e) => void handleSave(e)}>
        <section className="card settings-card">
          <div className="settings-card-head">
            <h3 className="quant-panel-title">异动预警 Webhook</h3>
            <span className={`settings-badge ${webhook.configured ? 'on' : 'off'}`}>
              {webhook.configured ? '已配置' : '未配置'}
            </span>
          </div>
          <p className="settings-hint">
            自选股监控发现强烈异动时，把同一条快照 POST 到该地址（企业微信 /
            飞书机器人、自建网关均可）。 未配置时预警只在「今日」页内展示，不会外发。
          </p>
          <p className="settings-current">
            当前地址：<code>{webhook.urlMasked ?? '—'}</code>
            <span className="settings-meta">
              来源：{SOURCE_LABEL[webhook.source] ?? webhook.source}
            </span>
          </p>

          <div className="settings-field">
            <label htmlFor="settings-webhook-url">Webhook 地址</label>
            <input
              id="settings-webhook-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder={
                webhook.configured ? '已配置；输入新地址可替换（留空保持不变）' : 'https://…'
              }
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
            />
            <span className="settings-hint">
              出于安全考虑不回显完整地址；地址中的 key / token 等同凭据。
            </span>
          </div>

          <div className="settings-field">
            <label htmlFor="settings-webhook-timeout">推送超时（毫秒）</label>
            <input
              id="settings-webhook-timeout"
              type="number"
              min={500}
              max={10_000}
              step={100}
              value={timeoutInput}
              onChange={(e) => setTimeoutInput(e.target.value)}
            />
            <span className="settings-hint">
              500–10000，默认 3000。超时会中止连接，不会拖住监控。
            </span>
          </div>

          <div className="settings-actions">
            <button className="btn-primary" type="submit" disabled={saving || testing}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              className="btn-ghost"
              type="button"
              onClick={() => void handleTest()}
              disabled={saving || testing}
            >
              {testing ? '发送中…' : '发送测试推送'}
            </button>
            <button
              className="btn-ghost"
              type="button"
              onClick={() => void handleClearWebhook()}
              disabled={saving || testing}
            >
              清除设置页配置
            </button>
          </div>
        </section>

        <section className="card settings-card">
          <div className="settings-card-head">
            <h3 className="quant-panel-title">研究历史容量</h3>
            <span className="settings-badge neutral">SQLite</span>
          </div>
          <p className="settings-hint">
            研究历史已改用 SQLite 持久层，默认保留 {history.defaultMaxItems} 条（旧版为 100
            条）。调低上限后会立即裁剪最旧记录；数据文件为 <code>server/data/history.db</code>。
          </p>
          <p className="settings-current">
            当前生效：<code>{history.maxItems} 条</code>
            <span className="settings-meta">
              来源：{SOURCE_LABEL[history.source] ?? history.source}
            </span>
          </p>

          <div className="settings-field">
            <label htmlFor="settings-history-max">保留条数</label>
            <input
              id="settings-history-max"
              type="number"
              min={1}
              max={history.hardMaxItems}
              step={1}
              value={maxItemsInput}
              onChange={(e) => setMaxItemsInput(e.target.value)}
            />
            <span className="settings-hint">
              1–{history.hardMaxItems}，默认 {history.defaultMaxItems}。
            </span>
          </div>

          <div className="settings-actions">
            <button className="btn-primary" type="submit" disabled={saving || testing}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </section>
      </form>

      {feedback && (
        <p
          className={`settings-feedback ${feedback.kind}`}
          role={feedback.kind === 'err' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}
