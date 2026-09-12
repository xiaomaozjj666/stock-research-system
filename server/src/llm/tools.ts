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
      /** 分段情绪时间线：透传给 newsOverlay.items，引擎按各 bar 已知新闻严格时序叠加 */
      timeline?: Array<{ publishedAt: string; polarity: number }>;
    };
    source: string;
  }>;
  /** 最近一次全市场初筛落盘结果（无记录为 null） */
  getScreenerLatest?: () => unknown;
  /** 实验台账概览（总量/采信/假阳性上界/OOS 占比） */
  getFactorExperimentSummary?: () => unknown;
  /** 时序计量分析（adf/garch/coint/arima/kalman-beta，与 HTTP 端点同口径） */
  runTimeseriesAnalyze?: (input: {
    test: string;
    code: string;
    code2?: string;
    startDate?: string;
    endDate?: string;
    options?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** 最近的研究简报 */
  listDigests?: (limit?: number) => unknown[];
  /** 最近公告语境（标题一览 + 最新一篇正文摘录，原文口径） */
  getAnnouncements?: (code: string) => Promise<unknown>;
  /** 估值建模：两阶段 EPS 贴现 + 可比公司表（假设可部分覆盖） */
  runValuationModel?: (input: {
    code: string;
    assumptions?: { growthRate1?: number; growthRate2?: number; discountRate?: number };
  }) => Promise<unknown>;
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
  {
    type: 'function',
    function: {
      name: 'get_screener_latest',
      description:
        '读取最近一次全市场初筛结果（形态触发 + RPS 相对强度分位扫全市场）。无参数；从未运行过时返回提示。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_factor_experiments',
      description:
        '因子实验台账概览：累计实验数、采信数、期望假阳性上界、OOS 稳定占比、按来源分布。回答「试过哪些因子、哪些可信」类问题时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_timeseries_analyze',
      description:
        '对单只 A 股做时间序列计量分析：adf(单位根)/garch(波动率)/coint(两股协整,需 code2)/arima(定阶)/kalman-beta(时变对冲比率,需 code2)。默认取近 3 年日频数据，秒级完成。',
      parameters: {
        type: 'object',
        properties: {
          test: {
            type: 'string',
            description: "分析类型：'adf' | 'garch' | 'coint' | 'arima' | 'kalman-beta'",
          },
          stockCode: { type: 'string', description: '6 位股票代码（coint/kalman-beta 为因变量）' },
          code2: { type: 'string', description: '第二条序列的 6 位代码（coint/kalman-beta 必填）' },
        },
        required: ['test', 'stockCode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_digests',
      description:
        '列出最近的研究简报（初筛状态 + 实验台账概览 + 增量说明）。回答「系统最近做了什么研究」类问题时使用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数，默认 5' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_announcements',
      description:
        '获取单只 A 股最近公告：标题一览 + 最新一篇正文摘录（原文，未改写）。回答「最近有什么公告」「公司刚发了什么」类问题时使用。',
      parameters: {
        type: 'object',
        properties: {
          stockCode: { type: 'string', description: '6 位股票代码' },
        },
        required: ['stockCode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_valuation_model',
      description:
        '估值建模：两阶段 EPS 贴现 DCF（内在价值 + 敏感性矩阵）+ 同业可比表（PE/PB 中位数折溢价）。假设可省略（自动从年报 EPS 推导），也可显式覆盖。',
      parameters: {
        type: 'object',
        properties: {
          stockCode: { type: 'string', description: '6 位股票代码' },
          growthRate1: {
            type: 'number',
            description: '显性期年增速（小数，如 0.12），缺省自动推导',
          },
          discountRate: { type: 'number', description: '折现率（小数，如 0.09），缺省 9%' },
        },
        required: ['stockCode'],
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
            expCfg = {
              ...expCfg,
              newsOverlay: { polarity: ns.signal.polarity, since, items: ns.signal.timeline },
            };
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
    if (call.function.name === 'get_screener_latest') {
      if (!deps.getScreenerLatest) return 'get_screener_latest 未配置';
      const r = deps.getScreenerLatest();
      if (
        !r ||
        (typeof r === 'object' && r !== null && 'at' in r && (r as { at: unknown }).at === null)
      ) {
        return '还没有初筛记录：需要先在「全市场初筛」里跑一次（POST /api/quant/screener/run）';
      }
      return truncate(JSON.stringify(r, null, 2));
    }
    if (call.function.name === 'get_factor_experiments') {
      if (!deps.getFactorExperimentSummary) return 'get_factor_experiments 未配置';
      return truncate(JSON.stringify(deps.getFactorExperimentSummary(), null, 2));
    }
    if (call.function.name === 'run_timeseries_analyze') {
      if (!deps.runTimeseriesAnalyze) return 'run_timeseries_analyze 未配置';
      const test = String(args.test || '').trim();
      const code = String(args.stockCode || '').trim();
      if (!/^\d{6}$/.test(code)) return '请提供有效的 6 位股票代码';
      const code2 = String(args.code2 || '').trim();
      if ((test === 'coint' || test === 'kalman-beta') && !/^\d{6}$/.test(code2)) {
        return `test='${test}' 需要第二条序列的 6 位代码（code2）`;
      }
      const r = await deps.runTimeseriesAnalyze({
        test,
        code,
        ...(code2 ? { code2 } : {}),
      });
      return truncate(JSON.stringify(r, null, 2));
    }
    if (call.function.name === 'list_recent_digests') {
      if (!deps.listDigests) return 'list_recent_digests 未配置';
      const limit =
        typeof args.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), 20)) : 5;
      const items = deps.listDigests(limit);
      if (items.length === 0) {
        return '还没有研究简报：POST /api/quant/digests/run 可手动生成一份';
      }
      return truncate(JSON.stringify(items, null, 2));
    }
    if (call.function.name === 'get_recent_announcements') {
      if (!deps.getAnnouncements) return 'get_recent_announcements 未配置';
      const code = String(args.stockCode || '').trim();
      if (!/^\d{6}$/.test(code)) return '请提供有效的 6 位股票代码';
      const brief = await deps.getAnnouncements(code);
      if (!brief || (typeof brief === 'string' && brief.trim() === '')) {
        return `${code} 最近没有可读的公告记录`;
      }
      return truncate(String(brief), 6000);
    }
    if (call.function.name === 'run_valuation_model') {
      if (!deps.runValuationModel) return 'run_valuation_model 未配置';
      const code = String(args.stockCode || '').trim();
      if (!/^\d{6}$/.test(code)) return '请提供有效的 6 位股票代码';
      const assumptions: Record<string, number> = {};
      if (typeof args.growthRate1 === 'number' && Number.isFinite(args.growthRate1)) {
        assumptions.growthRate1 = args.growthRate1;
      }
      if (typeof args.discountRate === 'number' && Number.isFinite(args.discountRate)) {
        assumptions.discountRate = args.discountRate;
      }
      const r = await deps.runValuationModel({
        code,
        ...(Object.keys(assumptions).length > 0 ? { assumptions } : {}),
      });
      return truncate(JSON.stringify(r, null, 2));
    }
    return `工具 ${call.function.name} 无处理器`;
  } catch (err) {
    return `工具执行出错: ${(err as Error).message}`;
  }
}
