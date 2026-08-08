import axios from 'axios';
import type { AnalysisResult } from '../types';

const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
});

/**
 * 把 axios 的原始错误翻译成用户能理解、能行动的中文提示。
 * 后端未启动时 axios 只会抛 "Network Error"，对用户毫无意义。
 */
export function normalizeApiError(error: unknown, fallback = '请求失败'): Error {
  const e = error as {
    code?: string;
    message?: string;
    response?: { status?: number; data?: { error?: string; message?: string } };
  };

  if (e?.code === 'ERR_CANCELED') return new Error('请求已取消');
  if (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '')) {
    return new Error('请求超时：分析耗时超过预期，请稍后重试或换一只标的');
  }
  if (e?.code === 'ERR_NETWORK' || !e?.response) {
    return new Error('无法连接后端服务（localhost:3001）。请确认服务已启动，或运行「启动系统.bat」后重试');
  }

  const status = e.response.status;
  const serverMsg = e.response.data?.error || e.response.data?.message;
  if (serverMsg) return new Error(serverMsg);
  if (status === 404) return new Error('接口不存在（404），请确认前后端版本一致');
  if (status === 429) return new Error('请求过于频繁，请稍后再试');
  if (status && status >= 500) return new Error(`后端服务异常（${status}），请查看服务端日志`);
  return new Error(fallback);
}

let currentController: AbortController | null = null;

export async function analyzeStock(stockCode: string) {
  // Cancel previous request if any
  if (currentController) currentController.abort();
  currentController = new AbortController();

  try {
    const response = await api.post('/analyze', { stockCode }, {
      signal: currentController.signal,
      timeout: 60000,
    });
    return response.data;
  } catch (error: unknown) {
    if (axios.isCancel(error)) throw new Error('请求已取消');
    throw normalizeApiError(error, '分析请求失败');
  } finally {
    currentController = null;
  }
}

export async function getStockList() {
  try {
    const response = await api.get('/stocks', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取股票列表失败');
  }
}

export async function searchStocks(keyword: string, signal?: AbortSignal) {
  try {
    const response = await api.get('/stocks/search', {
      params: { keyword },
      timeout: 15000,
      signal,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '搜索失败');
  }
}

export async function runQuantAnalysis(payload: {
  strategy: unknown;
  useNews?: boolean;
  newsItems?: { id: string; title: string; summary?: string; publishedAt: string; polarity?: number }[];
}) {
  try {
    const response = await api.post('/quant/analyze', payload);
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '量化分析失败');
  }
}

export async function compareStocks(codes: string[]) {
  try {
    const response = await api.post('/compare', { stockCodes: codes }, {
      timeout: 180000, // 3 min timeout for multi-stock analysis
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '对比分析失败');
  }
}

// === 自选股 / 持仓监控 ===
export async function getWatchlist(): Promise<{ codes: string[] }> {
  try {
    const response = await api.get('/watchlist', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取自选股失败');
  }
}

export async function addToWatchlist(code: string): Promise<{ codes: string[] }> {
  try {
    const response = await api.post('/watchlist', { code }, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '添加自选股失败');
  }
}

export async function removeFromWatchlist(code: string): Promise<{ codes: string[] }> {
  try {
    const response = await api.delete(`/watchlist/${code}`, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '移除自选股失败');
  }
}

/** 对自选股（或指定 codes）批量运行"含最新消息回测" */
export async function runWatchlistNewsBacktest(
  codes?: string[],
): Promise<import('../types').WatchlistNewsBacktestReport> {
  try {
    const response = await api.post(
      '/watchlist/news-backtest',
      { codes: codes ?? [] },
      { timeout: 180000 },
    );
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '自选股批量回测失败');
  }
}

// === 对话式智能体 ===
export interface ChatEvidence {
  id: string;
  source: string;
  text: string;
  stockCode?: string;
}

export interface ChatDebate {
  bull: string;
  bear: string;
  synthesis: string;
}

export interface RiskDebateResult {
  aggressive: string;
  neutral: string;
  conservative: string;
  synthesis: string;
}

export interface AgentPlan {
  action: 'direct' | 'tools' | 'debate';
  reason: string;
}

export interface CalculationError {
  claim: string;
  reconstructedFormula: string;
  recomputedValue: string;
  claimedValue: string;
  discrepancy: string;
}

export interface AnswerVerification {
  verified: boolean;
  unverified: string[];
  calculationErrors: CalculationError[];
  warning: string;
}

export interface ChatAgentResponse {
  answer: string;
  toolsUsed: string[];
  evidence: ChatEvidence[];
  debate?: ChatDebate;
  riskDebate?: RiskDebateResult;
  /** 路由规划结果（LLM 可用时返回） */
  plan?: AgentPlan;
  /** 幻觉防护校验结果 */
  verification?: AnswerVerification;
  /** true = LLM 未配置，规则降级 */
  degraded: boolean;
  model?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export async function chatWithAgent(payload: {
  message: string;
  history?: ChatTurn[];
  stockCode?: string;
  sessionId?: string;
}): Promise<ChatAgentResponse> {
  try {
    const response = await api.post('/chat', payload, { timeout: 120000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '对话请求失败');
  }
}

// === 研究增强接口（文档库 / 模型路由 / 成本 / 记忆 / 自治监控） ===
export interface IngestInsight {
  summary: string;
  positives: string[];
  risks: string[];
  catalysts: string[];
  confidence: number;
  source: string;
}
export interface IngestResult {
  id: string;
  title: string;
  ingested: boolean;
  insight: IngestInsight;
}
export async function ingestDocument(payload: {
  title: string;
  text?: string;
  pdfBase64?: string;
  stockCode?: string;
}): Promise<IngestResult> {
  try {
    const response = await api.post('/ingest', payload, { timeout: 120000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '文档入库失败');
  }
}
export async function listDocuments(): Promise<{ count: number; docs: { id: string; source: string; preview: string }[] }> {
  try {
    const response = await api.get('/documents', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '读取资料库失败');
  }
}

export interface ModelRoutingInfo {
  available: boolean;
  embeddingEnabled: boolean;
  registry: { id: string; label: string; costPer1kInput: number; costPer1kOutput: number; tasks: string[] }[];
  routing: Record<string, string>;
}
export async function getModels(): Promise<ModelRoutingInfo> {
  try {
    const response = await api.get('/models', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取模型信息失败');
  }
}

export interface CostReport {
  totalCost: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  callCount: number;
  byModel: Record<string, { promptTokens: number; completionTokens: number; cost: number; calls: number }>;
}
export async function getCostReport(): Promise<CostReport> {
  try {
    const response = await api.get('/cost', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取成本报告失败');
  }
}
export async function resetCostReport(): Promise<{ ok: boolean }> {
  try {
    const response = await api.post('/cost/reset', {}, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '重置成本失败');
  }
}

export async function clearChatHistory(sessionId: string): Promise<{ ok: boolean }> {
  try {
    const response = await api.post('/chat/history/clear', { sessionId }, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '清空对话记忆失败');
  }
}

export interface AutonomousState {
  running: boolean;
  intervalMs?: number;
  lastRunAt?: string;
  lastAlertCount?: number;
  runCount?: number;
  errorCount?: number;
  lastError?: string;
}
export async function startAutonomous(intervalMs?: number): Promise<AutonomousState & { started: boolean }> {
  try {
    const response = await api.post('/autonomous/start', { intervalMs }, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '启动自动监控失败');
  }
}
export async function stopAutonomous(): Promise<{ stopped: boolean; lastAlerts: unknown[] }> {
  try {
    const response = await api.post('/autonomous/stop', {}, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '停止自动监控失败');
  }
}
export async function getAutonomousStatus(): Promise<AutonomousState> {
  try {
    const response = await api.get('/autonomous/status', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '获取监控状态失败');
  }
}

/**
 * 流式对话（SSE，事件式：最终以 {phase:'done', ...response} 推回）。
 * onEvent 在每次事件回调；返回的 cancel 可中断。
 */
export type ChatStreamEvent =
  | { phase: 'planning'; message: string }
  | { phase: 'retrieving'; message: string }
  | { phase: 'tool_calling'; message: string; tools?: string[] }
  | { phase: 'debating'; message: string }
  | { phase: 'verifying'; message: string }
  | { phase: 'done'; message: string; response: ChatAgentResponse }
  | { phase: 'error'; message: string };

export function chatWithAgentStream(
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
): { cancel: () => void } {
  const es = new EventSource(`/api/chat/stream?message=${encodeURIComponent(message)}`);
  let settled = false;
  const finish = (evt: ChatStreamEvent) => {
    if (settled) return;
    settled = true;
    es.close();
    onEvent(evt);
  };
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as ChatStreamEvent;
      if (data.phase === 'done' || data.phase === 'error') finish(data);
      else onEvent(data);
    } catch { /* 忽略偶发解析错误 */ }
  };
  es.onerror = () => {
    if (!settled) finish({ phase: 'error', message: '连接中断，对话未完成，请重试' });
  };
  return { cancel: () => { settled = true; es.close(); } };
}

/** 流式分析阶段事件（与后端 AnalysisStage 对齐） */
export interface AnalysisStage {
  phase: 'data' | 'experts' | 'arbitration' | 'scoring' | 'strategy' | 'done' | 'error';
  message: string;
  totalScore?: number;
  rating?: string;
  result?: AnalysisResult;
}

/**
 * 流式股票分析（SSE）
 * onStage 在每次阶段进度更新时回调；返回的 done Promise 在分析完成时 resolve 结果。
 * 调用方可通过 cancel() 主动中断。
 */
export function analyzeStockStream(
  stockCode: string,
  onStage: (stage: AnalysisStage) => void
): { cancel: () => void; done: Promise<AnalysisResult> } {
  const es = new EventSource(`/api/analyze/stream?stockCode=${encodeURIComponent(stockCode)}`);
  let resolveDone!: (r: AnalysisResult) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<AnalysisResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  /** 是否收到过任何一条服务端事件 —— 用于区分「连不上」和「中途断开」 */
  let received = false;
  let settled = false;
  /** 首包看门狗：若 20s 内一条事件都没收到，判定为服务不可用 */
  let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (!received) finish(new Error('后端无响应：20 秒内未收到任何分析进度，请确认服务是否正常'));
  }, 20000);

  const cleanup = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    es.close();
  };

  function finish(err: Error | null, result?: AnalysisResult) {
    if (settled) return;
    settled = true;
    cleanup();
    if (err) rejectDone(err);
    else resolveDone(result as AnalysisResult);
  }

  es.onmessage = (event) => {
    received = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    try {
      const data = JSON.parse(event.data) as AnalysisStage;
      if (data.phase === 'done' && data.result) {
        finish(null, data.result);
      } else if (data.phase === 'error') {
        finish(new Error(data.message || '分析过程出错'));
      } else {
        onStage(data);
      }
    } catch {
      // 忽略偶发解析错误
    }
  };

  es.onerror = () => {
    // EventSource 在正常结束时也会触发 error，已 settle 的场景直接忽略
    if (settled) return;
    finish(
      received
        ? new Error('连接中断，分析未完成，请重试')
        : new Error('无法连接后端服务（localhost:3001）。请确认服务已启动，或运行「启动系统.bat」后重试')
    );
  };

  return {
    cancel: () => {
      settled = true;
      cleanup();
    },
    done,
  };
}
