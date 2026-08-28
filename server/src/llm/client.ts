/**
 * LLM 客户端
 * 支持 DeepSeek / OpenAI 兼容接口，提供非流式、流式、JSON 结构化输出三种调用方式。
 */
import {
  getLLMConfig,
  isLLMAvailable,
  selectModel,
  modelSpec,
  getEmbedModel,
  getEmbedBaseUrl,
  isEmbeddingConfigured,
  type LLMTask,
} from './config.js';
import { recordUsage } from './cost.js';
import { getTracer, withSpan, type TelemetrySpan } from '../services/telemetry.js';
import { withTimeout } from '../utils/timeout.js';
import logger from '../utils/logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 助手消息携带的工具调用（function-calling 回灌时必须保留） */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** 工具结果消息必须回指对应的 tool_call_id */
  tool_call_id?: string;
  /** 工具结果消息对应的函数名 */
  name?: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** 单次请求超时（毫秒），默认 60s */
  timeout?: number;
  /** 显式指定模型（覆盖按任务路由的选择） */
  model?: string;
  /** 任务标签，用于多模型路由（chat/analysis/debate/extract/reasoning/embedding） */
  task?: LLMTask;
}

// ============================================================================
// 请求层：统一超时 + 限流重试
// ============================================================================

/** 可重试的 HTTP 状态：限流与上游瞬时故障 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** 默认重试次数（不含首次）：一次分析会扇出多个 LLM 调用，429 不重试会被静默降级掩盖 */
const LLM_MAX_RETRIES = 2;

class RetryableStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 10_000);
  return null;
}

/** 指数退避 + 抖动：1s → 2s → 4s（封顶 8s） */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

/**
 * 带超时与重试的 fetch：
 * - 每次尝试独立超时（AbortController），linkSignal（外部取消）联动生效；
 * - 429/5xx/网络错误按指数退避重试，尊重 Retry-After（上限 10s）；
 * - 超时 abort 与外部取消不重试（保持原有立即抛错语义）。
 * 适用于 LLM 这类请求体固定、重发安全的幂等调用。
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; linkSignal?: AbortSignal; maxRetries?: number } = {
    timeoutMs: 60_000,
  },
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? LLM_MAX_RETRIES;
  let lastError: unknown = new Error('fetch failed');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptController = new AbortController();
    const timer = setTimeout(() => attemptController.abort(), opts.timeoutMs);
    try {
      const signal = opts.linkSignal
        ? AbortSignal.any([opts.linkSignal, attemptController.signal])
        : attemptController.signal;
      const response = await fetch(url, { ...init, signal });
      if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        await response.text().catch(() => ''); // 释放连接后再退避
        throw new RetryableStatusError(response.status, retryAfterMs);
      }
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      // 仅瞬时故障重试：超时 abort / 外部取消 / 4xx 语义错误不重试
      const retryable =
        err instanceof RetryableStatusError ||
        (err instanceof TypeError && !opts.linkSignal?.aborted);
      if (!retryable || attempt >= maxRetries) break;
      const delayMs =
        err instanceof RetryableStatusError && err.retryAfterMs !== null
          ? err.retryAfterMs
          : backoffDelay(attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/**
 * 非流式对话，返回完整文本
 */
export async function chat(messages: ChatMessage[], options: LLMOptions = {}): Promise<string> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，请设置 DEEPSEEK_API_KEY');
  return withSpan('llm.chat', async (_ctx, span) => {
    const config = getLLMConfig();
    const model = options.model ?? selectModel(options.task ?? 'chat');
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
      stream: false,
    };
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetchWithRetry(
      `${config.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: options.timeout ?? 60000, linkSignal: options.signal },
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM 请求失败 (${response.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    recordLLMUsage(model, data.usage, options.task, span);
    const content = data.choices?.[0]?.message?.content || '';
    if (!data.choices) {
      // 结构异常与"模型返回空回答"不可混淆，至少留痕便于排查
      logger.warn('LLM 响应缺少 choices 字段', { model, task: options.task });
    }
    return content;
  });
}

/**
 * 流式对话，逐 token 通过 onToken 回调推送，同时返回完整文本
 */
export async function chatStream(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  options: LLMOptions = {},
): Promise<string> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，请设置 DEEPSEEK_API_KEY');
  return withSpan('llm.chat', async (_ctx, span) => {
    const config = getLLMConfig();
    const model = options.model ?? selectModel(options.task ?? 'chat');
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
      // 请求在末尾 chunk 携带 usage，用于成本治理（OpenAI/DeepSeek 兼容）。
      // 不带此项时流式响应无 usage，调用将完全游离于成本记账之外。
      stream_options: { include_usage: true },
    };
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    // 空闲超时（而非总时长）：每收到一个 chunk 就重置定时器，
    // 活跃生成的长流不会被误杀，而连接 stall 仍会及时 abort。
    // abort 携带 reason，调用方可区分"超时"与"外部取消"。
    const idleMs = options.timeout ?? 60000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('LLM 流式空闲超时')), idleMs);
    };
    armIdleTimer();

    try {
      const linkSignal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      const response = await fetchWithRetry(
        `${config.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        // fetch（响应头）阶段仍用超时兜底；读取阶段的空闲超时由上面的 controller 负责
        { timeoutMs: idleMs, linkSignal },
      );
      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        throw new Error(`LLM 流式请求失败 (${response.status}): ${errText.slice(0, 300)}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      let buffer = '';
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      while (true) {
        armIdleTimer(); // 每个 chunk 前重置：总时长语义 → 空闲语义
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            // 末尾 chunk（include_usage:true 时）携带 usage，捕获后用于成本记账
            if (json.usage) usage = json.usage;
            const token = json.choices?.[0]?.delta?.content || '';
            if (token) {
              full += token;
              onToken(token);
            }
          } catch {
            // 忽略心跳/不完整行
          }
        }
      }
      if (usage) recordLLMUsage(model, usage, options.task, span);
      return full;
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * 调用 LLM 获取 JSON 对象。
 * 自动剥离 ```json``` 代码块包裹，解析失败时抛出带原文的错误。
 */
export async function chatJSON<T>(messages: ChatMessage[], options: LLMOptions = {}): Promise<T> {
  const content = await chat(messages, { ...options, jsonMode: true });
  const jsonStr = extractJSON(content);
  try {
    return JSON.parse(jsonStr) as T;
  } catch (err) {
    throw new Error(`LLM JSON 解析失败: ${(err as Error).message}\n原文: ${content.slice(0, 500)}`);
  }
}

/**
 * 函数调用（function-calling）对话。
 * 传入工具定义与一个执行回调；模型若返回 tool_calls，则执行并把结果回灌，循环最多 5 轮，
 * 直到模型给出最终文本。返回最终回答与本次用到的工具调用。
 * 注意：带 tools 时不允许同时设置 response_format=json_object（OpenAI 限制），故此处不启用 jsonMode。
 */
export interface ToolCallResult {
  name: string;
  args: Record<string, unknown>;
}
export async function chatWithTools(
  messages: ChatMessage[],
  tools: unknown[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  options: LLMOptions = {},
): Promise<{ content: string; toolCalls: ToolCallResult[] }> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，请设置 DEEPSEEK_API_KEY');
  const config = getLLMConfig();
  const model = options.model ?? selectModel(options.task ?? 'analysis');
  const conv: ChatMessage[] = messages.map((m) => ({ ...m }));
  const used: ToolCallResult[] = [];

  for (let iter = 0; iter < 5; iter++) {
    const body: Record<string, unknown> = {
      model,
      messages: conv,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 1500,
      stream: false,
      tools,
      tool_choice: 'auto',
    };

    // 每轮请求独立超时控制（与 chat 一致）：单轮挂死会让整个工具调用回路卡满 5 轮。
    // 429/5xx 由 fetchWithRetry 退避重试；响应体读取用 withTimeout 兜底
    // （fetch 返回仅代表收到响应头，body stall 仍会挂起）。
    const response = await fetchWithRetry(
      `${config.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: options.timeout ?? 60000, linkSignal: options.signal },
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM 工具调用失败 (${response.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await withTimeout(response.json(), 15000)) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    recordUsageFromResponse(model, data, options.task);
    const msg = data.choices?.[0]?.message;
    if (!msg) return { content: '', toolCalls: used };

    // 把助手消息（含 tool_calls）原样回灌，保持对话结构
    // 注意：带 tool_calls 的助手消息必须保留 tool_calls 字段（含 type:'function'），
    // 否则下一轮请求里工具结果消息无法与助手调用对应，API 会报 missing field `tool_call_id`。
    const assistantToolCalls = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    conv.push({ role: 'assistant', content: msg.content || '', tool_calls: assistantToolCalls });

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(tc.function.arguments || '{}');
        } catch {
          parsed = {};
        }
        used.push({ name: tc.function.name, args: parsed });
        let result: string;
        try {
          result = await executeTool(tc.function.name, parsed);
        } catch (err) {
          result = `工具执行出错: ${(err as Error).message}`;
        }
        // 工具结果消息必须回指 tool_call_id 并带上函数名
        conv.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }
      continue; // 让模型基于工具结果继续
    }
    return { content: msg.content || '', toolCalls: used };
  }
  // 5 轮耗尽：最后一条是 tool 消息（被截断的原始 JSON），不能当回答返回。
  // 取最后一条 assistant 消息，为空时返回明确的降级文案。
  const lastAssistantContent = [...conv]
    .reverse()
    .find((m) => m.role === 'assistant')
    ?.content?.trim();
  return {
    content:
      lastAssistantContent || '（工具调用轮次已达上限，未能生成最终回答，请重试或缩小问题范围）',
    toolCalls: used,
  };
}

/**
 * 生成文本嵌入向量（OpenAI 兼容 /embeddings）。
 * 用于轻量向量检索；嵌入端点不可用时抛出错误，调用方应回退 BM25。
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!isLLMAvailable()) throw new Error('LLM 未配置 API key，无法生成嵌入');
  // 未显式配置嵌入能力（如仅配了 DeepSeek 文本模型）→ 直接返回空，由检索层回退 BM25
  if (!isEmbeddingConfigured()) return [];
  if (texts.length === 0) return [];
  const config = getLLMConfig();
  const body = { model: getEmbedModel(), input: texts };
  // 与其他 API 调用一致的超时与重试：此前完全无超时，端点 stall 会永久挂起
  const response = await fetchWithRetry(
    `${getEmbedBaseUrl()}/embeddings`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: 30000 },
  );
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM 嵌入失败 (${response.status}): ${errText.slice(0, 300)}`);
  }
  const data = (await withTimeout(response.json(), 15000)) as {
    data?: { embedding: number[] }[];
  };
  if (!data.data || data.data.length !== texts.length) {
    throw new Error('LLM 嵌入返回数量与输入不一致');
  }
  // 估算嵌入 token 成本（约 4 字符/token），仅作成本治理参考
  const approxTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  recordUsage(getEmbedModel(), approxTokens, 0, { task: 'embedding' });
  return data.data.map((d) => d.embedding);
}

/** 从响应 usage 记录成本（无 usage 或未知模型时安全跳过） */
function recordUsageFromResponse(
  model: string,
  data: { usage?: { prompt_tokens?: number; completion_tokens?: number } },
  task?: LLMTask,
): void {
  const usage = data.usage;
  if (!usage) return;
  const spec = modelSpec(model);
  const cost =
    ((usage.prompt_tokens ?? 0) / 1000) * spec.costPer1kInput +
    ((usage.completion_tokens ?? 0) / 1000) * spec.costPer1kOutput;
  recordUsage(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, { cost, task });
}

/**
 * 通过 telemetry 记录 LLM 调用成本与 token：
 * 内部复用 recordUsage 落账 cost.ts（单条账目），同时把用量作为事件与累计属性挂到 span。
 * 无 usage 时安全跳过（与 recordUsageFromResponse 一致，避免 0-token 假账）。
 */
function recordLLMUsage(
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  task?: LLMTask,
  span?: TelemetrySpan,
): void {
  if (!usage || (!usage.prompt_tokens && !usage.completion_tokens)) return;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const spec = modelSpec(model);
  const cost =
    (promptTokens / 1000) * spec.costPer1kInput + (completionTokens / 1000) * spec.costPer1kOutput;
  getTracer().recordLLMCall(model, promptTokens, completionTokens, cost, span);
}

/** 从可能被 markdown 包裹的文本中提取 JSON */
function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return text.trim();
  return text.slice(start).trim();
}
