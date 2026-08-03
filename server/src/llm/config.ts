/**
 * LLM 配置与多模型路由
 * ----------------------------------------------------------------------------
 * 通过环境变量配置，兼容 DeepSeek 与任意 OpenAI 兼容接口。
 * 未配置 API key 时 isLLMAvailable() 返回 false，专家自动降级到规则引擎。
 *
 * 多模型路由：按任务类型(task)选择最便宜且支持该任务的模型；成本单价来自环境变量，
 * 未知模型按 0 成本记账（见 cost.ts）。无路由配置时回退到主模型。
 */
export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function getLLMConfig(): LLMConfig {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat',
  };
}

/** LLM 是否可用（已配置 API key） */
export function isLLMAvailable(): boolean {
  return getLLMConfig().apiKey.length > 0;
}

/** 任务标签：决定路由到哪类模型 */
export type LLMTask = 'chat' | 'analysis' | 'debate' | 'extract' | 'reasoning' | 'embedding';

export interface ModelSpec {
  id: string;
  label: string;
  /** 输入单价：每 1k token 成本（USD，仅用于估算/护栏） */
  costPer1kInput: number;
  /** 输出单价：每 1k token 成本 */
  costPer1kOutput: number;
  /** 该模型擅长的任务标签 */
  tasks: LLMTask[];
}

/**
 * 构建模型注册表。主模型来自 getLLMConfig().model；若设置了
 * LLM_MODEL_CHEAP / LLM_MODEL_REASONING 则加入廉价/推理模型（用于路由与成本治理）。
 * 单价可通过 LLM_COST_IN_<MODEL> / LLM_COST_OUT_<MODEL> 覆盖（若未设则用 0 估算）。
 */
export function getModelRegistry(): ModelSpec[] {
  const primary = getLLMConfig().model;
  const cheap = process.env.LLM_MODEL_CHEAP;
  const reasoning = process.env.LLM_MODEL_REASONING;

  const spec = (id: string, label: string, tasks: LLMTask[]): ModelSpec => ({
    id,
    label,
    costPer1kInput: numEnv(`LLM_COST_IN_${id.toUpperCase()}`),
    costPer1kOutput: numEnv(`LLM_COST_OUT_${id.toUpperCase()}`),
    tasks,
  });

  const registry: ModelSpec[] = [
    spec(primary, 'primary', ['chat', 'analysis', 'extract', 'debate']),
  ];
  if (cheap && cheap !== primary) {
    registry.push(spec(cheap, 'cheap', ['chat', 'extract', 'embedding']));
  }
  if (reasoning && reasoning !== primary && reasoning !== cheap) {
    registry.push(spec(reasoning, 'reasoning', ['reasoning', 'analysis', 'debate']));
  }
  return registry;
}

function numEnv(name: string): number {
  const v = process.env[name];
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 按任务选择模型：优先选支持该任务且输入+输出单价之和最低的模型；兜底主模型 */
export function selectModel(task: LLMTask, preferred?: string): string {
  const registry = getModelRegistry();
  if (preferred) {
    const hit = registry.find((m) => m.id === preferred);
    if (hit) return hit.id;
  }
  const candidates = registry.filter((m) => m.tasks.includes(task));
  if (candidates.length === 0) return registry[0]?.id ?? getLLMConfig().model;
  candidates.sort(
    (a, b) => a.costPer1kInput + a.costPer1kOutput - (b.costPer1kInput + b.costPer1kOutput),
  );
  return candidates[0].id;
}

/** 取模型单价规格；未知模型返回 0 成本规格 */
export function modelSpec(id: string): ModelSpec {
  const hit = getModelRegistry().find((m) => m.id === id);
  if (hit) return hit;
  return { id, label: 'unknown', costPer1kInput: 0, costPer1kOutput: 0, tasks: [] };
}

/** 嵌入模型：默认与主模型相同（多数 OpenAI 兼容服务用独立 embedding 模型），可用 LLM_EMBED_MODEL 覆盖 */
export function getEmbedModel(): string {
  return process.env.LLM_EMBED_MODEL || process.env.OPENAI_EMBED_MODEL || getLLMConfig().model;
}

/** 嵌入端点 base URL：默认复用主模型 baseUrl；若有独立嵌入端点（LLM_EMBED_BASE_URL / OPENAI_EMBED_BASE_URL）则优先 */
export function getEmbedBaseUrl(): string {
  return (
    process.env.LLM_EMBED_BASE_URL ||
    process.env.OPENAI_EMBED_BASE_URL ||
    getLLMConfig().baseUrl
  ).replace(/\/+$/, '');
}

/**
 * 是否配置了嵌入能力。仅当显式设置嵌入模型或独立嵌入端点时才视为可用；
 * 否则（如仅配了 DeepSeek 文本模型）embed() 直接返回空，retrieveEvidence 干净回退 BM25，
 * 避免对无 /embeddings 端点的服务发起注定失败的请求、污染日志。
 */
export function isEmbeddingConfigured(): boolean {
  return Boolean(
    process.env.LLM_EMBED_MODEL ||
      process.env.OPENAI_EMBED_MODEL ||
      process.env.LLM_EMBED_BASE_URL ||
      process.env.OPENAI_EMBED_BASE_URL,
  );
}
