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
import { isLLMAvailable, getLLMConfig, chat, chatWithTools, type ChatMessage } from '../llm/index.js';
import { retrieveEvidence, type EvidenceDoc } from '../llm/rag.js';
import { TOOL_DEFINITIONS, executeToolCall, type ToolDeps } from '../llm/tools.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAgentRequest {
  message: string;
  history?: ChatTurn[];
  stockCode?: string;
}

export interface DebateResult {
  bull: string;
  bear: string;
  synthesis: string;
}

export interface ChatAgentResponse {
  answer: string;
  toolsUsed: string[];
  evidence: EvidenceDoc[];
  debate?: DebateResult;
  /** true = LLM 未配置，走规则降级 */
  degraded: boolean;
  model?: string;
}

export interface ChatAgentDeps {
  runAnalysis: (code: string) => Promise<unknown>;
  runBacktest: (cfg: unknown) => Promise<unknown>;
  parseStrategyInput: (input: unknown) => { stockCode: string; startDate?: string; endDate?: string; [k: string]: unknown };
  fetchOHLCVData: (code: string, start: string, end: string) => Promise<unknown[]>;
  retrieveEvidence: (q: string, opts?: { topK?: number; stockCode?: string }) => EvidenceDoc[];
  isLLMAvailable: () => boolean;
  chat: (msgs: ChatMessage[], opts?: Record<string, unknown>) => Promise<string>;
  chatWithTools: (
    msgs: ChatMessage[],
    tools: unknown[],
    exec: (name: string, args: Record<string, unknown>) => Promise<string>,
    opts?: Record<string, unknown>,
  ) => Promise<{ content: string; toolCalls: { name: string; args: Record<string, unknown> }[] }>;
  runDebate?: (analysisText: string) => Promise<DebateResult>;
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

  async function run(req: ChatAgentRequest): Promise<ChatAgentResponse> {
    const evidence = deps.retrieveEvidence(
      req.message,
      req.stockCode ? { stockCode: req.stockCode } : {},
    );
    const evidenceText = evidence.map((e) => `[${e.source}] ${e.text}`).join('\n').slice(0, 3000);

    if (!deps.isLLMAvailable()) {
      return runFallback(req, deps, evidence);
    }

    const system = buildSystemPrompt(evidenceText);
    const messages: ChatMessage[] = [{ role: 'system', content: system }];
    for (const h of req.history ?? []) messages.push({ role: h.role, content: h.content });
    messages.push({ role: 'user', content: req.message });

    const toolDeps: ToolDeps = {
      runAnalysis: deps.runAnalysis,
      runBacktest: deps.runBacktest,
      parseStrategyInput: deps.parseStrategyInput,
      fetchOHLCVData: deps.fetchOHLCVData,
    };

    const { content, toolCalls } = await deps.chatWithTools(
      messages,
      TOOL_DEFINITIONS,
      (name, args) =>
        executeToolCall({ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, toolDeps),
      { temperature: 0.3, maxTokens: 2000, timeout: 60000 },
    );

    // 多空辩论（用户显式要求时）
    let debate: DebateResult | undefined;
    if (/辩论|多空|看多还是看空|bull|bear|debat/i.test(req.message)) {
      try {
        debate = await runDebate(content || evidenceText);
      } catch {
        // 辩论失败不影响主回答
      }
    }

    return {
      answer: content,
      toolsUsed: toolCalls.map((t) => t.name),
      evidence,
      debate,
      degraded: false,
      model: getLLMConfig().model,
    };
  }

  return { run };
}

// === 生产默认依赖（真实服务；仅在请求时拉起，避免测试期副作用） ===
import { runAnalysis } from './analysisPipeline.js';
import { runBacktest } from '../quant/backtestEngine.js';
import { parseStrategyInput } from '../quant/agents/orchestrator.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';

const productionDeps: ChatAgentDeps = {
  runAnalysis,
  runBacktest,
  parseStrategyInput,
  fetchOHLCVData,
  retrieveEvidence,
  isLLMAvailable,
  chat,
  chatWithTools,
};

/** 默认导出生产用 Chat Agent 实例 */
export const chatAgent = createChatAgent(productionDeps);
