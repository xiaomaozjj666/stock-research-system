import * as fs from 'fs';
import * as path from 'path';

import { DATA_ROOT } from '../dataRoot.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import { calculateExecutionCosts, resolveCloseFill } from '../quant/paperTrading.js';

export type ThesisMetric = 'close_price' | 'return_pct' | 'excess_return_pct';
export type ThesisComparator = 'gt' | 'gte' | 'lt' | 'lte';
export type ThesisStatus = 'active' | 'invalidated' | 'expired';
export type ThesisEvidenceStatus =
  'pending' | 'sufficient' | 'insufficient_evidence' | 'no_execution';

export interface ThesisExecutionRule {
  side: 'buy';
  orderType: 'market' | 'limit';
  entryPrice: number;
  quantity: number;
  limitPrice?: number;
  commissionRate: number;
  stampDutyRate: number;
}

export interface CreateThesisInput {
  stockCode: string;
  thesis: string;
  rating: string;
  totalScore?: number;
  metric: ThesisMetric;
  comparator: ThesisComparator;
  threshold: number;
  horizonDays: number;
  evidenceSource: 'real_ohlcv';
  invalidationAction: string;
  benchmarkCode: string;
  execution: ThesisExecutionRule;
}

export interface ThesisRecord extends CreateThesisInput {
  id: string;
  createdAt: string;
  dueAt: string;
  status: ThesisStatus;
  evidenceStatus: ThesisEvidenceStatus;
  evaluatedAt?: string;
  observedAt?: string;
  observedValue?: number;
  returnPct?: number;
  excessPct?: number;
  reason?: 'threshold_met' | 'threshold_not_met' | 'insufficient_evidence' | 'no_execution';
}

interface ThesisStore {
  items: ThesisRecord[];
}

const DEFAULT_FILE = path.join(DATA_ROOT, 'theses.json');
const MAX_THESIS_ITEMS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function storeFile(): string {
  return process.env.THESIS_FILE || DEFAULT_FILE;
}

function readStore(): ThesisStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as ThesisStore;
    return parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeStore(store: ThesisStore): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清理失败不改变主错误 */
    }
    throw error;
  }
}

let storeLock: Promise<void> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const result = storeLock.then(() => fn());
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const pctChange = (from: number, to: number) => ((to - from) / from) * 100;

function compare(value: number, comparator: ThesisComparator, threshold: number): boolean {
  if (comparator === 'gt') return value > threshold;
  if (comparator === 'gte') return value >= threshold;
  if (comparator === 'lt') return value < threshold;
  return value <= threshold;
}

function appendAndTrim(store: ThesisStore, item: ThesisRecord): void {
  store.items.push(item);
  if (store.items.length <= MAX_THESIS_ITEMS) return;
  const terminal = store.items.filter((item) => item.status !== 'active');
  const pool = terminal.length > 0 ? terminal : store.items;
  const oldest = pool.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  store.items = store.items.filter((item) => item.id !== oldest?.id);
}

/** 创建时完整冻结条件、期限、基准与成交口径；状态只能由评估流程推进。 */
export function createThesis(input: CreateThesisInput, now = new Date()): Promise<ThesisRecord> {
  return withStoreLock(() => {
    const store = readStore();
    const createdAt = now.toISOString();
    const quantity = Math.floor(input.execution.quantity / 100) * 100;
    const item: ThesisRecord = {
      ...input,
      execution: { ...input.execution, quantity },
      id: `thesis-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
      dueAt: new Date(now.getTime() + input.horizonDays * DAY_MS).toISOString(),
      status: 'active',
      evidenceStatus: 'pending',
    };
    appendAndTrim(store, item);
    writeStore(store);
    return item;
  });
}

export function listTheses(stockCode?: string): ThesisRecord[] {
  return readStore().items.filter((item) => !stockCode || item.stockCode === stockCode);
}

export function getThesis(id: string): ThesisRecord | null {
  return readStore().items.find((item) => item.id === id) ?? null;
}

/**
 * 到期后按创建时冻结的条件评估；到期前不改变 active。
 * 只接受创建后且观察日已经结束的 real OHLCV，杜绝模拟数据或未来 K 线回填。
 */
export function evaluateThesis(id: string, now = new Date()): Promise<ThesisRecord | null> {
  return withStoreLock(async () => {
    const store = readStore();
    const item = store.items.find((candidate) => candidate.id === id);
    if (!item || item.status !== 'active' || now.getTime() < new Date(item.dueAt).getTime()) {
      return item ?? null;
    }

    const start = item.createdAt.slice(0, 10);
    const end = now.toISOString().slice(0, 10);
    const [stockRows, benchmarkRows] = await Promise.all([
      fetchOHLCVData(item.stockCode, start, end).catch(() => []),
      item.metric === 'excess_return_pct'
        ? fetchOHLCVData(item.benchmarkCode, start, end).catch(() => [])
        : Promise.resolve([]),
    ]);
    const cutoff = Math.min(now.getTime(), new Date(item.dueAt).getTime());
    const validRows = stockRows
      .filter((row) => !row.isSimulated && row.close > 0)
      .filter((row) => {
        const observed = new Date(`${row.date}T23:59:59.999Z`).getTime();
        return observed >= new Date(item.createdAt).getTime() && observed <= cutoff;
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    if (validRows.length === 0 || stockRows.some((row) => row.isSimulated)) {
      item.status = 'expired';
      item.evidenceStatus = 'insufficient_evidence';
      item.reason = 'insufficient_evidence';
      item.evaluatedAt = now.toISOString();
      delete item.observedValue;
      delete item.returnPct;
      delete item.excessPct;
      writeStore(store);
      return item;
    }

    const latest = validRows[validRows.length - 1];
    const fill = resolveCloseFill({
      side: item.execution.side,
      type: item.execution.orderType,
      close: item.execution.entryPrice,
      price: item.execution.limitPrice,
      quantity: item.execution.quantity,
    });
    let returnPct: number | undefined;
    let excessPct: number | undefined;
    let observedValue = latest.close;
    let evidenceStatus: ThesisEvidenceStatus = 'sufficient';

    if (item.metric !== 'close_price') {
      if (!fill.filled || fill.fillPrice === null || fill.quantity <= 0) {
        item.status = 'expired';
        item.evidenceStatus = 'no_execution';
        item.reason = 'no_execution';
        item.evaluatedAt = now.toISOString();
        writeStore(store);
        return item;
      }
      const entry = calculateExecutionCosts(
        'buy',
        fill.quantity,
        fill.fillPrice,
        item.execution.commissionRate,
        item.execution.stampDutyRate,
      );
      const exit = calculateExecutionCosts(
        'sell',
        fill.quantity,
        latest.close,
        item.execution.commissionRate,
        item.execution.stampDutyRate,
      );
      returnPct = round2(pctChange(entry.cashFlow, exit.cashFlow));
      observedValue = returnPct;
      if (item.metric === 'excess_return_pct') {
        const usableBenchmark = benchmarkRows
          .filter((row) => !row.isSimulated && row.close > 0)
          .filter((row) => {
            const observed = new Date(`${row.date}T23:59:59.999Z`).getTime();
            return observed >= new Date(item.createdAt).getTime() && observed <= cutoff;
          })
          .sort((a, b) => a.date.localeCompare(b.date));
        if (usableBenchmark.length < 2) {
          item.status = 'expired';
          item.evidenceStatus = 'insufficient_evidence';
          item.reason = 'insufficient_evidence';
          item.evaluatedAt = now.toISOString();
          writeStore(store);
          return item;
        }
        const first = usableBenchmark[0];
        const last = usableBenchmark[usableBenchmark.length - 1];
        excessPct = round2(returnPct - pctChange(first.close, last.close));
        observedValue = excessPct;
      }
    }

    item.status = compare(observedValue, item.comparator, item.threshold)
      ? 'invalidated'
      : 'expired';
    item.evidenceStatus = evidenceStatus;
    item.reason = item.status === 'invalidated' ? 'threshold_met' : 'threshold_not_met';
    item.evaluatedAt = now.toISOString();
    item.observedAt = latest.date;
    item.observedValue = observedValue;
    if (returnPct !== undefined) item.returnPct = returnPct;
    if (excessPct !== undefined) item.excessPct = excessPct;
    writeStore(store);
    return item;
  });
}
