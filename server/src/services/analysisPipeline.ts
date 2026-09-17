import type {
  AnalysisResult,
  ExpertOpinion,
  ExpertDegradeReason,
  DataSource,
  SectorRotationSignal,
  PriceHistoryPoint,
  ControversyPoint,
} from '../types.js';
import { getData } from './dataService.js';
import { fundamentalExpert } from './experts/fundamentalExpert.js';
import { valuationExpert } from './experts/valuationExpert.js';
import { industryExpert, type IndustryExpertResult } from './experts/industryExpert.js';
import { riskExpert } from './experts/riskExpert.js';
import { capitalFlowExpert } from './experts/capitalFlowExpert.js';
import { policyExpert } from './experts/policyExpert.js';
import { hotMoneyExpert } from './experts/hotMoneyExpert.js';
import { unlockExpert } from './experts/unlockExpert.js';
import { arbitrationExpert } from './experts/arbitrationExpert.js';
import { runExpertsWithDegradation } from './expertRunner.js';
import { isDegradedOpinion, getDegradeReason } from '../llm/expertRunner.js';
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  newRunId,
  stageLabel,
} from './analysisCheckpoint.js';
import { evaluateOutcomes, getRatingAccuracy, formatAccuracyHint } from './outcomeTracker.js';
import { generateScenarios } from './scenarioEngine.js';
import { generateStrategyList } from './strategyListEngine.js';
import { safeDiv } from './safeDiv.js';
import { calculateScores } from './scoreEngine.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import { extractNewsSignal, earliestNewsDate, type NewsSignal } from '../quant/newsSignal.js';
import { auditDataAccess, auditLLMCall, auditTradeSignal } from './auditLog.js';
import { buildFinancialGraph } from '../llm/knowledgeGraph.js';
import { calculateSectorRotation, type SectorData } from '../quant/sectorRotation.js';
import {
  fetchConsensusSnapshot,
  formatConsensusBrief,
  type ConsensusSnapshot,
} from '../quant/consensusProvider.js';
import { buildAnnouncementBrief } from '../quant/announcementProvider.js';
import { styleFactorExposures, decomposeRisk } from '../quant/riskAttribution.js';
import { withTimeout, withAbortableTimeout } from '../utils/timeout.js';
import logger from '../utils/logger.js';

/** 特异波动经验基准（%）：无残差收益序列时使用（A 股中位单股波动水平） */
const SPECIFIC_RISK_BASELINE = 25;

/** 参与研判的专家总数（用于覆盖度披露；与实际并发任务数保持一致） */
const EXPERT_TOTAL = 8;

/** 降级原因的中文口径（仅用于报告披露文案；机器可读原因见 ExpertDegradeReason） */
const DEGRADE_REASON_LABEL: Record<ExpertDegradeReason, string> = {
  llm_unavailable: '未配置 LLM',
  queue_timeout: '排队超时（上游繁忙，429 语义）',
  llm_error: 'LLM 调用失败',
};

interface ExpertDegradationSummary {
  /** 结论出自本地规则引擎的专家人数 */
  count: number;
  /** 参考总人数（口径与 EXPERT_TOTAL 一致，续跑复用结论时同样适用） */
  total: number;
  /** 降级专家名单（按专家结论顺序） */
  experts: string[];
  /** 命中的降级原因（去重，保持稳定顺序） */
  reasons: ExpertDegradeReason[];
  /** 仲裁层是否也降级为规则引擎（有值即为降级原因）；与专家层分开披露 */
  arbitration?: ExpertDegradeReason;
}

/**
 * 统计"用了规则引擎结论"的专家（LLM 未配置 / 闸门排队超时 / LLM 调用失败）。
 *
 * 与 `degradedExperts`（专家**完全失败**被剔除、报告里另行披露）是两件事：
 * 这里统计的是"仍然给出了结论、但结论并非 LLM 研判"的专家。若不披露，读者会把
 * 规则引擎的结论当成专家研判，无从分辨哪些结论有 LLM 参与。
 */
function summarizeExpertDegradation(opinions: ExpertOpinion[]): ExpertDegradationSummary {
  const experts: string[] = [];
  const reasons: ExpertDegradeReason[] = [];
  for (const opinion of opinions) {
    if (!isDegradedOpinion(opinion)) continue;
    if (!experts.includes(opinion.expert)) experts.push(opinion.expert);
    const reason = getDegradeReason(opinion);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }
  return { count: experts.length, total: EXPERT_TOTAL, experts, reasons };
}

/**
 * 组装报告既有字段 `limitation_explain`（局限性说明）。
 * 无降级时保持原文案；有降级时追加如实披露：人数、名单、原因，并明确说明
 * 本次结论可信度低于全 LLM 研判（不用"部分数据缺失"之类的模糊措辞掩盖结论来源）。
 */
function buildLimitationExplain(degradation: ExpertDegradationSummary): string {
  const base =
    '本分析基于公开财务数据和行业信息，未包含非公开信息、实地调研、管理层访谈等。数据截止至最近年报，可能存在滞后性。分析模型为定性+定量结合，不构成投资建议。';
  const parts = [base];
  if (degradation.count > 0) {
    const reasons =
      degradation.reasons.map((r) => DEGRADE_REASON_LABEL[r]).join('、') || '原因未记录';
    parts.push(
      `【专家结论来源】本次有 ${degradation.count} 位专家（共 ${degradation.total} 位：${degradation.experts.join('、')}）的结论由本地规则引擎生成、并非 LLM 研判，原因：${reasons}；本次结论可信度低于全 LLM 研判，请相应调低采信程度。`,
    );
  }
  if (degradation.arbitration) {
    parts.push(
      `【仲裁结论来源】本次多专家辩论仲裁由本地规则引擎生成、并非 LLM 仲裁（原因：${DEGRADE_REASON_LABEL[degradation.arbitration]}）；争议焦点与最终意见的综合性弱于 LLM 仲裁。`,
    );
  }
  return parts.join('');
}

/**
 * 拉取近 2 年日K线，映射为前端走势图可用的 PriceHistoryPoint。
 * fetchOHLCVData 自带 12h 磁盘缓存与"网络失败→模拟数据"降级；
 * 此处再套一层兜底，任何异常都返回空数组（前端据此隐藏走势图，而非报错）。
 * signal 用于「外层限时超时」：超时后底层 K 线请求真正断开，而不是白跑到它自己的 15s 上限。
 */
async function fetchPriceHistory(
  stockCode: string,
  signal?: AbortSignal,
): Promise<PriceHistoryPoint[]> {
  const end = new Date();
  const beg = new Date(end);
  beg.setFullYear(beg.getFullYear() - 2);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const raw = await fetchOHLCVData(stockCode, fmt(beg), fmt(end), signal);
    if (!raw || raw.length === 0) return [];
    return raw.map((d) => ({
      date: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
      isSimulated: d.isSimulated,
    }));
  } catch {
    return [];
  }
}

/** 分析阶段事件（用于 SSE 流式推送进度） */
export type AnalysisStage =
  | { phase: 'data'; message: string }
  | { phase: 'experts'; message: string }
  | { phase: 'arbitration'; message: string }
  | { phase: 'scoring'; message: string; totalScore: number; rating: string }
  | { phase: 'strategy'; message: string }
  | { phase: 'done'; message: string; result: AnalysisResult };

/** 运行选项 */
export interface RunAnalysisOptions {
  /**
   * 是否允许从上次中断处继续（断点续跑）。
   * 为 true 时读取该股票的断点，跳过已完成的高成本阶段（取数 / 专家研判 / 仲裁），
   * 中断后重入可省去已支付过的 LLM 成本；无断点或断点已过期则自动全新开始。
   */
  resume?: boolean;
}

/**
 * 在途分析登记（按股票代码 single-flight）。
 *
 * 并发语义选择：**等待并复用同一轮结果**，而不是抛「可重试错误」。
 * 理由：① 与本项目既有并发策略一致——dataService.getData / quantCache.withQuantCache
 * 都是共享同一个 producer Promise；② SSE 与 POST 双入口（双标签页）、/api/compare 并行
 * 触发同一代码时，第二个调用方拿到结果比拿到错误更有用（前端无需自行重试）；
 * ③ 真正要解决的痛点是「重复调用 LLM 重复付费」，复用结果即可彻底消除。
 *
 * **复用的前提是语义一致**：resume 与在途轮次不一致时必须显式拒绝
 * （见 InFlightAnalysis.resume 与 ANALYSIS_IN_FLIGHT），不得静默复用。
 */
interface InFlightAnalysis {
  promise: Promise<AnalysisResult>;
  /** 进度订阅者：抛错（SSE 已断开）即被移除，其余订阅者与等待者不受影响 */
  listeners: Set<(stage: AnalysisStage) => void>;
  /** 是否曾有订阅者（仅 SSE 路由会传回调）：用于判断「已无人消费进度」是否成立 */
  hadListener: boolean;
  /** 无进度回调的等待者数（POST / 工具调用）：只要还有人等结果，就不因订阅者断开而中止整轮 */
  silentWaiters: number;
  /**
   * 本轮采用的续跑语义（`options.resume === true`）。
   * 用于判断后来者能否安全复用：`{resume:true}` 的轮次会读断点、跳过已完成阶段，
   * 它产出的不一定是「全新分析」；反过来，全新轮次也不满足断点续跑的语义。
   */
  resume: boolean;
}

const inFlightAnalyses = new Map<string, InFlightAnalysis>();

/**
 * 在途轮次的语义冲突错误码：由 routes/analysis.ts 映射成 HTTP 409（SSE 路径推 error 事件）。
 * 单独定义常量而非散落字面量，便于路由与测试共用同一个稳定标识。
 */
export const ANALYSIS_IN_FLIGHT = 'ANALYSIS_IN_FLIGHT';

/**
 * 同一标的已有在途分析、且 resume 语义与本次请求不一致时抛出。
 *
 * 为什么不把 resume 拼进 single-flight 键：那会让同标的两次分析**并行**跑——LLM 成本
 * 直接翻倍，而且两代 checkpoint 会互相覆盖/删除对方的产物（runId 代次冲突）。
 * 显式拒绝则把「语义冲突」变成调用方可见、可重试的 409，而不是静默复用一份
 * 可能来自过期断点的结果。
 *
 * message 自带 `ANALYSIS_IN_FLIGHT` 标记：SSE 路径在生产环境不回传内部 detail，
 * 标记放进 message，前端与日志才不会丢掉可判定的错误码。
 */
function inFlightConflictError(): Error {
  const err = new Error(`该标的已有一次分析在进行中，请稍后重试（${ANALYSIS_IN_FLIGHT}）`);
  (err as Error & { code?: string }).code = ANALYSIS_IN_FLIGHT;
  return err;
}

/**
 * 运行一次完整分析（按股票代码去重：同代码已有在途分析时挂到同一轮，不重复开跑）。
 *
 * @throws 已有在途轮次且 resume 语义与本次不一致时抛 ANALYSIS_IN_FLIGHT（注意是同步抛出）
 */
export function runAnalysis(
  stockCode: string,
  onProgress?: (stage: AnalysisStage) => void,
  options: RunAnalysisOptions = {},
): Promise<AnalysisResult> {
  const resume = options.resume === true;
  const existing = inFlightAnalyses.get(stockCode);
  if (existing) {
    // 语义不一致（在途是续跑、本次要全新分析，或反之）→ 明确拒绝，不静默复用：
    // 调用方以为跑的是自己那一轮，实际数据来源（是否来自过期断点）完全不同
    if (existing.resume !== resume) throw inFlightConflictError();
    // 语义一致：复用结果（不重复调用 LLM），进度广播给新订阅者
    if (onProgress) {
      existing.listeners.add(onProgress);
      existing.hadListener = true;
    } else {
      existing.silentWaiters += 1;
    }
    return existing.promise;
  }

  const handle: InFlightAnalysis = {
    promise: undefined as unknown as Promise<AnalysisResult>, // 紧随其后赋值
    listeners: new Set(),
    hadListener: false,
    silentWaiters: 0,
    resume,
  };
  if (onProgress) {
    handle.listeners.add(onProgress);
    handle.hadListener = true;
  } else {
    handle.silentWaiters = 1;
  }
  handle.promise = executeAnalysis(stockCode, handle, options).finally(() => {
    // 只删自己那一轮：避免把随后新起的同代码轮次误删
    if (inFlightAnalyses.get(stockCode) === handle) inFlightAnalyses.delete(stockCode);
  });
  inFlightAnalyses.set(stockCode, handle);
  return handle.promise;
}

async function executeAnalysis(
  stockCode: string,
  handle: InFlightAnalysis,
  options: RunAnalysisOptions,
): Promise<AnalysisResult> {
  const emit = (stage: AnalysisStage) => {
    // 逐个订阅者推送：某个订阅者断开（SSE 已关闭时 send 抛错）不得影响其余订阅者与等待者。
    // 先取快照再遍历：本轮内被移除的订阅者不应再收到本次事件。
    for (const listener of Array.from(handle.listeners)) {
      try {
        listener(stage);
      } catch {
        handle.listeners.delete(listener);
      }
    }
    // 保持既有语义：进度订阅者全部断开、且没有别的调用方在等结果时，在阶段边界提前中止，
    // 不再白跑 1-3 分钟的专家研判/外部请求（无人消费的结论没有意义，且要白付 LLM 成本）。
    if (handle.hadListener && handle.listeners.size === 0 && handle.silentWaiters === 0) {
      throw new Error('SSE_CLIENT_DISCONNECTED');
    }
  };

  // 断点续跑：仅在显式请求 resume 时读取，避免陈旧中间态被误用
  const ck = options.resume ? loadCheckpoint(stockCode) : null;
  // 本代代次：续跑沿用断点记录的代次（同一条续跑链共享一代），全新分析新起一代
  const runId = ck?.runId ?? newRunId();
  if (ck) {
    emit({
      phase: 'data',
      message: `从上次中断处继续（已完成至「${stageLabel(ck.stage)}」阶段，跳过已完成的环节）`,
    });
    if (ck.runId !== runId) {
      // 旧格式断点（无 runId）：把本次采用的上游产物显式落到本代。
      // 否则后续 saveCheckpoint 会因代次不符拒绝 merge，续跑链的产物断在原地。
      saveCheckpoint(
        stockCode,
        {
          stage: ck.stage,
          data: ck.data,
          expertOpinions: ck.expertOpinions,
          degradedExperts: ck.degradedExperts,
          expertByKey: ck.expertByKey,
          controversies: ck.controversies,
          finalOpinion: ck.finalOpinion,
        },
        runId,
      );
    }
  } else {
    // 全新分析：丢弃磁盘上任何残留断点（含未被读取清理的已过期代）。
    // 若不清，上一代的 experts/arbitration 产物会混入新生成的断点——新分析若在 experts
    // 完成前中断，后续 resume 会把新取的数据与旧代专家结论拼在一起（跨代错配）。
    // saveCheckpoint 侧另有代次校验兜底（异代一律不 merge），两道防线互不依赖。
    clearCheckpoint(stockCode);
  }

  // 1. 数据获取 + 新闻情绪 + 行情历史：三者都只依赖股票代码，并行拉取（省网络往返）
  //    断点命中时直接复用，跳过网络往返
  let dataResult: Awaited<ReturnType<typeof getData>>;
  let newsSignal: NewsSignal | null;
  let priceHistory: PriceHistoryPoint[];

  if (ck?.data) {
    dataResult = {
      info: ck.data.info,
      financial: ck.data.financial,
      valuation: ck.data.valuation,
    };
    newsSignal = ck.data.newsSignal;
    priceHistory = ck.data.priceHistory;
  } else {
    emit({ phase: 'data', message: '正在获取行情/财务/新闻数据...' });
    const [fetchedData, newsResult, fetchedPrices] = await Promise.all([
      getData(stockCode),
      // 新闻情绪尽力而为：限时 3s，失败/超时视为无新闻（不阻塞主流程）。
      // 用 withAbortableTimeout 而非 withTimeout：超时后要真正断开新闻抓取
      // （逐端点 8s + LLM 打分 30s，只 race 不取消的话这趟请求会继续跑满）。
      withAbortableTimeout((signal) => extractNewsSignal(stockCode, { signal }), 3000).catch(
        () => ({
          signal: null as NewsSignal | null,
          source: 'none' as const,
        }),
      ),
      // 行情历史（日K）：近 2 年，限时 12s，失败/超时降级为模拟数据（不阻塞主流程）
      withAbortableTimeout((signal) => fetchPriceHistory(stockCode, signal), 12000).catch(
        () => [] as PriceHistoryPoint[],
      ),
    ]);
    dataResult = fetchedData;
    newsSignal = newsResult.signal;
    priceHistory = fetchedPrices;
    // 落盘保存「未经 PE/PB 修正」的原始数据：后续修正是确定性纯计算，
    // 续跑时重放得到同样结果，避免修正被重复叠加。
    saveCheckpoint(
      stockCode,
      {
        stage: 'data',
        data: {
          info: fetchedData.info,
          financial: fetchedData.financial,
          valuation: fetchedData.valuation,
          newsSignal,
          priceHistory: fetchedPrices,
        },
      },
      runId,
    );
  }
  const { info, financial, valuation } = dataResult;
  const n = financial.years.length;

  // 审计：数据访问完成（合规留痕；runAnalysis 无会话上下文，以股票代码作为审计会话键）
  try {
    auditDataAccess(stockCode, '行情/财务数据接口', 'read');
  } catch (err) {
    logger.warn('审计记录数据访问失败，降级跳过', { stockCode, err: err as Error });
  }

  // === 修正 PE/PB：用股价/每股收益 和 股价/每股净资产 计算，不依赖API不可靠的f167/f164字段 ===
  const latestEps = financial.eps[n - 1]; // 元/股
  const latestNetProfit = financial.netProfit[n - 1]; // 亿元
  const latestEquity = financial.equity?.[n - 1] ?? 0; // 亿元
  const price = valuation.currentPrice; // 元/股

  if (latestEps > 0 && price > 0) {
    // PE = 股价 / 每股收益
    valuation.pe = Math.round((price / latestEps) * 100) / 100;

    // PB = 股价 / 每股净资产
    // 从 netProfit(亿元) 和 eps(元/股) 反推总股本: totalShares = netProfit*1e8 / eps
    const totalShares = latestNetProfit > 0 ? (latestNetProfit * 1e8) / latestEps : 0;
    if (totalShares > 0 && latestEquity > 0) {
      const bvps = (latestEquity * 1e8) / totalShares; // 元/股
      if (bvps > 0) {
        valuation.pb = Math.round((price / bvps) * 100) / 100;
      }
    }
  } else if (latestNetProfit > 0 && valuation.marketCap > 0) {
    // EPS不可用时回退到市值/净利润
    valuation.pe = Math.round((valuation.marketCap / latestNetProfit) * 100) / 100;
    if (latestEquity > 0) {
      valuation.pb = Math.round((valuation.marketCap / latestEquity) * 100) / 100;
    }
  }

  // 修正历史PE估算，基于修正后的当前PE
  // 说明：免费API无法获取真实历史PE，此处为确定性估算。
  // 采用"历史中枢略高于当前PE"的假设（A股估值中枢长期下移，历史平均通常高于当前），
  // 最新年份使用真实当前PE，历史年份围绕中枢波动，使 pePercentile 能反映当前估值相对历史的位置。
  // 估算系数（确定性经验值，调整会影响 pePercentile 的分布）：
  const HISTORICAL_PE_CENTER_RATIO = 1.18; // 历史中枢 = 当前PE × 1.18（中枢略高于当前）
  const HISTORICAL_PE_YEARS = 5; // 回溯估算的历史年份数（不含当前年）
  const HISTORICAL_PE_TREND_SLOPE = 0.02; // 每年轻微趋势系数（越早的年份估值越高）
  const HISTORICAL_PE_NOISE_AMPLITUDE = 0.25; // 围绕中枢的确定性波动幅度（±25%）
  if (valuation.pe > 0) {
    const currentYear = new Date().getFullYear();
    const seed = parseInt(stockCode.slice(-3)) || 42;
    const center = valuation.pe * HISTORICAL_PE_CENTER_RATIO; // 历史中枢：略高于当前
    const historicalPE: { year: string; pe: number; isEstimated: boolean }[] = [];
    for (let i = HISTORICAL_PE_YEARS; i >= 0; i--) {
      const year = (currentYear - i).toString();
      if (i === 0) {
        historicalPE.push({ year, pe: valuation.pe, isEstimated: false });
      } else {
        const hash = ((seed * (i + 1) * 2654435761) >>> 0) % 1000;
        const variation = (hash - 500) / 500; // -1 ~ 1
        const trend = 1 + (i - HISTORICAL_PE_YEARS / 2) * HISTORICAL_PE_TREND_SLOPE; // 轻微时间趋势
        const estimatedPe =
          Math.round(center * trend * (1 + variation * HISTORICAL_PE_NOISE_AMPLITUDE) * 10) / 10;
        historicalPE.push({ year, pe: Math.max(estimatedPe, 1), isEstimated: true });
      }
    }
    valuation.historicalPE = historicalPE;
  }

  // 2. 机构一致预期快照（盈利预测 + 北向持股）：尽力而为（限时 6s），失败不阻断
  //    主流程。**快照无历史序列，只进 LLM 语境与结果展示，不进任何回测因子**——
  //    把今天的预期投影回历史截面就是前视（见 consensusProvider 的方法论边界）。
  let consensus: ConsensusSnapshot | null = null;
  let consensusBrief: string | null = null;
  try {
    // 超时/失败在这里统一落日志（原来外层 .catch 吞掉异常后，下面的 catch 是死代码）
    // 刻意不传 controller：fetchConsensusSnapshot 的 producer 由 withQuantCache 在并发调用方
    // 之间共享（同一代码可能同时被本管线与单票接口请求）。abort 会连带打断别人的那次取数，
    // 而「超时后让它跑完」反而是对的——结果会写进缓存，白烧变成预热。
    // 该 provider 自身有硬上限（eventProvider 的 AbortSignal.timeout(15000)），不会无限挂住。
    consensus = await withTimeout(fetchConsensusSnapshot(stockCode), 6000);
    consensusBrief = consensus ? formatConsensusBrief(consensus) : null;
  } catch (err) {
    logger.warn('机构一致预期获取失败，降级跳过', { stockCode, err: err as Error });
  }

  // 2.5 最近公告语境（标题一览 + 最新一篇正文摘录）：尽力而为（限时 6s），失败不阻断。
  //     只呈现公告原文（截断标注），专家研判可回指原文，不做摘要改写。
  let announcementBrief: string | null = null;
  try {
    // 同上一节：公告 provider 也是 withQuantCache 共享 producer，不传 controller。
    // 它自带 AbortSignal.timeout(12_000)（announcementProvider.fetchJson），不会无限挂住。
    announcementBrief = await withTimeout(buildAnnouncementBrief(stockCode), 6000);
  } catch (err) {
    logger.warn('最近公告获取失败，降级跳过', { stockCode, err: err as Error });
  }

  // 3. 多专家独立研判（并行 + 单专家降级 + 断点复用）
  //    借鉴 TradingAgents 的节点级 crash-safety：单个专家失败不再拖垮整次分析，
  //    失败者从仲裁输入中剔除并记入 degradedExperts，由报告如实披露覆盖度。
  let expertOpinions: ExpertOpinion[];
  let degradedExperts: string[];
  let expertByKey: Record<string, ExpertOpinion | undefined>;

  if (ck?.expertOpinions?.length) {
    expertOpinions = ck.expertOpinions;
    degradedExperts = ck.degradedExperts ?? [];
    expertByKey = ck.expertByKey ?? {};
    emit({
      phase: 'experts',
      message: `复用上次专家研判结果（${expertOpinions.length}/${EXPERT_TOTAL} 位）`,
    });
  } else {
    emit({ phase: 'experts', message: '8 位专家独立研判中...' });
    const expertOutcome = await runExpertsWithDegradation([
      {
        key: 'fundamental',
        name: '基本面专家',
        run: () => fundamentalExpert(financial, valuation, info, consensusBrief),
      },
      {
        key: 'valuation',
        name: '估值专家',
        run: () => valuationExpert(financial, valuation, info, consensusBrief),
      },
      {
        key: 'industry',
        name: '行业专家',
        run: () => industryExpert(financial, valuation, info, consensusBrief),
      },
      {
        key: 'risk',
        name: '风险专家',
        run: () => riskExpert(financial, valuation, info, consensusBrief),
      },
      {
        key: 'capital',
        name: '资金流专家',
        run: () => capitalFlowExpert(financial, valuation, info, consensusBrief),
      },
      {
        key: 'policy',
        name: '政策专家',
        run: () => policyExpert(financial, valuation, info, consensusBrief),
      },
      {
        key: 'hotMoney',
        name: '题材专家',
        run: () => hotMoneyExpert(financial, valuation, info, consensusBrief),
      },
      {
        key: 'unlock',
        name: '解禁专家',
        run: () => unlockExpert(financial, valuation, info, consensusBrief),
      },
    ]);
    // 全部专家均失败时无法形成有效研判，直接抛错交由上层（500 / SSE error）处理
    if (expertOutcome.opinions.length === 0) {
      throw new Error('全部 8 位专家研判均失败，无法生成分析报告');
    }
    expertOpinions = expertOutcome.opinions;
    degradedExperts = expertOutcome.degradedExperts;
    expertByKey = expertOutcome.byKey;
    saveCheckpoint(
      stockCode,
      { stage: 'experts', expertOpinions, degradedExperts, expertByKey },
      runId,
    );
  }

  /** 按 key 取专家情绪；该专家降级时以 neutral 兜底，保证下游自省逻辑不中断 */
  const sentimentOf = (key: string): ExpertOpinion['overallSentiment'] =>
    expertByKey[key]?.overallSentiment ?? 'neutral';

  // 3. 辩论仲裁（断点命中时复用上次结论，省去一次大上下文 LLM 调用）
  let controversies: ControversyPoint[];
  let finalOpinion: ExpertOpinion;
  // 决策-结果闭环：先回填到期评级的实际结果，再把历史命中率注入仲裁，
  // 让"历次判断是否兑现"参与本次裁决（限时 8s，失败不阻断主流程）。
  let ratingAccuracyHint: string | null = null;
  let accuracySummary: ReturnType<typeof getRatingAccuracy> | null = null;
  if (ck?.finalOpinion && ck.controversies) {
    controversies = ck.controversies;
    finalOpinion = ck.finalOpinion;
    emit({ phase: 'arbitration', message: '复用上次仲裁结论' });
  } else {
    try {
      // 回填要向行情上游逐条取数（每条自带 15s 上限），8s 到点必须真正收手：
      // 取消会传到 evaluateOutcomes → fetchOHLCVData，已完成条目照常落盘，剩余留待下轮
      await withAbortableTimeout((signal) => evaluateOutcomes(3, signal), 8000).catch(() => 0);
      accuracySummary = getRatingAccuracy(stockCode);
      ratingAccuracyHint = formatAccuracyHint(stockCode);
    } catch {
      /* 事后校准失败不影响主流程 */
    }
    emit({ phase: 'arbitration', message: '多专家辩论仲裁中...' });
    const arbitration = await arbitrationExpert({
      financial,
      valuation,
      info,
      opinions: expertOpinions,
      ratingAccuracy: ratingAccuracyHint,
    });
    controversies = arbitration.controversies;
    finalOpinion = arbitration.finalOpinion;
    saveCheckpoint(stockCode, { stage: 'arbitration', controversies, finalOpinion }, runId);
  }

  const allOpinions = [...expertOpinions, finalOpinion];

  // 专家结论来源统计：LLM 未配置/排队超时/调用失败时，专家层会静默降级到规则引擎
  // （见 llm/expertRunner.ts 的 _degraded 标记）。这里统计人数与原因，
  // 稍后写入报告既有的 limitation_explain 字段——不新造第二套披露机制。
  const expertDegradation = summarizeExpertDegradation(expertOpinions);
  // 仲裁层单独判定：它不在 8 位专家之列，但「专家全 LLM 成功、仲裁却降级」同样会让
  // 读者把规则引擎的仲裁结论当成 LLM 仲裁，必须一并披露。
  const arbitrationReason = isDegradedOpinion(finalOpinion) ? getDegradeReason(finalOpinion) : null;
  if (arbitrationReason) expertDegradation.arbitration = arbitrationReason;

  // 审计：LLM 专家调用完成（合规留痕；以专家名单与仲裁结论概要作为调用记录）
  try {
    const expertSummary = allOpinions
      .map((o) => `${o.expert}:${o.overallSentiment}(${o.confidence})`)
      .join(';');
    auditLLMCall(
      stockCode,
      'multi-expert-arbitration',
      expertSummary,
      finalOpinion.overallSentiment,
    );
  } catch (err) {
    logger.warn('审计记录 LLM 专家调用失败，降级跳过', { stockCode, err: err as Error });
  }

  // === 提前计算公共指标（后续多处引用） ===
  // 单年财务数据（n < 2）时 revenue[n-2] 是 undefined：`undefined !== 0` 成立，
  // 于是算出 NaN 并写进报告正文（"利润增速NaN%"），还会随 historyService 落盘持久化。
  // 空数组喂给 Math.max/Math.min 得 -Infinity，同理。这里统一按"有两年以上数据才算增速"处理。
  const hasPrevYear = n >= 2;
  const pctChange = (series: number[]): number => {
    if (!hasPrevYear) return 0;
    const prev = series[n - 2];
    const curr = series[n - 1];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) return 0;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };
  const revenueGrowthLatest = pctChange(financial.revenue);
  const profitGrowthLatest = pctChange(financial.netProfit);
  const cashFlowRatio = (() => {
    const profit = financial.netProfit[n - 1];
    const cash = financial.operatingCashFlow[n - 1];
    if (!Number.isFinite(profit) || !Number.isFinite(cash) || profit === 0) return 0;
    return cash / profit;
  })();
  const grossMarginRange =
    financial.grossMargin.length > 0
      ? Math.max(...financial.grossMargin) - Math.min(...financial.grossMargin)
      : 0;

  // PE 历史分位
  const peValues = valuation.historicalPE.map((h) => h.pe).sort((a, b) => a - b);
  const pePercentile =
    safeDiv(peValues.filter((p) => p <= valuation.pe).length, peValues.length) * 100;

  // 4. 双层自省
  const reflectionNotes: string[] = [];

  // 专家覆盖度披露：有专家降级时如实说明，避免读者按满员研判理解置信度
  if (degradedExperts.length > 0) {
    reflectionNotes.push(
      `【自省·覆盖度】本次 ${EXPERT_TOTAL - degradedExperts.length}/${EXPERT_TOTAL} 位专家参与研判，${degradedExperts.join('、')}未能返回结果，已自动降级剔除，结论置信度相应下调。`,
    );
  }

  // 事后校准披露：让报告读者知道这套评级在该股上的历史兑现情况
  if (accuracySummary && accuracySummary.stock.sampleCount > 0) {
    const s = accuracySummary.stock;
    const calibration =
      s.accuracyPct !== null
        ? `该股历史评级命中率 ${s.accuracyPct}%（${s.hitCount}/${s.judgedCount} 次方向判断兑现）`
        : `该股已累积 ${s.sampleCount} 次评级样本，样本量尚不足以统计命中率`;
    reflectionNotes.push(`【自省·事后校准】${calibration}，本次结论请结合该历史表现审慎采信。`);
  }

  // 第一层：事实自省 - 基于数据阈值触发
  // 营收增速与专家情绪矛盾检查
  if (revenueGrowthLatest < 5 && sentimentOf('fundamental') === 'bullish') {
    reflectionNotes.push(
      `【自省】营收增速仅${revenueGrowthLatest.toFixed(1)}%，基本面专家仍看多，可能存在乐观偏差。`,
    );
  }

  // 现金流/利润一致性检查
  if (cashFlowRatio < 0.5) {
    reflectionNotes.push(
      `【自省·警告】经营现金流/净利润仅${cashFlowRatio.toFixed(2)}，盈利质量存疑。`,
    );
  } else if (cashFlowRatio > 0.9) {
    reflectionNotes.push(
      `【自省·验证通过】经营现金流/净利润=${cashFlowRatio.toFixed(2)}，盈利质量可靠。`,
    );
  }

  // 毛利率稳定性检查
  if (grossMarginRange > 10) {
    reflectionNotes.push(
      `【自省·警告】毛利率波动${grossMarginRange.toFixed(1)}个百分点，盈利稳定性较差。`,
    );
  } else if (grossMarginRange < 3) {
    reflectionNotes.push(
      `【自省·验证通过】毛利率波动仅${grossMarginRange.toFixed(1)}个百分点，稳定性高。`,
    );
  }

  // 第二层：逻辑闭环 - 通用化 4 个自问
  // 逻辑闭环①：历史数据外推的局限性
  reflectionNotes.push(
    `【逻辑闭环①】分析基于${n}年财务数据外推，历史趋势在行业拐点可能失效。数据跨度${n}年（${financial.years[0]}-${financial.years[n - 1]}）。`,
  );

  // 逻辑闭环②：最可能的看错场景（从动态风险列表取第一条）
  // 注意：actualRisks 在后面计算，这里先预计算
  const preComputedRisks = allOpinions
    .flatMap((o) =>
      o.arguments
        .filter((a) => a.type === 'oppose' && a.confidence >= 65)
        .map((a) => (a.text.length > 60 ? a.text.slice(0, 57) + '...' : a.text)),
    )
    .slice(0, 6);
  const topRisk = preComputedRisks[0] || '未知风险';
  reflectionNotes.push(`【逻辑闭环②】最可能的"看错"场景：${topRisk}。`);

  // 逻辑闭环③：市场是否已 price in（基于 PE 历史分位）
  if (pePercentile <= 20) {
    reflectionNotes.push(
      `【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，市场可能已充分反映悲观预期。`,
    );
  } else if (pePercentile >= 80) {
    reflectionNotes.push(
      `【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，乐观预期可能已充分定价。`,
    );
  } else {
    reflectionNotes.push(
      `【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，估值处于合理区间。`,
    );
  }

  // 逻辑闭环④：关键跟踪指标（基于专家情绪动态判断）
  const topConcern =
    sentimentOf('industry') === 'bearish'
      ? '行业景气度下行'
      : sentimentOf('valuation') === 'bearish'
        ? '估值压力'
        : '基本面变化';
  reflectionNotes.push(`【逻辑闭环④】如果只能跟踪一个方向，应重点关注：${topConcern}。`);

  // 5. 量化打分（传入行业景气度建议；行业专家降级时不传，由打分引擎取默认）
  const industrySuggestion = (expertByKey.industry as IndustryExpertResult | undefined)
    ?.industryScoreSuggestion;
  const scoreDetail = calculateScores(financial, valuation, info, industrySuggestion);
  const totalScore =
    scoreDetail.profit_quality +
    scoreDetail.growth +
    scoreDetail.valuation +
    scoreDetail.industry_boom +
    scoreDetail.risk_deduction;

  // 6. 综合评级
  let rating: string;
  if (totalScore >= 80) rating = '优先跟踪';
  else if (totalScore >= 60) rating = '持续观察';
  else if (totalScore >= 40) rating = '谨慎观望';
  else rating = '建议规避';

  emit({
    phase: 'scoring',
    message: `量化打分完成：${totalScore}/100，${rating}`,
    totalScore,
    rating,
  });

  // 7. 估值水平判断
  let valuationLevel: string;
  if (pePercentile <= 20) valuationLevel = '历史低估';
  else if (pePercentile <= 40) valuationLevel = '偏低估';
  else if (pePercentile <= 60) valuationLevel = '合理';
  else if (pePercentile <= 80) valuationLevel = '偏高估';
  else valuationLevel = '历史高估';

  // 8. 生成核心摘要（动态，无硬编码文本）
  const fundamentalSentiment = sentimentOf('fundamental');
  const sentimentWord =
    fundamentalSentiment === 'bullish'
      ? '优秀'
      : fundamentalSentiment === 'bearish'
        ? '偏弱'
        : '中等';
  const coreSummary =
    `${info.name}（${info.code}）属于${info.industry}行业，当前PE ${valuation.pe}x（${valuationLevel}）。` +
    `盈利质量${sentimentWord}（毛利率${financial.grossMargin[n - 1]}%、ROE ${financial.roe[n - 1]}%），` +
    `最新营收增速${revenueGrowthLatest.toFixed(1)}%、利润增速${profitGrowthLatest.toFixed(1)}%。` +
    `综合评分${totalScore}/100，评级：${rating}。`;

  // 审计：生成交易信号/评级（合规留痕；评级本身作为信号，核心摘要作为决策依据）
  try {
    auditTradeSignal(stockCode, info.code, rating, coreSummary);
  } catch (err) {
    logger.warn('审计记录交易信号失败，降级跳过', { stockCode, err: err as Error });
  }

  // 9. 优势与风险列表（从专家论点动态提取）
  const actualStrengths = allOpinions
    .flatMap((o) =>
      o.arguments
        .filter((a) => a.type === 'support' && a.confidence >= 70)
        .map((a) => (a.text.length > 60 ? a.text.slice(0, 57) + '...' : a.text)),
    )
    .slice(0, 6);

  const actualRisks = preComputedRisks;

  // 10. 后续跟踪指标（动态生成）
  const followUpIndicators: string[] = [];
  // 通用指标
  followUpIndicators.push('季度营收/净利润增速变化');
  followUpIndicators.push('经营现金流/净利润比率');
  followUpIndicators.push('毛利率/净利率趋势变化');

  // 基于风险专家发现的财务风险动态添加
  if (safeDiv(financial.accountsReceivable[n - 1], financial.revenue[n - 1]) * 100 > 10) {
    followUpIndicators.push('应收账款周转天数变化（占营收比例偏高）');
  }
  if (financial.goodwill[n - 1] > 0) {
    followUpIndicators.push('商誉减值风险跟踪');
  }
  if (financial.debtRatio[n - 1] > 50) {
    followUpIndicators.push('资产负债率变化（杠杆偏高）');
  }

  // 基于行业特征
  followUpIndicators.push(`${info.industry}行业政策动向`);
  followUpIndicators.push('同业可比公司估值变化');

  // 基于估值分位
  if (pePercentile <= 30) {
    followUpIndicators.push('PE 是否继续下探（当前处于历史低位区间）');
  } else if (pePercentile >= 70) {
    followUpIndicators.push('PE 是否见顶回落（当前处于历史高位区间）');
  }

  // 11. 数据来源（动态，基于实际数据年份）
  const dataSources: DataSource[] = [
    {
      name: '年度财务报告',
      description: `公司${financial.years[0]}-${financial.years[n - 1]}年公开年报数据`,
      confidence: 90,
      coverage: '基本面专家 / 估值水平 / 财务指标表',
    },
    {
      name: '实时行情数据',
      description: '东方财富/新浪财经实时行情接口',
      confidence: 85,
      coverage: 'K线图 / 回测价格 / 资金筹码专家',
    },
    {
      name: '行业对比数据',
      description: '同业可比公司公开财务指标',
      confidence: 80,
      coverage: '行业专家 / 可比公司表',
    },
    {
      name: '估值历史数据',
      description: '历史PE/PB等估值指标',
      confidence: 75,
      coverage: '估值分位 / 情景推演',
    },
    ...(newsSignal?.hasNews
      ? [
          {
            name: '新闻舆情',
            description: '个股新闻检索与情绪打分（有新闻时出现）',
            confidence: 70,
            coverage: '消息情绪信号 / newsAware 策略对比',
          },
        ]
      : []),
    ...(consensus
      ? [
          {
            name: '机构一致预期',
            description: '东财分析师盈利预测与北向持股快照',
            confidence: 78,
            coverage: '一致预期卡片（当前快照口径）',
          },
        ]
      : []),
    ...(announcementBrief
      ? [
          {
            name: '公司公告',
            description: '东财公告网关：标题一览 + 最新一篇正文摘录（原文口径）',
            confidence: 88,
            coverage: '公告语境块（LLM 研判与报告展示）',
          },
        ]
      : []),
  ];

  // 12. 情景推演（可选叠加最新消息情绪 z 与极性微调）
  const scenarios = generateScenarios(
    allOpinions,
    financial,
    valuation,
    info,
    newsSignal?.hasNews
      ? { sentimentZ: newsSignal.sentimentZ, polarity: newsSignal.polarity }
      : undefined,
  );

  // 12.5 若抓到最新消息，补充一条自省（逻辑闭环⑤）
  if (newsSignal?.hasNews) {
    reflectionNotes.push(
      `【逻辑闭环⑤】最新消息情绪极性 ${newsSignal.polarity.toFixed(2)}（看多占比 ${(newsSignal.bullishRatio * 100).toFixed(0)}%、新鲜度 ${(newsSignal.freshness * 100).toFixed(0)}%），已纳入情景推演与策略回测。`,
    );
  }

  // 13. 量化策略清单（获取OHLCV数据并运行回测，可选叠加最新消息情绪）
  emit({ phase: 'strategy', message: '量化策略回测中...' });
  let strategyList: import('../types.js').StrategyRecommendation[] = [];
  try {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const ohlcvData = await fetchOHLCVData(info.code, startDate, endDate);
    if (ohlcvData.length > 0) {
      const isSimulated = ohlcvData.some((d) => d.isSimulated);
      const rawStrategies = await generateStrategyList(
        info.code,
        ohlcvData,
        newsSignal?.hasNews
          ? {
              polarity: newsSignal.polarity,
              since: earliestNewsDate(newsSignal.items),
              timeline: newsSignal.timeline,
            }
          : null,
      );
      strategyList = rawStrategies.map((s) => ({
        strategyType: s.strategyType,
        sharpeRatio: s.sharpeRatio,
        maxDrawdown: s.maxDrawdown,
        winRate: s.winRate,
        totalReturn: s.totalReturn,
        applicableMarket: s.applicableMarket,
        fatalWeakness: s.fatalWeakness,
        backtestWarning: isSimulated
          ? `[[模拟数据]] ${s.backtestWarning || ''} (K线API不可达，回测基于模拟价格，不代表真实行情)`
          : s.backtestWarning,
        newsAware: s.newsAware,
      }));
    }
  } catch (e) {
    logger.warn('策略清单生成失败', { stockCode: info.code, err: e as Error });
  }

  // === 可选增强（不改变现有输出契约；均 try/catch 降级，失败不阻断主流程）===

  // 14. 知识图谱增强：把当前股票与同业可比数据构建为关系图谱上下文，
  //     供报告/对话引用行业关系（同业、行业均值、上下游）。失败降级为无字段。
  let knowledgeGraphContext: string | undefined;
  try {
    const peers = valuation.peerComparison ?? [];
    if (peers.length > 0) {
      const graphStocks = [
        {
          code: info.code,
          name: info.name,
          sector: info.industry,
          pe: valuation.pe,
          pb: valuation.pb,
          roe: financial.roe[n - 1] ?? 0,
          grossMargin: financial.grossMargin[n - 1] ?? 0,
        },
        ...peers.map((p) => ({
          code: p.code,
          name: p.name,
          sector: info.industry,
          pe: p.pe,
          pb: p.pb,
          roe: p.roe,
          grossMargin: 0, // 同业无毛利率数据，置 0 避免 NaN
        })),
      ];
      const graph = buildFinancialGraph({
        stocks: graphStocks,
        sectors: [
          {
            name: info.industry,
            avgPE: safeDiv(
              graphStocks.reduce((s, x) => s + x.pe, 0),
              graphStocks.length,
            ),
            avgPB: safeDiv(
              graphStocks.reduce((s, x) => s + x.pb, 0),
              graphStocks.length,
            ),
            avgROE: safeDiv(
              graphStocks.reduce((s, x) => s + x.roe, 0),
              graphStocks.length,
            ),
          },
        ],
      });
      knowledgeGraphContext = graph.toContextString(graphStocks.map((s) => `stock:${s.code}`));
    }
  } catch (err) {
    logger.warn('知识图谱增强失败，降级跳过', { stockCode: info.code, err: err as Error });
  }

  // 15. 行业轮动增强：股票有行业归属时，用其财务特征估算行业轮动信号（beta 曝光 + 轮动排名）。
  //     单行业截面无法比较，rank 恒为 1、recommendation 恒为 overweight，仅作参考。失败降级为无字段。
  let sectorRotationSignal: SectorRotationSignal | undefined;
  try {
    if (info.industry) {
      const sectorData: SectorData = {
        sector: info.industry,
        revenueGrowth: revenueGrowthLatest,
        profitGrowth: profitGrowthLatest,
        roeChange: (financial.roe[n - 1] ?? 0) - (financial.roe[n - 2] ?? 0),
        momentum20d: 0,
        momentum60d: 0,
        turnoverRate: 0,
        volumeRatio: 0,
        northboundConcentration: 0,
        benchmarkMomentum20d: 0,
      };
      const rotation = calculateSectorRotation([sectorData]);
      const sig = rotation.signals[0];
      // beta 曝光：以资产负债率为杠杆代理做启发式估算（非回归），clamp 到 [0.5, 2]
      const debtRatio = financial.debtRatio[n - 1] ?? 0;
      const industryBeta =
        Math.round(Math.min(2, Math.max(0.5, 0.8 + (debtRatio - 40) / 50)) * 100) / 100;
      sectorRotationSignal = {
        sector: sig?.sector ?? info.industry,
        compositeScore: sig?.compositeScore ?? 0,
        rank: sig?.rank ?? 1,
        recommendation: sig?.recommendation ?? 'neutral',
        prosperity: sig?.prosperity ?? 0,
        trend: sig?.trend ?? 0,
        crowding: sig?.crowding ?? 0,
        industryBeta,
        summary: rotation.summary,
        date: rotation.date,
      };
    }
  } catch (err) {
    logger.warn('行业轮动增强失败，降级跳过', { stockCode: info.code, err: err as Error });
  }

  // 16. MCP 增强：仅当配置了外部 MCP 服务器时启用（未配置则跳过）。
  //     拉取外部工具清单作为上下文附加到报告；连接失败降级为无字段。
  let mcpContext: { serverUrl: string; toolCount: number; tools: string[] } | undefined;
  if (process.env.MCP_SERVER_URL) {
    try {
      const { MCPRegistry } = await import('../llm/mcpClient.js');
      const registry = new MCPRegistry();
      registry.register('analysis-mcp', {
        transport: 'sse',
        url: process.env.MCP_SERVER_URL,
      });
      await registry.connectAll();
      try {
        const tools = await registry.listAllTools();
        mcpContext = {
          serverUrl: process.env.MCP_SERVER_URL,
          toolCount: tools.length,
          tools: tools.map((t) => t.name),
        };
      } finally {
        // listAllTools 抛错时也必须断连，避免 SSE 连接悬挂泄漏
        await registry.disconnectAll();
      }
    } catch (err) {
      logger.warn('MCP 增强失败，降级跳过', { stockCode: info.code, err: err as Error });
    }
  }

  // 风险归因（借鉴 GS Quant RiskModel 轻量版）：风格因子暴露 + 系统/特异风险分解。
  // 动量因子暂缺收益序列数据（记 0 中性）；特异波动用经验基准（无残差序列时）。
  const styleExposures = styleFactorExposures({
    marketCap: valuation.marketCap,
    pe: valuation.pe,
    roe: financial.roe?.[financial.roe.length - 1],
    debtRatio: financial.debtRatio?.[financial.debtRatio.length - 1],
  });
  const riskDecomposition = decomposeRisk(styleExposures, SPECIFIC_RISK_BASELINE);

  // 分析成功：清除本代断点（中间产物已无用，避免陈旧数据被后续误用）。
  // 带 runId 只清本代：并发另一代的在途断点不该被这一轮的成功收尾顺手删掉。
  clearCheckpoint(stockCode, runId);

  return {
    // 报告生成时间与行情数据截止日：金融结论必须能判断"这是什么时候的"。
    // 此前结果对象里没有任何时间字段，报告与导出的 Markdown 都失去时间锚点。
    generatedAt: new Date().toISOString(),
    // 行情数据截止日（最后一根 K 线日期）；无行情（取数失败且无降级数据）时不出现该字段
    dataAsOf: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].date : undefined,
    stock_pool: [
      {
        stock_code: info.code,
        stock_name: info.name,
        industry: info.industry,
        core_summary: coreSummary,
        total_score: totalScore,
        rating,
        score_detail: scoreDetail,
        strengths: actualStrengths,
        risk_list: actualRisks,
        controversy_points: controversies,
        finance_metrics: financial,
        valuation,
        valuation_level: valuationLevel,
        expert_opinions: allOpinions,
        reflection_notes: reflectionNotes,
        chart_list: [],
        follow_up_indicators: followUpIndicators,
        scenarios: scenarios,
        strategyList: strategyList,
        newsSentiment: newsSignal?.hasNews ? newsSignal : undefined,
        consensus: consensus ?? undefined,
        announcement_brief: announcementBrief ?? undefined,
        knowledgeGraphContext,
        sectorRotation: sectorRotationSignal,
        riskAttribution: {
          exposures: styleExposures,
          decomposition: riskDecomposition,
        },
        mcpContext,
        priceHistory,
        // 专家降级名单（可选；无降级时不出现该字段，保持既有输出契约）
        degraded_experts: degradedExperts.length > 0 ? degradedExperts : undefined,
        // 评级事后校准（可选；无历史评级样本时不出现该字段）
        rating_accuracy: accuracySummary ?? undefined,
      },
    ],
    data_sources: dataSources,
    research_confidence: `基于${expertOpinions.length}位专家独立研判+仲裁综合，整体置信度${Math.round(allOpinions.reduce((s, o) => s + o.confidence, 0) / allOpinions.length)}%。财务数据置信度高（上市公司年报审计），行业判断置信度中等（存在政策不确定性）。`,
    limitation_explain: buildLimitationExplain(expertDegradation),
  };
}
