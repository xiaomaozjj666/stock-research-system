/**
 * Chat Agent 编排器
 * ----------------------------------------------------------------------------
 * 把系统从"表单管道"升级为"对话式智能体"的核心。能力：
 *  - 自然语言入口：自由文本 → 意图识别 → 规划/路由到现有服务或工具；
 *  - 工具调用（function-calling）：run_analysis / compare_stocks / run_backtest；
 *  - 轻量 RAG：把本地缓存证据注入 prompt，降低幻觉；
 *  - 多空辩论（可选）：用户要求"辩论/多空"时，调用看涨/看跌研究员 + 首席合成；
 *  - 规则降级：LLM 未配置时，仍可解析股票代码给出规则摘要，绝不崩溃。
 *
 * 所有外部依赖通过 deps 注入，便于单测 mock；生产默认 deps 在文件底部组装。
 */
import { isLLMAvailable, getLLMConfig, chat, chatWithTools, chatJSON, embed, type ChatMessage } from '../llm/index.js';
import { retrieveEvidence, type EvidenceDoc, type Embedder } from '../llm/rag.js';
import { TOOL_DEFINITIONS, executeToolCall, type ToolDeps } from '../llm/tools.js';
import { loadHistory, appendTurn } from './chatMemory.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAgentRequest {
  message: string;
  history?: ChatTurn[];
  stockCode?: string;
  /** 会话 ID；提供后自动加载并持久化历史（跨重启记忆） */
  sessionId?: string;
}

export interface DebateResult {
  bull: string;
  bear: string;
  synthesis: string;
}

/** 风控团队三分视角辩论结果（激进/中性/保守 + 综合） */
export interface RiskDebateResult {
  aggressive: string;
  neutral: string;
  conservative: string;
  synthesis: string;
}

/** 路由规划结果：决定走哪条执行路径（主流 agent 的 planner/router 能力） */
export interface AgentPlan {
  /** direct=直接对话(闲聊/概念), tools=工具调用(分析/回测/对比), debate=多空辩论 */
  action: 'direct' | 'tools' | 'debate';
  /** 规划理由（供前端展示与可观测） */
  reason: string;
}

/** 计算型错误（FinGround 研究：43% 的计算错误被通用检测器漏检） */
export interface CalculationError {
  /** 回答中的原始断言文本 */
  claim: string;
  /** 核查员重构的算术公式（如 "净利增速 = (本期净利 - 上期净利) / |上期净利|"） */
  reconstructedFormula: string;
  /** 核查员按公式重算的结果 */
  recomputedValue: string;
  /** 回答中给出的数值（与重算不一致时即为错误） */
  claimedValue: string;
  /** 错误说明 */
  discrepancy: string;
}

/** 幻觉防护校验结果：标注回答中无法在工具结果/证据里找到对应的断言 */
export interface AnswerVerification {
  /** true=所有关键断言可验证，false=存在无法验证的断言 */
  verified: boolean;
  /** 无法验证的断言列表（空表示全部可验证） */
  unverified: string[];
  /** 计算型错误列表（数值能找到来源但算术重构后不一致） */
  calculationErrors: CalculationError[];
  /** 给用户的警示文案（无问题时为空） */
  warning: string;
}

export interface ChatAgentResponse {
  answer: string;
  toolsUsed: string[];
  evidence: EvidenceDoc[];
  debate?: DebateResult;
  /** 风控三分视角辩论结果（debate 路径或风控关键词命中时返回） */
  riskDebate?: RiskDebateResult;
  /** 路由规划结果（LLM 可用时返回） */
  plan?: AgentPlan;
  /** 幻觉防护校验结果（use_tools 路径且有工具结果时返回） */
  verification?: AnswerVerification;
  /** true = LLM 未配置，走规则降级 */
  degraded: boolean;
  model?: string;
}

/** 流式阶段事件（真流式：把执行进度逐阶段推给前端，不再跑完才回） */
export type ChatStreamEvent =
  | { phase: 'planning'; message: string }
  | { phase: 'retrieving'; message: string }
  | { phase: 'tool_calling'; message: string; tools?: string[] }
  | { phase: 'debating'; message: string }
  | { phase: 'risk_debating'; message: string }
  | { phase: 'verifying'; message: string }
  | { phase: 'done'; message: string; response: ChatAgentResponse }
  | { phase: 'error'; message: string };

export interface ChatAgentDeps {
  runAnalysis: (code: string) => Promise<unknown>;
  runBacktest: (ohlcv: unknown, strategy: unknown) => Promise<unknown>;
  parseStrategyInput: (input: unknown) => { stockCode: string; startDate?: string; endDate?: string; [k: string]: unknown };
  fetchOHLCVData: (code: string, start: string, end: string) => Promise<unknown[]>;
  retrieveEvidence: (q: string, opts?: { topK?: number; stockCode?: string; embedder?: Embedder }) => Promise<EvidenceDoc[]>;
  /** 嵌入函数（语义检索用）；不提供则 RAG 回退 BM25 */
  embedder?: Embedder;
  /** 加载历史（持久记忆）；不提供则不使用持久记忆 */
  loadHistory?: (sessionId: string) => ChatTurn[];
  /** 持久化一轮（持久记忆）；不提供则不持久化 */
  appendTurn?: (sessionId: string, turn: ChatTurn) => void;
  isLLMAvailable: () => boolean;
  chat: (msgs: ChatMessage[], opts?: Record<string, unknown>) => Promise<string>;
  chatWithTools: (
    msgs: ChatMessage[],
    tools: unknown[],
    exec: (name: string, args: Record<string, unknown>) => Promise<string>,
    opts?: Record<string, unknown>,
  ) => Promise<{ content: string; toolCalls: { name: string; args: Record<string, unknown> }[] }>;
  /** 结构化 JSON 调用（用于路由规划与幻觉防护）；不提供则降级为默认路径 */
  chatJSON?: (msgs: ChatMessage[], opts?: Record<string, unknown>) => Promise<unknown>;
  /** 提取新闻情绪信号（受控回测评估工具用）；不提供则 evaluate_backtest 退化为无叠加 */
  extractNewsSignal?: (code: string) => Promise<{ signal: { polarity: number; hasNews: boolean }; source: string }>;
  runDebate?: (analysisText: string) => Promise<DebateResult>;
  /** 风控三分视角辩论（激进/中性/保守）；不提供时用默认实现 */
  runRiskDebate?: (analysisText: string) => Promise<RiskDebateResult>;
}

function buildSystemPrompt(evidenceText: string): string {
  return [
    '你是一个严谨的 A 股研究助手。请遵守：',
    '1) 只基于「可用证据」与「工具返回的真实数据」作答，不得编造未提供的数据或历史收益；',
    '2) 任何涉及涨跌/收益的判断必须标注「推演，存在不确定性」，不构成投资建议；',
    '3) 优先调用工具获取真实数据，再综合给出结论；',
    '4) 用简体中文、结构清晰地回答。',
    '',
    '【可用证据（来自本地缓存，仅供参考，可能非最新）】',
    evidenceText || '（无）',
  ].join('\n');
}

function defaultDebate(deps: ChatAgentDeps): (text: string) => Promise<DebateResult> {
  return async (analysisText: string) => {
    const bull = await deps.chat([
      { role: 'system', content: '你是看多研究员：基于下列分析给出 3-5 条买入理由，激进但须有依据，禁止编造数据。' },
      { role: 'user', content: analysisText },
    ], { temperature: 0.5, maxTokens: 800, timeout: 40000 });
    const bear = await deps.chat([
      { role: 'system', content: '你是看空研究员：基于下列分析给出 3-5 条风险/卖出理由，严谨克制。' },
      { role: 'user', content: analysisText },
    ], { temperature: 0.5, maxTokens: 800, timeout: 40000 });
    const synthesis = await deps.chat([
      { role: 'system', content: '你是首席：综合多空双方，给出平衡结论、关键分歧与置信度（高/中/低）。' },
      { role: 'user', content: `【看多】\n${bull}\n\n【看空】\n${bear}` },
    ], { temperature: 0.3, maxTokens: 800, timeout: 40000 });
    return { bull, bear, synthesis };
  };
}

/** 默认风控三分视角辩论：激进/中性/保守三方各自给出风控视角，首席综合 */
function defaultRiskDebate(deps: ChatAgentDeps): (text: string) => Promise<RiskDebateResult> {
  return async (analysisText: string) => {
    const aggressive = await deps.chat([
      { role: 'system', content: '你是激进风控经理：关注机会成本与上行空间，认为过度风控本身也是一种风险。基于下列分析给出 3-4 条激进风控建议（如提高仓位上限、放宽止损、利用波动），须有依据，禁止编造数据。' },
      { role: 'user', content: analysisText },
    ], { temperature: 0.5, maxTokens: 600, timeout: 40000 });
    const neutral = await deps.chat([
      { role: 'system', content: '你是中性风控经理：以数据为准，平衡风险与收益，关注风险调整后收益（夏普/索提诺）。基于下列分析给出 3-4 条中性风控建议（如仓位动态调整、分批建仓、设置最大回撤阈值），须有依据。' },
      { role: 'user', content: analysisText },
    ], { temperature: 0.4, maxTokens: 600, timeout: 40000 });
    const conservative = await deps.chat([
      { role: 'system', content: '你是保守风控经理：以本金安全为第一优先级，关注尾部风险与最大回撤，宁可错过也不可做错。基于下列分析给出 3-4 条保守风控建议（如严格止损、降低仓位、对冲尾部风险），须有依据。' },
      { role: 'user', content: analysisText },
    ], { temperature: 0.3, maxTokens: 600, timeout: 40000 });
    const synthesis = await deps.chat([
      { role: 'system', content: '你是首席风控官：综合激进/中性/保守三方意见，给出统一风控决策建议，包含：建议仓位区间、止损/止盈参考、关键风险监控指标、三方分歧点。' },
      { role: 'user', content: `【激进】\n${aggressive}\n\n【中性】\n${neutral}\n\n【保守】\n${conservative}` },
    ], { temperature: 0.3, maxTokens: 800, timeout: 40000 });
    return { aggressive, neutral, conservative, synthesis };
  };
}

async function runFallback(
  req: ChatAgentRequest,
  deps: ChatAgentDeps,
  evidence: EvidenceDoc[],
): Promise<ChatAgentResponse> {
  const m = req.message.match(/\b(\d{6})\b/);
  if (m) {
    try {
      const r = await deps.runAnalysis(m[1]) as { stock_pool?: { stock_name?: string; total_score?: number; rating?: string; valuation?: { currentPrice?: number; pe?: number }; risk_list?: string[] }[] };
      const s = r?.stock_pool?.[0];
      if (s) {
        const lines = [
          `【${s.stock_name || m[1]}（${m[1]}）】规则引擎摘要（LLM 未配置，已降级）`,
          `综合评分：${s.total_score ?? '—'} / 评级：${s.rating ?? '—'}`,
          `当前价：¥${s.valuation?.currentPrice ?? '—'}，PE ${s.valuation?.pe ?? '—'}`,
          `风险提示：${(s.risk_list || []).slice(0, 3).join('；') || '—'}`,
          '（配置 DEEPSEEK_API_KEY 后可获得自然语言深度解读、多空辩论与工具调用能力。）',
        ];
        return { answer: lines.join('\n'), toolsUsed: ['run_analysis'], evidence, degraded: true };
      }
    } catch {
      // 落到通用帮助
    }
  }
  return {
    answer: [
      '当前为离线模式（未配置 LLM API Key）。我可以：',
      '1) 输入 6 位股票代码，获取规则引擎评分摘要；',
      '2) 配置 DEEPSEEK_API_KEY 后，支持自然语言问答、多空辩论、回测/对比工具调用。',
    ].join('\n'),
    toolsUsed: [],
    evidence,
    degraded: true,
  };
}

export function createChatAgent(deps: ChatAgentDeps) {
  const runDebate = deps.runDebate ?? defaultDebate(deps);
  const runRiskDebate = deps.runRiskDebate ?? defaultRiskDebate(deps);

  /**
   * 路由规划（planner/router）：用一次轻量 LLM 调用判断意图，决定执行路径。
   * - direct：闲聊/概念解释，直接 chat，省去工具回路开销；
   * - tools：涉及个股/分析/回测/对比，走 chatWithTools；
   * - debate：用户显式要求多空辩论。
   * chatJSON 不可用或解析失败时，安全降级为 tools（保留原行为）。
   */
  async function planIntent(message: string): Promise<AgentPlan> {
    // 显式辩论关键词快速命中，省一次 LLM 调用
    if (/辩论|多空|看多还是看空|bull.*bear|bear.*bull|debat/i.test(message)) {
      return { action: 'debate', reason: '用户显式要求多空辩论' };
    }
    if (!deps.chatJSON) {
      return { action: 'tools', reason: '规划器未配置，默认走工具调用路径' };
    }
    try {
      const raw = await deps.chatJSON(
        [
          {
            role: 'system',
            content:
              '你是意图路由器。判断用户问题应走哪条路径：' +
              'direct=闲聊/概念/问候/无需数据；tools=需要分析个股/回测/对比/查数据；debate=要求多空辩论。' +
              '只返回 JSON：{"action":"direct"|"tools"|"debate","reason":"简短理由"}',
          },
          { role: 'user', content: message.slice(0, 500) },
        ],
        { temperature: 0, maxTokens: 200, timeout: 15000, task: 'chat' },
      ) as { action?: string; reason?: string };
      const valid = ['direct', 'tools', 'debate'] as const;
      const action = valid.includes(raw.action as (typeof valid)[number])
        ? (raw.action as (typeof valid)[number])
        : 'tools';
      return { action, reason: String(raw.reason || '').slice(0, 120) || `路由至 ${action}` };
    } catch {
      return { action: 'tools', reason: '规划器异常，降级为工具调用路径' };
    }
  }

  /**
   * 幻觉防护（证据交叉验证 + 计算型声明算术重构校验）：
   * 给定回答、工具结果摘要、证据文本，让 LLM 做两层校验——
   * 1) 事实层：回答中哪些关键断言无法在证据/工具结果里找到对应；
   * 2) 计算层（FinGround 研究：43% 计算错误被通用检测器漏检）：
   *    对于回答中涉及「增长率/比率/估值/汇总」等可由原始数据推导的数值断言，
   *    核查员需重构算术公式并用证据中的原始数据重算，比对是否一致。
   * 仅在有工具结果或证据时执行；chatJSON 不可用时跳过（返回 null）。
   */
  async function verifyClaims(
    answer: string,
    toolCalls: { name: string; args: Record<string, unknown> }[],
    evidence: EvidenceDoc[],
  ): Promise<AnswerVerification | null> {
    if (!deps.chatJSON) return null;
    if (!answer.trim()) return null;
    if (toolCalls.length === 0 && evidence.length === 0) return null;
    const evidenceText = evidence.map((e) => `[${e.source}] ${e.text.slice(0, 400)}`).join('\n').slice(0, 2000);
    const toolsText = toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(', ');
    try {
      const raw = await deps.chatJSON(
        [
          {
            role: 'system',
            content:
              '你是金融事实核查员。给定「助手回答」与「可用证据+工具调用」，执行两层校验：\n' +
              '第一层·事实核对：找出回答中无法在证据/工具结果里找到对应的关键断言（数值、事件、结论）。\n' +
              '第二层·计算重构（关键）：对于回答中涉及增长率/比率/估值/汇总等可由原始数据推导的数值断言，' +
              '你必须从证据中提取原始数据，重构算术公式并重算，比对回答中的数值是否正确。' +
              '例如：回答称"营收增长30%"，你需从证据找到本期与上期营收，按 (本期-上期)/|上期| 重算，' +
              '若重算结果与30%不一致则记为 calculationErrors。合理的四舍五入误差（±1个百分点）不算错误。\n' +
              '只返回 JSON：{"verified":true|false,"unverified":["断言1",...],' +
              '"calculationErrors":[{"claim":"原文断言","reconstructedFormula":"重构公式","recomputedValue":"重算结果","claimedValue":"回答中数值","discrepancy":"差异说明"}],' +
              '"warning":"给用户的警示，无问题时为空"}。\n' +
              '注意：合理的推理（非具体数据）不算未验证；仅标注具体可核查的事实断言。',
          },
          {
            role: 'user',
            content:
              `【助手回答】\n${answer.slice(0, 2000)}\n\n` +
              `【工具调用】\n${toolsText || '（无）'}\n\n` +
              `【可用证据】\n${evidenceText || '（无）'}`,
          },
        ],
        { temperature: 0, maxTokens: 600, timeout: 25000, task: 'reasoning' },
      ) as { verified?: boolean; unverified?: unknown; calculationErrors?: unknown; warning?: unknown };
      const unverified = Array.isArray(raw.unverified)
        ? raw.unverified.map((u) => String(u)).filter((s) => s.length > 0).slice(0, 6)
        : [];
      const calcErrors: CalculationError[] = Array.isArray(raw.calculationErrors)
        ? (raw.calculationErrors as Record<string, unknown>[])
            .map((e) => ({
              claim: String(e?.claim ?? '').slice(0, 200),
              reconstructedFormula: String(e?.reconstructedFormula ?? '').slice(0, 200),
              recomputedValue: String(e?.recomputedValue ?? '').slice(0, 100),
              claimedValue: String(e?.claimedValue ?? '').slice(0, 100),
              discrepancy: String(e?.discrepancy ?? '').slice(0, 200),
            }))
            .filter((e) => e.claim && e.reconstructedFormula)
            .slice(0, 4)
        : [];
      const verified = raw.verified !== false && unverified.length === 0 && calcErrors.length === 0;
      const warning = typeof raw.warning === 'string' ? raw.warning.slice(0, 300) : '';
      const parts: string[] = [];
      if (unverified.length > 0) parts.push(`${unverified.length} 条无法核验的断言`);
      if (calcErrors.length > 0) parts.push(`${calcErrors.length} 处计算错误`);
      return {
        verified,
        unverified,
        calculationErrors: calcErrors,
        warning: verified ? '' : (warning || `回答中存在${parts.join('、')}，请注意甄别`),
      };
    } catch {
      return null; // 核查失败不阻断回答
    }
  }

  async function run(req: ChatAgentRequest): Promise<ChatAgentResponse> {
    return runStream(req, undefined);
  }

  /**
   * 流式执行：onEvent 逐阶段推送进度（真流式，替代"跑完才回"）。
   * onEvent 为空时等同于 run（供 POST /api/chat 非流式调用）。
   */
  async function runStream(req: ChatAgentRequest, onEvent?: (e: ChatStreamEvent) => void): Promise<ChatAgentResponse> {
    const emit = onEvent ?? (() => {});
    try {
      emit({ phase: 'retrieving', message: '正在检索相关证据…' });
      const evidence = await deps.retrieveEvidence(
        req.message,
        req.stockCode
          ? { stockCode: req.stockCode, embedder: deps.embedder }
          : { embedder: deps.embedder },
      );
      const evidenceText = evidence.map((e) => `[${e.source}] ${e.text}`).join('\n').slice(0, 3000);

      // 历史：优先用请求内联 history，否则从持久记忆加载
      const history = req.history ?? (req.sessionId && deps.loadHistory ? deps.loadHistory(req.sessionId) : []);

      if (!deps.isLLMAvailable()) {
        const resp = await runFallback(req, deps, evidence);
        persist(req, resp.answer);
        emit({ phase: 'done', message: '离线降级完成', response: resp });
        return resp;
      }

      // === 路由规划 ===
      emit({ phase: 'planning', message: '正在规划执行路径…' });
      const plan = await planIntent(req.message);

      const system = buildSystemPrompt(evidenceText);
      const messages: ChatMessage[] = [{ role: 'system', content: system }];
      for (const h of history) messages.push({ role: h.role, content: h.content });
      messages.push({ role: 'user', content: req.message });

      const toolDeps: ToolDeps = {
        runAnalysis: deps.runAnalysis,
        runBacktest: deps.runBacktest,
        parseStrategyInput: deps.parseStrategyInput,
        fetchOHLCVData: deps.fetchOHLCVData,
        extractNewsSignal: deps.extractNewsSignal,
      };

      let content: string;
      let toolCalls: { name: string; args: Record<string, unknown> }[] = [];
      let verification: AnswerVerification | undefined;
      let debate: DebateResult | undefined;
      let riskDebate: RiskDebateResult | undefined;

      // 风控关键词命中：用户显式要求风控/仓位/止损建议时触发三分视角辩论
      const riskKeyword = /风控|风险|仓位|止损|回撤|加仓|减仓|资金管理|risk/i.test(req.message);

      if (plan.action === 'direct') {
        // 闲聊/概念：直接 chat，不走工具回路，省开销
        content = await deps.chat(messages, { temperature: 0.4, maxTokens: 1500, timeout: 45000, task: 'chat' });
      } else {
        // tools / debate：先走工具回路拿真实数据
        emit({ phase: 'tool_calling', message: '正在调用工具获取数据…' });
        const result = await deps.chatWithTools(
          messages,
          TOOL_DEFINITIONS,
          (name, args) =>
            executeToolCall({ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, toolDeps),
          { temperature: 0.3, maxTokens: 2000, timeout: 60000, task: 'analysis' },
        );
        content = result.content;
        toolCalls = result.toolCalls;

        // 幻觉防护：有工具结果/证据时校验回答中的事实断言（含计算型声明算术重构）
        if (content.trim()) {
          emit({ phase: 'verifying', message: '正在交叉验证回答中的事实与计算…' });
          const v = await verifyClaims(content, toolCalls, evidence);
          if (v) verification = v;
        }

        // 多空辩论（debate 路径，或显式关键词命中）
        if (plan.action === 'debate') {
          emit({ phase: 'debating', message: '正在进行多空辩论…' });
          try {
            debate = await runDebate(content || evidenceText);
          } catch {
            // 辩论失败不影响主回答
          }
        }

        // 风控三分视角辩论：debate 路径或风控关键词命中时触发
        if (plan.action === 'debate' || riskKeyword) {
          emit({ phase: 'risk_debating', message: '正在进行风控三分视角辩论…' });
          try {
            riskDebate = await runRiskDebate(content || evidenceText);
          } catch {
            // 风控辩论失败不影响主回答
          }
        }
      }

      const resp: ChatAgentResponse = {
        answer: content,
        toolsUsed: toolCalls.map((t) => t.name),
        evidence,
        debate,
        riskDebate,
        plan,
        verification,
        degraded: false,
        model: getLLMConfig().model,
      };
      persist(req, content);
      emit({ phase: 'done', message: '完成', response: resp });
      return resp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '对话处理失败';
      emit({ phase: 'error', message: msg });
      throw err;
    }
  }

  /** 持久化一轮对话（仅当配置了 sessionId + appendTurn） */
  function persist(req: ChatAgentRequest, answer: string): void {
    if (req.sessionId && deps.appendTurn && answer) {
      deps.appendTurn(req.sessionId, { role: 'user', content: req.message });
      deps.appendTurn(req.sessionId, { role: 'assistant', content: answer });
    }
  }

  return { run, runStream };
}

// === 生产默认依赖（真实服务；仅在请求时拉起，避免测试期副作用） ===
import { runAnalysis } from './analysisPipeline.js';
import { runBacktest } from '../quant/backtestEngine.js';
import { parseStrategyInput } from '../quant/agents/orchestrator.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import { extractNewsSignal } from '../quant/newsSignal.js';

const productionDeps: ChatAgentDeps = {
  runAnalysis,
  // 真实服务签名更严格（runBacktest(data, strategy)、parseStrategyInput(string|StrategyConfig)），
  // 在依赖注入边界统一为 unknown 化的抽象契约；运行时 executeToolCall 会以 (ohlcv, cfg) 调用。
  runBacktest: runBacktest as unknown as ChatAgentDeps['runBacktest'],
  parseStrategyInput: parseStrategyInput as unknown as ChatAgentDeps['parseStrategyInput'],
  fetchOHLCVData,
  extractNewsSignal,
  retrieveEvidence,
  embedder: embed,
  loadHistory,
  appendTurn,
  isLLMAvailable,
  chat,
  chatWithTools,
  chatJSON,
};

/** 默认导出生产用 Chat Agent 实例 */
export const chatAgent = createChatAgent(productionDeps);
