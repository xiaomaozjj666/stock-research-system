/**
 * 研究历史记录（轻量、落盘）
 * ----------------------------------------------------------------------------
 * 每次股票分析完成时自动保存（同股票代码去重更新，保持每只股票仅一条最新记录），
 * 前端历史页可列出、回看（恢复完整分析结果）与删除。
 *
 * 持久化：单 JSON 文件（HISTORY_FILE env 可重定向，与 watchlist/paper/audit 同模式），
 * "临时文件 + 原子 rename"写入；容量超上限时淘汰最旧记录；所有 IO 错误静默降级。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisResult } from '../types.js';

/** 历史记录条目的摘要字段（列表接口返回，不携带完整 result） */
export interface HistorySummary {
  id: string;
  stockCode: string;
  stockName: string;
  createdAt: string;
  rating: string;
  totalScore: number;
  industry?: string;
}

/** 历史记录完整条目（详情接口返回，result 可恢复研究报告渲染） */
export interface HistoryItem extends HistorySummary {
  result: AnalysisResult;
}

/** 新增/更新历史时提交的内容 */
export interface HistoryEntryInput {
  stockCode: string;
  stockName: string;
  industry?: string;
  rating: string;
  totalScore: number;
  result: AnalysisResult;
}

interface HistoryStore {
  items: HistoryItem[];
}

const DEFAULT_HISTORY_FILE = path.join(import.meta.dirname, '..', 'data', 'history.json');
/** 历史记录容量上限：超出后淘汰最旧记录 */
export const MAX_HISTORY_ITEMS = 100;

/**
 * 运行时解析落盘路径：支持 HISTORY_FILE 环境变量重定向（与 watchlist/paper/audit 同模式）。
 * 惰性解析而非模块级常量，测试可在 beforeAll 中设置 env 后生效。
 */
function getHistoryFile(): string {
  return process.env.HISTORY_FILE && process.env.HISTORY_FILE.length > 0
    ? process.env.HISTORY_FILE
    : DEFAULT_HISTORY_FILE;
}

function readStore(): HistoryStore {
  try {
    const file = getHistoryFile();
    if (!fs.existsSync(file)) return { items: [] };
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as HistoryStore;
    return parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    // 文件损坏/不可读：视为空历史（不阻断）
    return { items: [] };
  }
}

function writeStore(store: HistoryStore): boolean {
  try {
    const file = getHistoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 原子替换，避免半写状态
    return true;
  } catch {
    return false;
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 保存/更新一条历史记录：同股票代码去重（更新为最新分析，id 保留），
 * 容量超上限时淘汰最旧记录。返回保存后的条目；写盘失败返回 null（不阻断分析主流程）。
 */
export function saveHistoryEntry(input: HistoryEntryInput): HistoryItem | null {
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store.items.find((it) => it.stockCode === input.stockCode);

  let saved: HistoryItem;
  if (existing) {
    existing.stockName = input.stockName;
    existing.industry = input.industry;
    existing.rating = input.rating;
    existing.totalScore = input.totalScore;
    existing.result = input.result;
    existing.createdAt = now;
    saved = existing;
  } else {
    saved = {
      id: makeId(),
      stockCode: input.stockCode,
      stockName: input.stockName,
      industry: input.industry,
      rating: input.rating,
      totalScore: input.totalScore,
      createdAt: now,
      result: input.result,
    };
    store.items.push(saved);
  }

  // 容量上限：按时间倒序保留最新 MAX_HISTORY_ITEMS 条
  if (store.items.length > MAX_HISTORY_ITEMS) {
    store.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    store.items = store.items.slice(0, MAX_HISTORY_ITEMS);
  }

  if (!writeStore(store)) return null;
  return saved;
}

/** 历史列表（倒序，最新在前；不含完整 result，仅摘要字段） */
export function listHistory(limit = 50): HistorySummary[] {
  const store = readStore();
  return store.items
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 200)))
    .map(({ result: _result, ...summary }) => summary);
}

/** 历史详情（含完整 result，供前端恢复研究报告） */
export function getHistoryItem(id: string): HistoryItem | null {
  const store = readStore();
  return store.items.find((it) => it.id === id) ?? null;
}

/** 删除一条历史记录；返回是否删除成功 */
export function deleteHistoryItem(id: string): boolean {
  const store = readStore();
  const next = store.items.filter((it) => it.id !== id);
  if (next.length === store.items.length) return false;
  store.items = next;
  return writeStore(store);
}
