/**
 * 多模型集成投票与置信度校准（Ensemble + Calibration）
 * ------------------------------------------------------------------
 * 借鉴 QuantDinger：同一问题并行问多个模型，按「历史表现权重」加权投票，并把
 * 一致度（agreement）作为置信度一并回传——而不是无条件相信单模型的自述置信度。
 *
 * 投票语义：把「说的是同一件事」的答案聚成一组再比权重，而不是按文本精确
 * 相同分组——自由文本下两个模型几乎不可能逐字一致，精确分组会让一致度退化为
 * 「权重占比」而失去语义。相似度用**字符 bigram 重叠系数**（确定性、零依赖、
 * 中英文通用）：对长度差稳健（Jaccard 会被长文本稀释），同义改写聚得拢、
 * 观点相左分得开。结构化输出（逐字相同的 JSON/枚举）是相似度 = 1 的特例，
 * 语义不变。
 *
 * 设计约束（刻意保守）：
 * - **默认不启用**：`candidateModels` 默认只取 1 个模型，行为与单模型完全一致；
 *   显式传 models 或设 LLM_ENSEMBLE_SIZE>1 才走投票。既有链路零变更。
 * - 单模型失败不影响整体：失败项权重记 0，其余照常投票。
 * - 校准数据是「事后打分」（谁的判断被验证正确），无标签时不更新权重——
 *   不编造准确率。
 */
import * as fs from 'fs';
import * as path from 'path';
import { chat, type ChatMessage } from './client.js';
import { getModelRegistry, selectModel, type LLMTask } from './config.js';

interface ModelStat {
  correct: number;
  total: number;
}

interface CalibrationStore {
  models: Record<string, ModelStat>;
}

const DEFAULT_CALIBRATION_FILE = path.join(
  import.meta.dirname,
  '..',
  'data',
  'modelCalibration.json',
);

function getCalibrationFile(): string {
  return process.env.MODEL_CALIBRATION_FILE && process.env.MODEL_CALIBRATION_FILE.length > 0
    ? process.env.MODEL_CALIBRATION_FILE
    : DEFAULT_CALIBRATION_FILE;
}

function readCalibration(): CalibrationStore {
  try {
    const file = getCalibrationFile();
    if (!fs.existsSync(file)) return { models: {} };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CalibrationStore;
    return parsed && typeof parsed.models === 'object' ? parsed : { models: {} };
  } catch {
    return { models: {} };
  }
}

function writeCalibration(store: CalibrationStore): void {
  try {
    const file = getCalibrationFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // 校准数据不是数据源：写失败静默
  }
}

/**
 * 模型权重：Laplace 平滑的命中率，下限 1/3（避免新模型被一两次失误打死、
 * 也避免零样本模型权重为 0 直接出局）。
 */
export function modelWeight(model: string): number {
  const stat = readCalibration().models[model];
  if (!stat || stat.total <= 0) return 0.5;
  return Math.max(1 / 3, (stat.correct + 1) / (stat.total + 2));
}

/** 全部模型权重（供运维查看） */
export function getModelWeights(): Record<string, number> {
  const models = readCalibration().models;
  const out: Record<string, number> = {};
  for (const id of Object.keys(models)) out[id] = modelWeight(id);
  return out;
}

/** 记录一次模型判断的验证结果（correct = 该判断事后被验证正确） */
export function recordModelOutcome(model: string, correct: boolean): void {
  if (!model) return;
  const store = readCalibration();
  const prev = store.models[model] ?? { correct: 0, total: 0 };
  store.models[model] = {
    correct: prev.correct + (correct ? 1 : 0),
    total: prev.total + 1,
  };
  writeCalibration(store);
}

/** 清空校准数据（供测试隔离） */
export function resetCalibration(): void {
  writeCalibration({ models: {} });
}

/** 参与投票的候选模型：按成本升序取前 max 个；不足则返回单模型（等价关闭集成） */
export function candidateModels(task: LLMTask = 'chat', max?: number): string[] {
  const sizeRaw = max ?? Number(process.env.LLM_ENSEMBLE_SIZE);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 1 ? Math.floor(sizeRaw) : 1;
  const registry = getModelRegistry();
  const supported = registry.filter((m) => m.tasks.includes(task));
  if (supported.length <= 1) return [selectModel(task)];
  const sorted = [...supported].sort(
    (a, b) => a.costPer1kInput + a.costPer1kOutput - (b.costPer1kInput + b.costPer1kOutput),
  );
  return sorted.slice(0, Math.min(size, sorted.length)).map((m) => m.id);
}

export interface EnsembleAnswer {
  model: string;
  ok: boolean;
  text: string;
  error?: string;
  weight: number;
}

export interface EnsembleResult {
  answers: EnsembleAnswer[];
  /** 加权胜出的答案 */
  consensus: string;
  /** 一致度 0-1：胜出组权重 / 全部权重；单模型时为 1 */
  agreement: number;
  /** 参与且成功的模型数 */
  effectiveModels: number;
}

/** 相似度阈值：≥ 视为「同一结论的不同表述」。调成 >1 即退化为只认逐字相同 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.62;

/** 字符 bigram 集合（中英文通用；标点/空白不影响判定） */
function bigramSet(text: string): Set<string> {
  const t = text.replace(/\s+/g, '').toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 两个答案的相似度 ∈ [0,1]：字符 bigram 的**重叠系数** |A∩B| / min(|A|,|B|)。
 * 重叠系数只问「短的那段有多少被长的那段覆盖」，比 Jaccard 对长度差稳健——
 * 两段同义长文的 Jaccard 会被并集稀释到 0.3 以下，重叠系数仍能保持 0.7+。
 */
export function answerSimilarity(a: string, b: string): number {
  const A = bigramSet(a);
  const B = bigramSet(b);
  if (A.size === 0 || B.size === 0) return a.trim() === b.trim() ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

/**
 * 并行问多个模型并加权投票。
 * 全部失败时抛出最后一次错误（与单模型失败语义一致，不静默返回空结论）。
 *
 * 投票 = 贪心加权聚类：答案按权重降序入场，与既有簇代表相似（≥阈值）则并入
 * 该簇，否则自立新簇；胜出簇 = 累计权重最高，consensus 取簇内权重最高成员的
 * 原文（聚类按权重降序遍历，先入簇者即簇内最高权重）。逐字相同的答案相似度
 * = 1，结构化输出场景与旧的精确分组完全等价。
 */
export async function runEnsemble(
  messages: ChatMessage[],
  options: {
    models?: string[];
    task?: LLMTask;
    temperature?: number;
    maxTokens?: number;
    /** 相似度阈值覆盖；传 >1 退化为只认逐字相同 */
    similarityThreshold?: number;
  } = {},
): Promise<EnsembleResult> {
  const task = options.task ?? 'chat';
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const models = options.models?.length ? options.models : candidateModels(task);
  const weights = new Map(models.map((m) => [m, modelWeight(m)]));

  const settled = await Promise.all(
    models.map(async (model) => {
      try {
        const text = await chat(messages, {
          model,
          task,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        });
        return { model, ok: true, text, weight: weights.get(model) ?? 0.5 } as EnsembleAnswer;
      } catch (error) {
        return {
          model,
          ok: false,
          text: '',
          error: error instanceof Error ? error.message : String(error),
          weight: 0,
        } as EnsembleAnswer;
      }
    }),
  );

  const answers = settled.filter((a) => a.ok);
  if (answers.length === 0) {
    throw new Error(settled[0]?.error ?? '集成调用失败');
  }

  // 贪心聚类：权重降序入场，相似则并入既有簇（簇代表 = 簇内最高权重成员原文）
  const ordered = [...answers].sort((a, b) => b.weight - a.weight);
  const clusters: { rep: string; weight: number }[] = [];
  for (const a of ordered) {
    const hit = clusters.find((c) => answerSimilarity(c.rep, a.text) >= threshold);
    if (hit) hit.weight += a.weight;
    else clusters.push({ rep: a.text, weight: a.weight });
  }
  let best = { rep: '', weight: -1 };
  let total = 0;
  for (const c of clusters) {
    total += c.weight;
    if (c.weight > best.weight) best = c;
  }

  return {
    answers: settled,
    consensus: best.rep,
    agreement: total > 0 ? best.weight / total : 0,
    effectiveModels: answers.length,
  };
}
