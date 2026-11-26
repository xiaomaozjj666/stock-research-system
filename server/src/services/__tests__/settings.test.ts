/**
 * settings 运行时设置服务
 * ----------------------------------------------------------------------------
 * 锁定的语义：
 *  - 优先级：设置文件 > 环境变量 > 默认值；
 *  - 保存前校验、非法值如实报错（不静默夹紧）；nil/空串 = 清除该项；
 *  - 文件损坏时读取按默认值继续，保存时先把坏文件留档再重写；
 *  - URL 只以脱敏形式对外展示（key/token 等同凭据）；
 *  - 读取带 mtime 缓存，外部改写能被发现。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  MAX_HISTORY_MAX_ITEMS,
  maskWebhookUrl,
  readSettings,
  resetSettingsCache,
  resolveAlertWebhookConfig,
  resolveHistoryMaxItems,
  saveSettings,
  settingsFilePath,
} from '../settings.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'settings-svc-'));
const settingsFile = join(tmpDir, 'settings.json');
const original = {
  file: process.env.SETTINGS_FILE,
  url: process.env.ALERT_WEBHOOK_URL,
  timeout: process.env.ALERT_WEBHOOK_TIMEOUT_MS,
};

beforeAll(() => {
  process.env.SETTINGS_FILE = settingsFile;
});
afterAll(() => {
  for (const [key, value] of [
    ['SETTINGS_FILE', original.file],
    ['ALERT_WEBHOOK_URL', original.url],
    ['ALERT_WEBHOOK_TIMEOUT_MS', original.timeout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSettingsCache();
  rmSync(settingsFile, { force: true });
  for (const f of readdirSync(tmpDir)) {
    if (f.includes('.corrupt-')) rmSync(join(tmpDir, f), { force: true });
  }
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_WEBHOOK_TIMEOUT_MS;
});

describe('settings 读取与优先级', () => {
  it('默认指向数据目录下的 settings.json，未配置时读取为空设置', () => {
    const savedFile = process.env.SETTINGS_FILE;
    delete process.env.SETTINGS_FILE;
    try {
      expect(settingsFilePath()).toMatch(/settings\.json$/);
    } finally {
      process.env.SETTINGS_FILE = savedFile;
    }
    expect(readSettings()).toEqual({});
    expect(resolveAlertWebhookConfig()).toBeNull();
    expect(resolveHistoryMaxItems(2000, null)).toEqual({ value: 2000, source: 'default' });
  });

  it('环境变量作为基线；设置页写入后覆盖环境变量', () => {
    process.env.ALERT_WEBHOOK_URL = 'https://env.example.com/hook?key=env-secret';
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = '1500';
    expect(resolveAlertWebhookConfig()).toEqual({
      url: 'https://env.example.com/hook?key=env-secret',
      timeoutMs: 1500,
      source: 'env',
    });

    expect(saveSettings({ alertWebhookUrl: 'https://ui.example.com/bot/ui-token' }).ok).toBe(true);
    const resolved = resolveAlertWebhookConfig();
    expect(resolved).toMatchObject({ source: 'settings', timeoutMs: 1500 }); // 未设超时仍沿用 env
    expect(resolved!.url).toBe('https://ui.example.com/bot/ui-token');
  });

  it('清除设置项后回退到环境变量', () => {
    process.env.ALERT_WEBHOOK_URL = 'https://env.example.com/hook';
    saveSettings({ alertWebhookUrl: 'https://ui.example.com/hook', alertWebhookTimeoutMs: 800 });
    saveSettings({ alertWebhookUrl: null, alertWebhookTimeoutMs: null });
    expect(resolveAlertWebhookConfig()).toMatchObject({
      url: 'https://env.example.com/hook',
      source: 'env',
      timeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS,
    });
  });

  it('超时环境变量夹紧到 [500,10000]，非法值回落默认', () => {
    process.env.ALERT_WEBHOOK_URL = 'https://env.example.com/hook';
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = '10';
    expect(resolveAlertWebhookConfig()!.timeoutMs).toBe(500);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = '999999';
    expect(resolveAlertWebhookConfig()!.timeoutMs).toBe(10_000);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = 'abc';
    expect(resolveAlertWebhookConfig()!.timeoutMs).toBe(DEFAULT_WEBHOOK_TIMEOUT_MS);
  });

  it('非法环境变量 URL（非 http/https）视为未配置', () => {
    process.env.ALERT_WEBHOOK_URL = 'ftp://example.com/hook';
    expect(resolveAlertWebhookConfig()).toBeNull();
  });

  it('设置文件里的脏字段读取时被忽略，不污染生效配置', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        alertWebhookUrl: 'javascript:alert(1)',
        alertWebhookTimeoutMs: 99_999,
        historyMaxItems: -1,
      }),
      'utf-8',
    );
    expect(readSettings()).toEqual({});
    expect(resolveAlertWebhookConfig()).toBeNull();
  });

  it('历史容量：设置文件 > 环境变量 > 默认值', () => {
    expect(resolveHistoryMaxItems(2000, 100)).toEqual({ value: 100, source: 'env' });
    saveSettings({ historyMaxItems: 800 });
    expect(resolveHistoryMaxItems(2000, 100)).toEqual({ value: 800, source: 'settings' });
  });

  it('外部改写设置文件后按 mtime 失效缓存', () => {
    expect(readSettings()).toEqual({});
    writeFileSync(settingsFile, JSON.stringify({ historyMaxItems: 123 }), 'utf-8');
    // 显式推进 mtime，避免同一毫秒/文件系统精度导致缓存未失效
    const future = new Date(Date.now() + 5000);
    utimesSync(settingsFile, future, future);
    expect(readSettings().historyMaxItems).toBe(123);
  });
});

describe('settings 保存校验与留档', () => {
  it('合法补丁写入后立即生效', () => {
    expect(
      saveSettings({
        alertWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
        alertWebhookTimeoutMs: 2000,
        historyMaxItems: 500,
      }),
    ).toEqual({ ok: true });
    expect(readSettings()).toEqual({
      alertWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
      alertWebhookTimeoutMs: 2000,
      historyMaxItems: 500,
    });
  });

  it('非法值返回可读错误，且不写入任何内容', () => {
    expect(saveSettings({ alertWebhookUrl: 'not-a-url' })).toMatchObject({ ok: false });
    expect(saveSettings({ alertWebhookUrl: 'ftp://example.com/hook' })).toMatchObject({
      ok: false,
    });
    expect(saveSettings({ alertWebhookUrl: `https://e.com/${'a'.repeat(2100)}` })).toMatchObject({
      ok: false,
    });
    expect(saveSettings({ alertWebhookTimeoutMs: 100 })).toMatchObject({ ok: false });
    expect(saveSettings({ alertWebhookTimeoutMs: 20_000 })).toMatchObject({ ok: false });
    expect(saveSettings({ alertWebhookTimeoutMs: 1500.5 })).toMatchObject({ ok: false });
    expect(saveSettings({ historyMaxItems: 0 })).toMatchObject({ ok: false });
    expect(saveSettings({ historyMaxItems: MAX_HISTORY_MAX_ITEMS + 1 })).toMatchObject({
      ok: false,
    });
    expect(readSettings()).toEqual({});
  });

  it('空字符串等价于清除该项', () => {
    saveSettings({ alertWebhookUrl: 'https://e.com/hook', historyMaxItems: 300 });
    expect(saveSettings({ alertWebhookUrl: '   ' })).toEqual({ ok: true });
    expect(readSettings().alertWebhookUrl).toBeUndefined();
    expect(readSettings().historyMaxItems).toBe(300); // 未提交的字段保持
  });

  it('设置文件损坏时读取按默认值，保存会先把坏文件留档再重写', () => {
    writeFileSync(settingsFile, '{ broken json', 'utf-8');
    expect(readSettings()).toEqual({});

    expect(saveSettings({ historyMaxItems: 50 })).toEqual({ ok: true });
    const backups = readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tmpDir, backups[0]), 'utf-8')).toBe('{ broken json');
    expect(readSettings().historyMaxItems).toBe(50);
  });

  it('写盘失败时返回可读错误（界面需如实提示没保存上）', () => {
    process.env.SETTINGS_FILE = tmpDir; // 目标是目录，rename 必失败
    resetSettingsCache();
    try {
      const result = saveSettings({ historyMaxItems: 50 });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/写入失败/);
    } finally {
      process.env.SETTINGS_FILE = settingsFile;
      resetSettingsCache();
    }
  });
});

describe('maskWebhookUrl', () => {
  it('隐藏 query 与 path 中的凭据，只留主机与一级路径', () => {
    expect(maskWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret')).toBe(
      'https://qyapi.weixin.qq.com/…',
    );
    expect(maskWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/token-123')).toBe(
      'https://open.feishu.cn/…',
    );
    expect(maskWebhookUrl('https://example.com')).toBe('https://example.com/…');
  });

  it('非法地址不会原样回显', () => {
    expect(maskWebhookUrl('not-a-url')).toBe('（地址非法）');
  });
});
