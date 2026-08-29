import type { ExpertOpinion } from '../types.js';
import logger from '../utils/logger.js';

/**
 * 多专家并行运行器：单专家失败不再拖垮整次分析。
 *
 * 背景（借鉴 TradingAgents 的节点级 crash-safety）：原先 8 位专家用 Promise.all 并发，
 * 且多数专家函数自身无 try/catch，任一专家抛错（LLM 超时、返回结构不合法）都会让
 * Promise.all 直接 reject，导致整次分析失败、其余已成功的专家结论全部作废。
 *
 * 本模块改为 Promise.allSettled + 单专家有限重试：
 *   - 成功的专家结论照常进入仲裁；
 *   - 失败的专家从仲裁输入中剔除，其名称记入 degradedExperts 由报告如实披露；
 *   - 全部失败才向上抛错（此时确实无法形成有效研判）。
 */

/** 单专家最大尝试次数（含首次调用） */
const MAX_ATTEMPTS = 2;
/** 重试前的线性退避基数（毫秒） */
const RETRY_DELAY_MS = 400;

export interface ExpertTask {
  /** 稳定键：供下游按名取用，不随展示文案变化 */
  key: string;
  /** 展示名：失败时用于报告披露 */
  name: string;
  run: () => Promise<ExpertOpinion>;
}

export interface ExpertRunOutcome {
  /** 成功的专家结论（按任务声明顺序；失败者已剔除） */
  opinions: ExpertOpinion[];
  /** 失败的专家展示名 */
  degradedExperts: string[];
  /** 按 key 取用的成功结论；该专家失败时为 undefined */
  byKey: Record<string, ExpertOpinion | undefined>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 专家结论的最小结构校验：缺关键字段视为失败，避免脏数据流入仲裁 */
function isValidOpinion(o: ExpertOpinion | null | undefined): o is ExpertOpinion {
  return (
    !!o &&
    typeof o.expert === 'string' &&
    Array.isArray(o.arguments) &&
    Array.isArray(o.keyPoints) &&
    ['bullish', 'neutral', 'bearish'].includes(o.overallSentiment)
  );
}

/** 单专家执行：失败后有限重试，仍失败则抛出 */
async function runWithRetry(task: ExpertTask): Promise<ExpertOpinion> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const opinion = await task.run();
      if (!isValidOpinion(opinion)) {
        throw new Error('专家返回结构不合法');
      }
      return opinion;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 并行运行全部专家并做单专家降级。
 *
 * @param tasks 专家任务列表
 * @returns 成功结论 / 降级名单 / 按 key 的结论映射
 */
export async function runExpertsWithDegradation(tasks: ExpertTask[]): Promise<ExpertRunOutcome> {
  const settled = await Promise.allSettled(tasks.map((task) => runWithRetry(task)));

  const opinions: ExpertOpinion[] = [];
  const degradedExperts: string[] = [];
  const byKey: Record<string, ExpertOpinion | undefined> = {};

  settled.forEach((result, idx) => {
    const task = tasks[idx];
    if (result.status === 'fulfilled') {
      opinions.push(result.value);
      byKey[task.key] = result.value;
      return;
    }
    degradedExperts.push(task.name);
    byKey[task.key] = undefined;
    logger.warn('专家研判失败，本次分析降级剔除该专家', {
      expert: task.name,
      err: result.reason as Error,
    });
  });

  return { opinions, degradedExperts, byKey };
}
