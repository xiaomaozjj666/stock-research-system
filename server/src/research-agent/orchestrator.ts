/**
 * 多步研究 Agent 编排器
 * ------------------------------------------------------------------
 * 串联四阶段（规划 -> 检索 -> 交叉验证 -> 结论编排），驱动多轮迭代：
 *
 *   第 1 轮: createPlan -> collect -> verify -> 终止门检查
 *   第 n 轮: revisePlan(按暴露的问题动态调整) -> collect(含补充检索) -> verify -> 门检查
 *
 * 终止条件（按优先级）：
 *   1. all_p0_sufficient : 所有 P0 子问题验证充分 —— 提前收敛；
 *   2. no_pending_work   : 无可执行任务（全部充分/受阻/超补充上限）；
 *   3. no_progress       : 连续 N 轮无新增证据 —— 强制收敛防死循环；
 *   4. max_rounds        : 轮次上限 —— 带局限性声明降级交付。
 *
 * 所有中间执行状态通过 AgentEvent 事件流对外输出（可驱动 UI 进度条），
 * 最终产出结构化研究报告 + Markdown 渲染 + 完整审计线索。
 */
import type {
  AgentEvent,
  AgentEventEmitter,
  AgentEventType,
  Evidence,
  ResearchPlan,
  ResearchReport,
  ResearchConfig,
  RunStats,
  ScopeConstraints,
  StopReason,
  Verification,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import type { LLMAdapter } from './llm.js';
import type { SearchAdapter } from './search.js';
import { EvidenceRetriever, type FailedTask } from './retriever.js';
import { ResearchAbortedError } from './utils.js';
import { createPlan, revisePlan, type ReplanProblem } from './planner.js';
import { verifySubQuestion } from './verifier.js';
import { synthesize } from './synthesizer.js';
import { renderReportMarkdown } from './report.js';

/**
 * 续跑状态：上一次运行中断时落盘的中间产物。
 * 只包含「可安全复用」的事实——计划、已抽证据、已验证结论、事件与统计；
 * 不包含检索器的瞬时状态（seenUrls/seenClaims 由 evidence 反推重建）。
 */
export interface ResearchResumeState {
  plan: ResearchPlan;
  evidence: Evidence[];
  verifications: Verification[];
  events: AgentEvent[];
  stats: RunStats;
  /** 已完整结束的轮次：续跑从 roundsCompleted + 1 轮开始 */
  roundsCompleted: number;
  /** 连续无新增证据的轮数（不持久化时缺省 0） */
  consecutiveNoProgress?: number;
  /** 已记录的失败检索任务明细（续跑时并入报告局限性，不丢失） */
  failedTasks?: FailedTask[];
}

/** 轮次边界对外暴露的可持久化快照（shape 与 ResearchResumeState 一致） */
export interface ResearchSnapshot {
  plan: ResearchPlan;
  evidence: Evidence[];
  verifications: Verification[];
  events: AgentEvent[];
  stats: RunStats;
  roundsCompleted: number;
  consecutiveNoProgress: number;
  failedTasks: FailedTask[];
}

export interface OrchestratorDeps {
  llm: LLMAdapter;
  /** 按顺序作为主通道 -> 降级通道 */
  adapters: SearchAdapter[];
  config?: Partial<ResearchConfig>;
  /** 事件旁路（UI/日志），与内部事件流互不影响 */
  onEvent?: (event: AgentEvent) => void;
  /** 退避等待注入点（测试传 no-op） */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 取消信号：SSE 断开 / 前端取消 / 运行超时统一走这里。信号在每轮边界、
   * 每个阶段与每个检索任务入口检查（抛 ResearchAbortedError），并级联到
   * LLM 与检索适配器的在途请求——避免「客户端已走、编排还在白烧配额」。
   */
  signal?: AbortSignal;
  /**
   * 续跑状态：给定后从 roundsCompleted + 1 轮继续，复用计划 / 证据 / 验证，
   * 已完成子问题不再检索与验证（不重复付费）。缺省为一次全新研究。
   */
  resume?: ResearchResumeState;
  /**
   * 断点回调：规划完成后与每轮结束后各调一次（同步，调用方自行决定落盘方式）。
   * 抛错不影响研究本身——断点失败最多是「断了不能续」，不该让研究跟着失败。
   */
  onCheckpoint?: (snapshot: ResearchSnapshot) => void;
}

export interface AgentRunResult {
  report: ResearchReport;
  reportMarkdown: string;
  plan: ResearchPlan;
  evidence: Evidence[];
  verifications: Verification[];
  events: AgentEvent[];
  stats: RunStats;
}

export class ResearchOrchestrator {
  private readonly config: ResearchConfig;
  private readonly events: AgentEvent[] = [];
  private seq = 0;

  constructor(private readonly deps: OrchestratorDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
  }

  async run(question: string, scope: ScopeConstraints = {}): Promise<AgentRunResult> {
    const cfg = this.config;
    const resumed = this.deps.resume;
    const stats: RunStats = resumed
      ? { ...resumed.stats }
      : {
          rounds: 0,
          totalRetrievalTasks: 0,
          succeededTasks: 0,
          failedTasks: 0,
          fallbacksUsed: 0,
          evidenceCount: 0,
          conflictsFound: 0,
          supplementRounds: 0,
          planVersions: 1,
          startedAt: new Date().toISOString(),
        };

    // 续跑：事件流接续上一次的序号与内容（UI 轨迹不出现「从头开始」的错觉）
    if (resumed) {
      this.events.push(...resumed.events);
      this.seq = resumed.events.reduce((max, ev) => Math.max(max, ev.seq), 0);
    }
    // 累计失败 / 降级数跨续跑保留：检索器实例是新的，但用户看到的是同一次研究
    const priorFailedTasks = resumed?.stats.failedTasks ?? 0;
    const priorFallbacks = resumed?.stats.fallbacksUsed ?? 0;
    let completedRounds = resumed?.roundsCompleted ?? 0;
    let consecutiveNoProgress = resumed?.consecutiveNoProgress ?? 0;
    /** 失败检索任务明细（续跑前 + 本次），并入报告局限性 */
    let failedTaskDetails: FailedTask[] = resumed?.failedTasks ? [...resumed.failedTasks] : [];

    let plan: ResearchPlan | null = resumed?.plan ?? null;
    const evidence: Evidence[] = resumed ? [...resumed.evidence] : [];
    // 证据按子问题分桶 + 验证结论表：续跑时直接用断点恢复，不重跑已验证子问题
    const evidenceBySq = new Map<string, Evidence[]>();
    for (const ev of evidence) {
      const bucket = evidenceBySq.get(ev.subQuestionId) ?? [];
      bucket.push(ev);
      evidenceBySq.set(ev.subQuestionId, bucket);
    }
    const verifications = new Map<string, Verification>();
    for (const v of resumed?.verifications ?? []) verifications.set(v.subQuestionId, v);

    const emit: AgentEventEmitter = (type: AgentEventType, message, data) => {
      const event: AgentEvent = {
        seq: ++this.seq,
        type,
        round: stats.rounds,
        at: new Date().toISOString(),
        message,
        data,
      };
      this.events.push(event);
      this.deps.onEvent?.(event);
    };

    const snapshot = (): ResearchSnapshot | null => {
      if (!plan) return null;
      return {
        plan,
        evidence: [...evidence],
        verifications: [...verifications.values()],
        events: [...this.events],
        stats: { ...stats },
        roundsCompleted: completedRounds,
        consecutiveNoProgress,
        failedTasks: [...failedTaskDetails],
      };
    };

    /** 落断点：失败只降级为「不可续跑」，不打断研究 */
    const checkpoint = () => {
      if (!this.deps.onCheckpoint) return;
      const snap = snapshot();
      if (!snap) return;
      try {
        this.deps.onCheckpoint(snap);
      } catch {
        /* 断点旁路，失败不影响研究 */
      }
    };

    const ensureNotAborted = () => {
      if (this.deps.signal?.aborted) throw new ResearchAbortedError();
    };
    ensureNotAborted();

    emit(
      'run_started',
      resumed
        ? `研究任务续跑（已完成 ${completedRounds} 轮）: ${question}`
        : `研究任务启动: ${question}`,
      resumed
        ? { question, scope, resumed: true, resumedFromRound: completedRounds }
        : { question, scope },
    );

    try {
      const llm = this.deps.llm;
      const retriever = new EvidenceRetriever(
        llm,
        this.deps.adapters,
        cfg,
        emit,
        this.deps.sleep,
        this.deps.signal,
        // 续跑：已抓过的 URL / 已入库的陈述直接标记为已见，避免重复抓取与重复抽取
        resumed?.evidence,
      );

      let stopReason: StopReason = 'max_rounds';

      const maxRounds = Math.max(1, cfg.maxRounds);
      // 续跑从下一轮开始；若断点已到轮次上限，循环零次、直接进入结论编排
      const startRound = completedRounds + 1;

      for (let round = startRound; round <= maxRounds; round++) {
        stats.rounds = round;
        ensureNotAborted();

        // ---- 阶段一：规划（仅首轮；后续轮的动态修订在终止门处按需触发） ----
        if (!plan) {
          plan = await createPlan(llm, question, scope, cfg, emit, this.deps.signal);
          // 规划即落一次断点：后续阶段中断时续跑不必再花一次规划调用
          checkpoint();
        }

        // ---- 阶段二：按计划检索 ----
        ensureNotAborted();
        const { evidence: newEvidence, attempted } = await retriever.collect(plan, round);
        for (const ev of newEvidence) {
          evidence.push(ev);
          const bucket = evidenceBySq.get(ev.subQuestionId) ?? [];
          bucket.push(ev);
          evidenceBySq.set(ev.subQuestionId, bucket);
        }
        stats.totalRetrievalTasks += attempted.size;
        // 续跑时检索器是全新实例：累计值 = 断点前累计 + 本次实例累计
        stats.fallbacksUsed = priorFallbacks + retriever.fallbacksUsed;
        stats.failedTasks = priorFailedTasks + retriever.failedTasks.length;
        failedTaskDetails = [...(resumed?.failedTasks ?? []), ...retriever.failedTasks];
        // succeededTasks 此前只初始化不回填（UI 展示恒 0）——按「发起任务数 −
        // 累计失败数」口径回填；failedTasks 为实例累计数组，差值即成功数
        stats.succeededTasks = stats.totalRetrievalTasks - stats.failedTasks;
        const evidenceGrew = newEvidence.length > 0;

        // ---- 阶段三：交叉验证（只验证本轮实际发起过检索的子问题） ----
        // 未发起检索的子问题保持 pending，不产生"幽灵验证"污染报告状态
        let supplementTriggered = 0;
        for (const sq of plan.subQuestions) {
          if (!attempted.has(sq.id)) continue;

          ensureNotAborted();
          const v = await verifySubQuestion(
            llm,
            sq,
            evidenceBySq.get(sq.id) ?? [],
            cfg,
            emit,
            this.deps.signal,
          );
          verifications.set(sq.id, v);

          // 补充检索触发：insufficient（证据不足），或 needsSupplement
          //（未决冲突/置信度低于阈值）且补充预算未耗尽——两类都要消费 hints
          const shouldSupplement =
            v.consistency === 'insufficient' ||
            (v.needsSupplement && sq.supplementRoundsUsed < cfg.maxSupplementRoundsPerSubQuestion);
          if (shouldSupplement) {
            sq.status = 'insufficient';
            // 只有实际消耗过一轮检索才计入补充轮次，防止空转刷次数
            sq.supplementRoundsUsed += 1;
            sq.supplementHints = v.supplementHints;
            if (
              v.needsSupplement &&
              sq.supplementRoundsUsed <= cfg.maxSupplementRoundsPerSubQuestion
            ) {
              supplementTriggered += 1;
            }
          } else {
            sq.status = 'sufficient';
            sq.supplementHints = [];
          }
        }
        stats.supplementRounds += supplementTriggered;
        // 本轮（检索 + 验证）已完整结束：更新已完成轮次并落断点。
        // 断点若落在轮内中断点，续跑从本轮重跑——已完成子问题的验证结论
        // 已在计划状态里，不会重复验证（只补做未完成的那些）。
        completedRounds = round;
        checkpoint();

        // ---- 终止门检查（顺序即优先级） ----
        const p0s = plan.subQuestions.filter((sq) => sq.priority === 'P0');
        if (p0s.length > 0 && p0s.every((sq) => sq.status === 'sufficient')) {
          stopReason = 'all_p0_sufficient';
          break;
        }
        consecutiveNoProgress = evidenceGrew ? 0 : consecutiveNoProgress + 1;
        if (consecutiveNoProgress >= cfg.noProgressRoundLimit) {
          stopReason = 'no_progress';
          break;
        }
        if (round === maxRounds) {
          stopReason = 'max_rounds';
          break;
        }
        const pendingWork = plan.subQuestions.some(
          (sq) =>
            sq.status === 'pending' ||
            (sq.status === 'insufficient' &&
              sq.supplementRoundsUsed < cfg.maxSupplementRoundsPerSubQuestion),
        );
        if (!pendingWork) {
          // 无待办任务：先尝试 replan 复活（调整关键词/换路径重置预算），
          // 复活失败才终止——保证"计划动态调整"有机会在受阻后生效
          const problems = this.collectProblems(retriever, plan, verifications);
          let revived = false;
          if (problems.length > 0) {
            ensureNotAborted();
            const revised = await revisePlan(
              llm,
              plan,
              problems,
              round,
              cfg,
              emit,
              this.deps.signal,
            );
            if (revised) {
              stats.planVersions = revised.version;
              revived = true;
            }
          }
          if (!revived) {
            stopReason = 'no_pending_work';
            break;
          }
        }
      }

      // ---- 阶段四：结论编排 ----
      // maxRounds >= 1 保证首轮必然 createPlan，此处 plan 必非空
      const settledPlan = plan!;
      ensureNotAborted();
      const report = await synthesize(
        llm,
        settledPlan,
        verifications,
        evidence,
        failedTaskDetails,
        cfg,
        emit,
        this.deps.signal,
      );
      report.methodology.rounds = stats.rounds;
      stats.evidenceCount = evidence.length;
      stats.conflictsFound = report.conflicts.length;
      stats.stopReason = stopReason;
      stats.finishedAt = new Date().toISOString();

      emit(
        'run_finished',
        `研究任务完成: ${stopReason}（${stats.rounds} 轮 / ${evidence.length} 条证据）`,
        {
          stopReason,
          rounds: stats.rounds,
          evidenceCount: evidence.length,
          planVersions: stats.planVersions,
        },
      );

      return {
        report,
        reportMarkdown: renderReportMarkdown(report),
        plan: settledPlan,
        evidence,
        verifications: [...verifications.values()],
        events: [...this.events],
        stats,
      };
    } catch (err) {
      emit('run_error', `研究任务异常终止: ${(err as Error).message}`, {
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * 汇总 replan 输入：检索失败 + 提示式补充检索已试过仍未解决的子问题。
   * 阈值取 min(2, maxSupplementRounds)：首轮 hints 尚未消费不触发，
   * 至少消费过一轮补充方向仍不足才升级为计划修订。
   */
  private collectProblems(
    retriever: EvidenceRetriever,
    plan: ResearchPlan,
    verifications: Map<string, Verification>,
  ): ReplanProblem[] {
    const problems: ReplanProblem[] = [];
    const seen = new Set<string>();
    const threshold = Math.min(2, this.config.maxSupplementRoundsPerSubQuestion);

    for (const task of retriever.failedTasks) {
      if (seen.has(task.subQuestionId)) continue;
      seen.add(task.subQuestionId);
      problems.push({
        kind: 'retrieval_failed',
        subQuestionId: task.subQuestionId,
        detail: task.detail,
      });
    }
    for (const sq of plan.subQuestions) {
      if (seen.has(sq.id)) continue;
      const v = verifications.get(sq.id);
      if (
        sq.status === 'insufficient' &&
        sq.supplementRoundsUsed >= threshold &&
        v?.needsSupplement === true
      ) {
        problems.push({
          kind: 'persistently_insufficient',
          subQuestionId: sq.id,
          detail: `已按补充方向检索 ${sq.supplementRoundsUsed} 轮仍证据不足: ${v.verdict}`,
        });
      }
    }
    return problems;
  }
}
