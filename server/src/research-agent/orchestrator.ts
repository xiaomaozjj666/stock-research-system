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
import { EvidenceRetriever } from './retriever.js';
import { createPlan, revisePlan, type ReplanProblem } from './planner.js';
import { verifySubQuestion } from './verifier.js';
import { synthesize } from './synthesizer.js';
import { renderReportMarkdown } from './report.js';

export interface OrchestratorDeps {
  llm: LLMAdapter;
  /** 按顺序作为主通道 -> 降级通道 */
  adapters: SearchAdapter[];
  config?: Partial<ResearchConfig>;
  /** 事件旁路（UI/日志），与内部事件流互不影响 */
  onEvent?: (event: AgentEvent) => void;
  /** 退避等待注入点（测试传 no-op） */
  sleep?: (ms: number) => Promise<void>;
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
    const stats: RunStats = {
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

    emit('run_started', `研究任务启动: ${question}`, { question, scope });

    try {
      const llm = this.deps.llm;
      const retriever = new EvidenceRetriever(llm, this.deps.adapters, cfg, emit, this.deps.sleep);

      let plan: ResearchPlan | null = null;
      const evidence: Evidence[] = [];
      const evidenceBySq = new Map<string, Evidence[]>();
      const verifications = new Map<string, Verification>();
      let consecutiveNoProgress = 0;
      let stopReason: StopReason = 'max_rounds';

      const maxRounds = Math.max(1, cfg.maxRounds);

      for (let round = 1; round <= maxRounds; round++) {
        stats.rounds = round;

        // ---- 阶段一：规划（仅首轮；后续轮的动态修订在终止门处按需触发） ----
        if (!plan) {
          plan = await createPlan(llm, question, scope, cfg, emit);
        }

        // ---- 阶段二：按计划检索 ----
        const { evidence: newEvidence, attempted } = await retriever.collect(plan, round);
        for (const ev of newEvidence) {
          evidence.push(ev);
          const bucket = evidenceBySq.get(ev.subQuestionId) ?? [];
          bucket.push(ev);
          evidenceBySq.set(ev.subQuestionId, bucket);
        }
        stats.totalRetrievalTasks += attempted.size;
        stats.fallbacksUsed = retriever.fallbacksUsed;
        stats.failedTasks = retriever.failedTasks.length;
        const evidenceGrew = newEvidence.length > 0;

        // ---- 阶段三：交叉验证（只验证本轮实际发起过检索的子问题） ----
        // 未发起检索的子问题保持 pending，不产生"幽灵验证"污染报告状态
        let supplementTriggered = 0;
        for (const sq of plan.subQuestions) {
          if (!attempted.has(sq.id)) continue;

          const v = await verifySubQuestion(llm, sq, evidenceBySq.get(sq.id) ?? [], cfg, emit);
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
            const revised = await revisePlan(llm, plan, problems, round, cfg, emit);
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
      const report = await synthesize(
        llm,
        settledPlan,
        verifications,
        evidence,
        retriever.failedTasks,
        cfg,
        emit,
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
