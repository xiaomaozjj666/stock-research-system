/**
 * 工具注册表（Tool Registry）
 * ----------------------------------------------------------------------------
 * 供 Chat Agent 做 function-calling 使用。每个工具声明 OpenAI 兼容的 JSON Schema，
 * 并由 executeToolCall 在运行时调用真实业务服务（通过 deps 注入，便于单测 mock）。
 *
 * 设计原则：
 * - tools.ts 本身不 import 任何重型业务模块，避免在测试/无 LLM 场景下拉起网络与文件系统；
 * - 工具执行错误被吞掉并返回字符串，让 LLM 有机会自我纠正，而非让整个对话崩溃。
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 工具执行依赖（生产环境注入真实服务，单测注入 mock） */
export interface ToolDeps {
  runAnalysis?: (code: string) => Promise<unknown>;
  runBacktest?: (ohlcv: unknown, strategy: unknown) => Promise<unknown>;
  parseStrategyInput?: (input: unknown) => {
    stockCode: string;
    startDate?: string;
    endDate?: string;
    [k: string]: unknown;
  };
  fetchOHLCVData?: (code: string, start: string, end: string) => Promise<unknown[]>;
  /** 提取新闻情绪信号（受控评估用：实验组叠加 newsOverlay） */
  extractNewsSignal?: (code: string) => Promise<{
    signal: {
      polarity: number;
      hasNews: boolean;
      /** 带发布日期的原始新闻：用于计算 newsOverlay.since（防前视偏差） */
      items?: Array<{ publishedAt?: string }>;
    };
    source: string;
  }>;
}

function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + '\n…(已截断)' : s;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'run_analysis',
      description:
        '对单只 A 股做深度研究分析（财务/估值/专家观点/情景/评分/量化策略）。输入 6 位股票代码。',
      parameters: {
        type: 'object',
        properties: {
          stockCode: { type: 'string', description: '6 位股票代码，如 600519' },
        },
        required: ['stockCode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_stocks',
      description: '同时分析 2-3 只股票并对比。输入股票代码数组。',
      parameters: {
        type: 'object',
        properties: {
          stockCodes: {
            type: 'array',
            items: { type: 'string' },
            description: '2-3 个 6 位股票代码',
          },
        },
        required: ['stockCodes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_backtest',
      description: '对某股票某策略做历史回测（含成本与新闻叠加）。输入股票代码、策略名、起止日期。',
      parameters: {
        type: 'object',
        properties: {
          stockCode: { type: 'string', description: '6 位股票代码' },
          strategy: {
            type: 'string',
            description: '策略名，如 ma_cross / momentum / mean_reversion',
          },
          startDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          endDate: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        },
        required: ['stockCode', 'strategy'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate_backtest',
      description:
        '受控回测评估：对同一股票同一区间跑两轮回测——基线(无新闻叠加) vs 实验(带新闻情绪叠加)，量化 LLM 信号是否真增 alpha，给出统计显著性结论。',
      parameters: {
        type: 'object',
        properties: {
          stockCode: { type: 'string', description: '6 位股票代码' },
          strategy: { type: 'string', description: '策略名，如 ma_cross' },
          startDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          endDate: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        },
        required: ['stockCode', 'strategy'],
      },
    },
  },
];

export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.function.name === name);
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 执行一次工具调用，返回字符串结果（供 LLM 消费）。
 * 任何异常都被吞掉并返回错误字符串，避免对话中断。
 */
export async function executeToolCall(call: ToolCall, deps: ToolDeps): Promise<string> {
  const def = getTool(call.function.name);
  if (!def) return `未知工具: ${call.function.name}`;
  const args = safeParseArgs(call.function.arguments);

  try {
    if (call.function.name === 'run_analysis') {
      if (!deps.runAnalysis) return 'run_analysis 未配置';
      const code = String(args.stockCode || '');
      if (!/^\d{6}$/.test(code)) return '请提供有效的 6 位股票代码';
      const r = await deps.runAnalysis(code);
      return truncate(JSON.stringify(r, null, 2));
    }
    if (call.function.name === 'compare_stocks') {
      if (!deps.runAnalysis) return 'compare_stocks 未配置';
      const codes = Array.isArray(args.stockCodes) ? args.stockCodes.map(String) : [];
      if (codes.length < 2 || codes.length > 3) return '请选择 2-3 只股票';
      const results = await Promise.all(codes.map((c) => deps.runAnalysis!(c)));
      return truncate(JSON.stringify(results, null, 2));
    }
    if (call.function.name === 'run_backtest') {
      if (!deps.runBacktest || !deps.parseStrategyInput || !deps.fetchOHLCVData) {
        return 'run_backtest 未配置';
      }
      const code = String(args.stockCode || '');
      // 与 run_analysis/evaluate_backtest 对齐：校验 6 位代码（此前缺失，行为不一致）
      if (!/^\d{6}$/.test(code)) return '请提供有效的 6 位股票代码';
      const strategy = String(args.strategy || 'ma_cross');
      const start = String(
        args.startDate ||
          new Date(Date.now() - 365 * 2 * 24 * 3600 * 1000).toISOString().split('T')[0],
      );
      const end = String(args.endDate || new Date().toISOString().split('T')[0]);
      // parseStrategyInput 接收策略描述串（如 'ma_cross'），返回完整策略配置；
      // 随后覆盖股票代码与起止日期，得到回测所需的 StrategyConfig。
      const parsed = deps.parseStrategyInput(strategy) as Record<string, unknown>;
      const cfg = { ...parsed, stockCode: code, startDate: start, endDate: end };
      const ohlcv = await deps.fetchOHLCVData(code, start, end);
      if (!ohlcv || ohlcv.length === 0) return `无法获取 ${code} 的 K 线数据`;
      const r = await deps.runBacktest(ohlcv, cfg);
      return truncate(JSON.stringify(r, null, 2));
    }
    if (call.function.name === 'evaluate_backtest') {
      if (!deps.runBacktest || !deps.parseStrategyInput || !deps.fetchOHLCVData) {
        return 'evaluate_backtest 未配置';
      }
      const code = String(args.stockCode || '');
      const strategy = String(args.strategy || 'ma_cross');
      const start = String(
        args.startDate ||
          new Date(Date.now() - 365 * 2 * 24 * 3600 * 1000).toISOString().split('T')[0],
      );
      const end = String(args.endDate || new Date().toISOString().split('T')[0]);
      if (!/^\d{6}$/.test(code)) return '请提供有效的 6 位股票代码';
      const parsed = deps.parseStrategyInput(strategy) as Record<string, unknown>;
      const baseCfg: Record<string, unknown> = {
        ...parsed,
        stockCode: code,
        startDate: start,
        endDate: end,
      };
      const ohlcv = await deps.fetchOHLCVData(code, start, end);
      if (!ohlcv || ohlcv.length === 0) return `无法获取 ${code} 的 K 线数据`;
      // 基线：无新闻叠加
      const baseline = await deps.runBacktest(ohlcv, baseCfg);
      // 实验组：叠加新闻情绪信号（若无可新闻则降级为基线，对比将判 tie）
      let expCfg: Record<string, unknown> = { ...baseCfg };
      if (deps.extractNewsSignal) {
        try {
          const ns = await deps.extractNewsSignal(code);
          if (ns.signal.hasNews) {
            // since=新闻最早发布日：叠加仅作用于该日之后，避免前视偏差
            // （内联计算而不 import newsSignal 的 helper，避免 llm↔quant 循环依赖）
            // items 缺失/为空时退化为 undefined=全程叠加，与旧调用方兼容
            const since = Array.isArray(ns.signal.items)
              ? ns.signal.items
                  .map((n) => (typeof n.publishedAt === 'string' ? n.publishedAt.slice(0, 10) : ''))
                  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
                  .sort()[0]
              : undefined;
            expCfg = { ...expCfg, newsOverlay: { polarity: ns.signal.polarity, since } };
          }
        } catch {
          // 新闻抓取失败：实验组退化为基线，评估器会判 inconclusive/tie
        }
      }
      const experiment = await deps.runBacktest(ohlcv, expCfg);
      // 动态导入评估器（避免工具注册表强耦合量化模块）
      const { compareBacktests } = await import('../quant/backtestEvaluator.js');
      const comparison = compareBacktests(
        baseline as import('../quant/types.js').BacktestResult,
        experiment as import('../quant/types.js').BacktestResult,
      );
      return truncate(JSON.stringify(comparison, null, 2));
    }
    return `工具 ${call.function.name} 无处理器`;
  } catch (err) {
    return `工具执行出错: ${(err as Error).message}`;
  }
}
