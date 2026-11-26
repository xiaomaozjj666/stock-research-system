/**
 * 运行时设置（可持久化、可在界面里改）
 * ----------------------------------------------------------------------------
 * 此前所有可调项都只能改 `server/.env` 再重启：告警 Webhook、历史容量这类
 * 「部署后才会调」的参数，普通用户既找不到位置、也不敢直接改环境变量。
 * 这里提供一层极小的持久化设置（`server/data/settings.json`，`SETTINGS_FILE`
 * 可重定向），由 `/api/settings` 读写、前端「设置」页编辑。
 *
 * 优先级：设置文件 > 环境变量 > 代码默认值。
 * 刻意保持这个顺序——界面上的改动必须立刻生效；环境变量仍是无人值守部署的
 * 基线（清空设置项即回到环境变量）。
 *
 * 设计约束：
 *  - 只收录真正需要运行时调整的少量字段，不做通用 key-value 配置中心。
 *  - 所有字段写入前校验；非法值返回可读错误，**不静默夹紧**（静默夹紧会让用户
 *    以为已生效）。读取侧仍对历史脏数据做净化，坏字段直接忽略。
 *  - 原子写（tmp + rename）；读失败/文件损坏按默认设置继续（写时先把坏文件
 *    留档再重写，不静默覆盖唯一副本）。
 *  - 读取带 mtime 缓存：`historyMaxItems()` 每次保存都会问一次，不能每次都读盘。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DATA_ROOT } from '../dataRoot.js';
import logger from '../utils/logger.js';
import { HISTORY_MAX_ITEMS_HARD_LIMIT } from './historyLimits.js';

/** 设置文件结构（全部可选；缺省 = 该字段未在界面里覆盖） */
export interface StoredSettings {
  /** 异动预警外部推送地址（http/https） */
  alertWebhookUrl?: string;
  /** 推送超时毫秒数（500–10000） */
  alertWebhookTimeoutMs?: number;
  /** 研究历史保留条数（1–50000） */
  historyMaxItems?: number;
}

/** 可提交的设置补丁：null = 清除该项（回到环境变量/默认值），undefined = 保持不变 */
export interface SettingsPatch {
  alertWebhookUrl?: string | null;
  alertWebhookTimeoutMs?: number | null;
  historyMaxItems?: number | null;
}

export const MIN_WEBHOOK_TIMEOUT_MS = 500;
export const MAX_WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 3000;
export const MIN_HISTORY_MAX_ITEMS = 1;
/** 与历史服务共用同一硬上限（避免界面允许值与服务端校验值漂移） */
export const MAX_HISTORY_MAX_ITEMS = HISTORY_MAX_ITEMS_HARD_LIMIT;
/** URL 长度上限：防止把一个超长串写进设置文件并原样回显 */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

const DEFAULT_SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');

/** 设置文件路径：每次调用时解析（`SETTINGS_FILE` 供测试/运维重定向） */
export function settingsFilePath(): string {
  const explicit = process.env.SETTINGS_FILE?.trim();
  return explicit && explicit.length > 0 ? explicit : DEFAULT_SETTINGS_FILE;
}

interface CacheEntry {
  file: string;
  mtimeMs: number | null;
  settings: StoredSettings;
}
let cache: CacheEntry | null = null;

/** 清空内存缓存：测试隔离或外部改写后强制重读 */
export function resetSettingsCache(): void {
  cache = null;
}

/** 仅接受 http/https（`javascript:` / `file:` 等一律视为误配） */
export function isHttpWebhookUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 日志/界面里展示的脱敏地址：只保留协议 + 主机，其余一律省略。
 * 企业微信的 key 在 query、飞书的 hook token 在 path 里，都等同凭据；
 * 自定义网关也可能把凭据放在任意路径段，因此不保留任何路径信息。
 */
export function maskWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return '（地址非法）';
  }
}

function sanitizeSettings(raw: unknown): StoredSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const body = raw as Record<string, unknown>;
  const out: StoredSettings = {};

  const url = body.alertWebhookUrl;
  if (typeof url === 'string') {
    const trimmed = url.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= MAX_WEBHOOK_URL_LENGTH &&
      isHttpWebhookUrl(trimmed)
    ) {
      out.alertWebhookUrl = trimmed;
    }
  }

  const timeout = Number(body.alertWebhookTimeoutMs);
  if (
    Number.isInteger(timeout) &&
    timeout >= MIN_WEBHOOK_TIMEOUT_MS &&
    timeout <= MAX_WEBHOOK_TIMEOUT_MS
  ) {
    out.alertWebhookTimeoutMs = timeout;
  }

  const maxItems = Number(body.historyMaxItems);
  if (
    Number.isInteger(maxItems) &&
    maxItems >= MIN_HISTORY_MAX_ITEMS &&
    maxItems <= MAX_HISTORY_MAX_ITEMS
  ) {
    out.historyMaxItems = maxItems;
  }

  return out;
}

/**
 * 读取设置（带 mtime 缓存）。文件不存在 → 空设置；损坏/不可读 → 空设置并留 warning，
 * 下次调用仍会重试（不把「一次读失败」永久固化成「永远没有设置」）。
 */
export function readSettings(): StoredSettings {
  const file = settingsFilePath();
  if (cache && cache.file === file) {
    try {
      const st = fs.statSync(file);
      if (cache.mtimeMs !== null && st.mtimeMs === cache.mtimeMs) return cache.settings;
    } catch {
      if (cache.mtimeMs === null) return cache.settings;
    }
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { file, mtimeMs: null, settings: {} };
      return cache.settings;
    }
    logger.warn('设置文件读取失败，本次按默认设置运行', { file, err: error });
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // 缓存「损坏」这一结论（按 mtime）：否则每次预警推送都读盘 + 打一条 warning，
    // 无人值守时会刷屏。文件被修好后 mtime 变化会自动重试。
    const mtimeMs = statMtime(file);
    cache = { file, mtimeMs, settings: {} };
    logger.warn('设置文件损坏，本次按默认设置运行（保存时会先留档坏文件）', { file, err: error });
    return cache.settings;
  }

  const settings = sanitizeSettings(parsed);
  cache = { file, mtimeMs: statMtime(file), settings };
  return settings;
}

/** 取 mtime；失败返回 null（不缓存，下次重读） */
function statMtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** 损坏的设置文件改名留档（`.corrupt-<ts>`），避免保存时静默覆盖 */
function quarantineCorruptSettings(file: string): void {
  // 只处理普通文件：路径被误配成目录时绝不 rename 目录（会把整棵目录搬走）
  try {
    if (!fs.statSync(file).isFile()) return;
  } catch {
    return;
  }
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    logger.warn('设置文件损坏，已改名留档后重写', { file });
  } catch (error) {
    logger.warn('设置文件损坏且无法留档，将直接覆盖', { file, err: error });
  }
}

/**
 * 合并并保存设置补丁。校验失败返回 `{ ok: false, error }`（可读中文），
 * 写盘失败同样返回失败——界面需要如实告诉用户「没保存上」。
 */
export function saveSettings(patch: SettingsPatch): { ok: true } | { ok: false; error: string } {
  const current = readSettings();
  const next: StoredSettings = { ...current };

  if (patch.alertWebhookUrl !== undefined) {
    if (patch.alertWebhookUrl === null) {
      delete next.alertWebhookUrl;
    } else {
      const trimmed = patch.alertWebhookUrl.trim();
      if (trimmed === '') {
        delete next.alertWebhookUrl;
      } else {
        if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
          return { ok: false, error: `Webhook 地址过长（上限 ${MAX_WEBHOOK_URL_LENGTH} 字符）` };
        }
        if (!isHttpWebhookUrl(trimmed)) {
          return { ok: false, error: 'Webhook 地址必须是 http:// 或 https:// 开头的合法 URL' };
        }
        next.alertWebhookUrl = trimmed;
      }
    }
  }

  if (patch.alertWebhookTimeoutMs !== undefined) {
    if (patch.alertWebhookTimeoutMs === null) {
      delete next.alertWebhookTimeoutMs;
    } else {
      const ms = patch.alertWebhookTimeoutMs;
      if (!Number.isInteger(ms) || ms < MIN_WEBHOOK_TIMEOUT_MS || ms > MAX_WEBHOOK_TIMEOUT_MS) {
        return {
          ok: false,
          error: `推送超时必须是 ${MIN_WEBHOOK_TIMEOUT_MS}–${MAX_WEBHOOK_TIMEOUT_MS} 之间的整数毫秒`,
        };
      }
      next.alertWebhookTimeoutMs = ms;
    }
  }

  if (patch.historyMaxItems !== undefined) {
    if (patch.historyMaxItems === null) {
      delete next.historyMaxItems;
    } else {
      const n = patch.historyMaxItems;
      if (!Number.isInteger(n) || n < MIN_HISTORY_MAX_ITEMS || n > MAX_HISTORY_MAX_ITEMS) {
        return {
          ok: false,
          error: `历史保留条数必须是 ${MIN_HISTORY_MAX_ITEMS}–${MAX_HISTORY_MAX_ITEMS} 之间的整数`,
        };
      }
      next.historyMaxItems = n;
    }
  }

  const file = settingsFilePath();
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 只在文件确实损坏时才留档：正常文件直接原子替换
    if (fs.existsSync(file)) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        quarantineCorruptSettings(file);
      }
    }
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    cache = { file, mtimeMs: fs.statSync(file).mtimeMs, settings: next };
    return { ok: true };
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不再抛 */
    }
    logger.warn('设置保存失败', { file, err: error });
    return { ok: false, error: '设置写入失败，请检查数据目录权限' };
  }
}

export type SettingsSource = 'settings' | 'env' | 'default';

/** 预警推送的最终生效配置 */
export interface ResolvedAlertWebhook {
  url: string;
  timeoutMs: number;
  source: 'settings' | 'env';
}

function envTimeoutMs(): number | null {
  const raw = process.env.ALERT_WEBHOOK_TIMEOUT_MS?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_WEBHOOK_TIMEOUT_MS, Math.max(MIN_WEBHOOK_TIMEOUT_MS, Math.floor(n)));
}

/**
 * 解析预警 Webhook：设置文件优先，其次环境变量；都未配置 → null（关闭推送）。
 * 设置文件里的值在读取时已净化，因此这里只需再判一次协议。
 */
export function resolveAlertWebhookConfig(): ResolvedAlertWebhook | null {
  const settings = readSettings();
  if (settings.alertWebhookUrl && isHttpWebhookUrl(settings.alertWebhookUrl)) {
    return {
      url: settings.alertWebhookUrl,
      timeoutMs: settings.alertWebhookTimeoutMs ?? envTimeoutMs() ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
      source: 'settings',
    };
  }
  const envUrl = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!envUrl || !isHttpWebhookUrl(envUrl)) return null;
  return { url: envUrl, timeoutMs: envTimeoutMs() ?? DEFAULT_WEBHOOK_TIMEOUT_MS, source: 'env' };
}

/**
 * 解析研究历史保留条数：设置文件 > HISTORY_MAX_ITEMS > 默认值。
 * 非法环境变量静默回落默认值——一条写错的 env 不该把历史裁成 0 条。
 */
export function resolveHistoryMaxItems(
  fallback: number,
  envOverride: number | null,
): { value: number; source: SettingsSource } {
  const settings = readSettings();
  if (typeof settings.historyMaxItems === 'number') {
    return { value: settings.historyMaxItems, source: 'settings' };
  }
  if (envOverride !== null) return { value: envOverride, source: 'env' };
  return { value: fallback, source: 'default' };
}
