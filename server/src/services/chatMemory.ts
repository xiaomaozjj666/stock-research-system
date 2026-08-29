/**
 * 对话长期记忆（轻量、落盘）
 * ----------------------------------------------------------------------------
 * 按 sessionId 把对话轮次持久化到 server/data/chatHistory.json（单文件、按 session 数组）。
 * 重启后仍能回忆历史；超过上限自动截断最旧轮次。所有 IO 错误静默降级为无记忆。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_HISTORY_FILE = path.join(import.meta.dirname, '..', 'data', 'chatHistory.json');
/** 每个 session 保留的最大轮次数（1 轮 = user+assistant） */
export const MAX_TURNS = 40;
/** 最多保留的 session 数：超出时淘汰最旧的 session，防止文件被无限刷大 */
export const MAX_SESSIONS = 200;
/** sessionId 白名单：客户端生成格式为 `sess-` + base36；拒绝超长串与非法字符 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `prototype` 不在 Object.prototype 上（在 Function.prototype 上），需显式拒绝 */
const RESERVED_KEYS = new Set(['prototype']);

function isValidSessionId(sessionId: string): boolean {
  // `__proto__`/`constructor`/`toString`/`valueOf` 等全部命中 Object.prototype 继承键，
  // 一并拒绝——charset 白名单挡不住全由合法字符组成的原型链键
  return (
    SESSION_ID_RE.test(sessionId) &&
    !(sessionId in Object.prototype) &&
    !RESERVED_KEYS.has(sessionId)
  );
}

/**
 * 仅读取自身属性：charset 白名单挡不住 `toString`/`valueOf` 这类同样匹配白名单的
 * Object.prototype 继承键，必须用 hasOwnProperty 把访问限制在 JSON 落盘的真实数据上。
 */
function getOwnTurns(store: Store, sessionId: string): ChatTurn[] | undefined {
  return Object.prototype.hasOwnProperty.call(store, sessionId) ? store[sessionId] : undefined;
}

function hasOwnKey(store: Store, sessionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(store, sessionId);
}

type Store = Record<string, ChatTurn[]>;

/**
 * 运行时解析落盘路径：支持 CHAT_HISTORY_FILE 环境变量重定向（与 watchlist/paper/audit 同模式）。
 * 惰性解析而非模块级常量，测试可在 beforeAll 中设置 env 后生效。
 */
function getHistoryFile(): string {
  return process.env.CHAT_HISTORY_FILE && process.env.CHAT_HISTORY_FILE.length > 0
    ? process.env.CHAT_HISTORY_FILE
    : DEFAULT_HISTORY_FILE;
}

function readStore(): Store {
  try {
    const file = getHistoryFile();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    const file = getHistoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // 磁盘写入失败：静默降级（不阻断对话）
  }
}

export function loadHistory(sessionId: string): ChatTurn[] {
  if (!isValidSessionId(sessionId)) return [];
  const store = readStore();
  return getOwnTurns(store, sessionId) ?? [];
}

export function appendTurn(sessionId: string, turn: ChatTurn): void {
  if (!isValidSessionId(sessionId)) return; // 非法/保留键不落盘
  const store = readStore();
  const isNewSession = !hasOwnKey(store, sessionId);
  const list = getOwnTurns(store, sessionId) ?? [];
  list.push(turn);
  // 截断：保留最近 MAX_TURNS*2 条（user+assistant 成对）
  if (list.length > MAX_TURNS * 2) {
    store[sessionId] = list.slice(list.length - MAX_TURNS * 2);
  } else {
    store[sessionId] = list;
  }
  // session 数上限：新增 session 超出配额时，按写入顺序淘汰最旧的 session
  if (isNewSession) {
    const keys = Object.keys(store);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) {
      delete store[key];
    }
  }
  writeStore(store);
}

/** 测试/管理用：清空某 session 或全部 */
export function clearHistory(sessionId?: string): void {
  if (!sessionId) {
    writeStore({});
    return;
  }
  const store = readStore();
  delete store[sessionId];
  writeStore(store);
}
