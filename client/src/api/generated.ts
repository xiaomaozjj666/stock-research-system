/**
 * 由 services/openapi.ts 自动生成 —— 请勿手工编辑。
 *
 * 重新生成：npm run generate:api-types
 * 校验是否最新：npm run check:api-types（CI 会跑，改了契约没重生成会失败）
 *
 * 唯一权威来源是 `GET /api/openapi.json`。要改这里的字段，请改契约后重新生成，
 * 直接编辑本文件会在下一次生成时被覆盖，并且双向守卫会让 CI 变红。
 */

// ===== components/schemas =====

export type AnalysisResult = {
  /** 报告生成时间（ISO） */
  generatedAt?: string;
  /** 行情数据截止日 YYYY-MM-DD */
  dataAsOf?: string;
  /** 个股研判明细（单股分析通常只有 1 项） */
  stock_pool: StockPoolItem[];
  data_sources: DataSource[];
  /** 研究置信度（高/中/低） */
  research_confidence: string;
  /** 局限性说明 */
  limitation_explain: string;
};

export type AnalyzeStreamEvent = {
  phase: 'data' | 'experts' | 'arbitration' | 'scoring' | 'strategy' | 'done' | 'error';
  /** 该阶段的人话进度说明 */
  message: string;
  /** 综合评分；仅 phase=scoring 时出现 */
  totalScore?: number;
  /** 评级；仅 phase=scoring 时出现 */
  rating?: string;
  /** 完整分析报告；仅 phase=done 时出现 */
  result?: AnalysisResult;
  /** 机器可读错误码（如 LLM_QUEUE_TIMEOUT / ANALYSIS_IN_FLIGHT）；仅 phase=error 时出现 */
  code?: string;
};

export type AnnouncementListResult = {
  /** 6 位 A 股代码 */
  code: string;
  /** 公告列表（按日期倒序，pageSize 上限 30） */
  announcements: AnnouncementRow[];
};

export type AnnouncementRow = {
  /** 公告正文 art_code（拉全文的键） */
  artCode: string;
  /** 公告标题（原文） */
  title: string;
  /** 公告日期 YYYY-MM-DD */
  date: string;
};

export type AuditEntry = {
  id: string;
  /** epoch 毫秒 */
  timestamp: number;
  sessionId: string;
  userId?: string;
  /** 如 llm.chat / tool.run_analysis */
  action: string;
  category: 'llm_call' | 'tool_call' | 'trade_signal' | 'data_access' | 'user_query' | 'system';
  detail: string;
  riskLevel: 'info' | 'low' | 'medium' | 'high' | 'critical';
  traceId?: string;
  metadata?: Record<string, unknown>;
};

export type AuditReport = {
  /** 风险评分 0-100（越高越安全） */
  riskScore: number;
  futureFunctionRisk: 'low' | 'medium' | 'high';
  overfittingRisk: 'low' | 'medium' | 'high';
  survivorshipBias: 'low' | 'medium' | 'high';
  /** 逐项检查 */
  checks: {
    name: string;
    passed: boolean;
    detail: string;
    severity: 'info' | 'warning' | 'critical';
  }[];
  issues: string[];
  /** 可靠性评估文字 */
  reliability: string;
};

export type BacktestComparison = {
  /** 逐指标对比（7 项固定口径） */
  metrics: MetricDelta[];
  /** 超额年化收益（百分点） */
  alphaAnnualized: number;
  /** 配对日收益差 t 统计量 */
  tStatistic: number;
  /** Harvey-Liu-Zhu(2016) 分级：|t|>3 强显著、2<|t|≤3 边际显著 */
  significance:
    'significant_strong' | 'significant_marginal' | 'not_significant' | 'insufficient_sample';
  verdict: 'experiment_wins' | 'baseline_wins' | 'tie' | 'inconclusive';
  /** 人类可读结论（中文，含 DSR/CI 数字） */
  summary: string;
  /** 注意事项（数据质量/样本量/过拟合/非正态/成本） */
  caveats: string[];
  /** 差值序列的非正态诊断；样本 ≥30 时出现 */
  nonNormality?: {
    skewness: number;
    excessKurtosis: number;
    /** true=偏离正态，t 检验假设不成立 */
    nonNormal: boolean;
    /** 非正态时的提示；正态时为空串 */
    warning: string;
  };
  /** DSR ∈ [0,1]：校正搜索次数/非正态/样本长度后真实 SR>0 的概率 */
  deflatedSharpeRatio?: number;
  /** PSR ∈ [0,1]：未校正搜索次数的基准版 */
  probabilisticSharpeRatio?: number;
  /** MinTRL：达到 DSR≥0.95 所需最短回测年数 */
  minTrackRecordLength?: number;
  /** 配对 Block Bootstrap（Stationary Bootstrap）95% 置信区间 */
  bootstrap?: {
    /**
     * [下限, 上限]
     * 约束：最少 2 项；最多 2 项
     */
    ci95: number[];
    /** 配对差均值 > 0 的 bootstrap p 值（单尾） */
    pValue: number;
    /** 重采样次数 */
    iterations: number;
    /** CI 跨 0 = 不显著（此时以它为准） */
    crossesZero: boolean;
  };
};

export type BacktestEvaluation = {
  /** 基线：同区间、不叠加任何信号 */
  baseline: BacktestResult;
  /** 实验组：叠加新闻情绪（抓取失败时与基线同值） */
  experiment: BacktestResult;
  comparison: BacktestComparison;
  /** live=实时抓到并叠加；none=未启用或抓取失败，实验组退化为基线 */
  newsSource: 'live' | 'none';
};

export type BacktestResult = {
  /** 总收益率 % */
  totalReturn: number;
  /** 年化收益率 % */
  annualizedReturn: number;
  sharpeRatio: number;
  /** 索提诺比率；引擎当前恒返回 */
  sortinoRatio?: number;
  /** 最大回撤 % */
  maxDrawdown: number;
  /** 胜率 % */
  winRate: number;
  /** 交易次数 */
  tradeCount: number;
  /** 盈亏比 */
  profitFactor: number;
  /** 策略净值曲线（起始为初始资金） */
  equityCurve: {
    date: string;
    value: number;
  }[];
  /** 成交流水 */
  trades: {
    date: string;
    type: 'buy' | 'sell';
    price: number;
    shares: number;
    commission: number;
    reason: string;
  }[];
  /** 基准（买入持有）净值曲线 */
  benchmark: {
    date: string;
    value: number;
  }[];
  /** 是否应用了新闻情绪叠加层 */
  newsAware?: boolean;
  /** 新闻姿态 = clamp(0.5+0.5·polarity,0,1) */
  newsPosture?: number;
  /** 情绪叠加生效起始日；取不到时缺省 */
  newsSince?: string;
  /** 是否应用了组合 alpha 信号叠加层 */
  factorAware?: boolean;
  /** 组合 alpha 姿态；仅 factorAware 时出现 */
  factorPosture?: number;
  /** 组合 alpha 综合方向；仅因子叠加层生效时出现 */
  factorDirection?: 'up' | 'down' | 'neutral';
};

export type CacheDirStatus = {
  status: 'ok' | 'missing' | 'error';
  /** 绝对路径（如实回传，便于运维定位） */
  path: string;
  /** 不可读写的原因；仅 status=error 时出现 */
  error?: string;
};

export type CalculationError = {
  /** 回答中的原始断言文本 */
  claim: string;
  /** 核查员重构的算术公式 */
  reconstructedFormula: string;
  /** 按公式重算的结果 */
  recomputedValue: string;
  /** 回答中给出的数值 */
  claimedValue: string;
  /** 不一致的说明 */
  discrepancy: string;
};

export type ChartConfig = {
  type: string;
  title: string;
  config: Record<string, unknown>;
};

export type ChatAgentResponse = {
  /** 回答正文（中文 Markdown） */
  answer: string;
  /** 本次调用的工具名 */
  toolsUsed: string[];
  /** RAG 检索命中的证据片段（回答的引用出处） */
  evidence: ChatEvidence[];
  /** 多空辩论结果；未走辩论路径时缺省 */
  debate?: {
    bull: string;
    bear: string;
    /** 仲裁后的综合结论 */
    synthesis: string;
  };
  /** 风控三分视角辩论；debate 路径或风控关键词命中时出现 */
  riskDebate?: {
    aggressive: string;
    neutral: string;
    conservative: string;
    synthesis: string;
  };
  /** 路由规划结果；仅 LLM 可用时出现（降级为规则路径时缺省） */
  plan?: {
    action: 'direct' | 'tools' | 'debate';
    reason: string;
    skill?: SkillId;
  };
  /** 幻觉防护校验结果；仅 use_tools 路径且有工具结果时出现 */
  verification?: {
    /** true=所有关键断言可验证 */
    verified: boolean;
    /** 无法在工具结果/证据里找到对应的断言 */
    unverified: string[];
    /** 能定位到来源但算术重构后不一致的数值错误 */
    calculationErrors: CalculationError[];
    /** 给用户的警示文案（无问题时为空串） */
    warning: string;
  };
  /** true = LLM 未配置，走规则降级 */
  degraded: boolean;
  /** 产出本回答的模型 ID；降级时缺省 */
  model?: string;
};

export type ChatEvidence = {
  id: string;
  /** 来源标识（如 `doc:<标题>`） */
  source: string;
  /** 命中的原文片段 */
  text: string;
  /** 证据关联的标的；非标的文档时缺省 */
  stockCode?: string;
};

export type ChatStreamEvent = {
  phase:
    | 'planning'
    | 'retrieving'
    | 'tool_calling'
    | 'debating'
    | 'risk_debating'
    | 'verifying'
    | 'done'
    | 'error';
  /** 该阶段的人话进度说明 */
  message: string;
  /** 正在/已调用的工具名；仅 phase=tool_calling 时出现 */
  tools?: string[];
  /** 完整回答；仅 phase=done 时出现 */
  response?: ChatAgentResponse;
};

export type ComparableAnalysis = {
  /** 过滤掉 PE/PB 非正后的有效样本 */
  peers: ComparableRow[];
  sampleSize: number;
  /** 中位数比均值抗离群 */
  medianPe: number | null;
  medianPb: number | null;
  medianRoe: number | null;
  /** 本股相对同业中位 PE 的折溢价（小数）；样本不足为 null */
  pePremiumPct: number | null;
  pbPremiumPct: number | null;
  /** 中位 PE × 本股 EPS 的隐含每股价值；EPS 缺失为 null */
  impliedValueByMedianPe: number | null;
};

export type ComparableRow = {
  code: string;
  /** 本股自身 name 为空串（它不来自 peerComparison） */
  name: string;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  marketCap: number | null;
};

export type CompareResponse = {
  /** 成功项，顺序与请求一致 */
  stocks: StockPoolItem[];
  /** 失败项。**全部成功时该字段不出现**（与旧契约逐字兼容），消费方须按 `?? []` 处理 */
  failures?: {
    /** 请求里的股票代码 */
    code: string;
    /** 可读中文原因（不含堆栈/上游 URL） */
    error: string;
    /** 机器可读原因，如 DATA_UNAVAILABLE / LLM_QUEUE_TIMEOUT */
    errorCode?: string;
  }[];
};

export type CompositeAlpha = {
  /** 逐持有期的组合 alpha */
  horizons: CompositeAlphaHorizon[];
  /** 任一持有期存在显著因子 */
  hasSignal: boolean;
  /** 跨持有期多数表决的综合方向 */
  overallDirection: 'up' | 'down' | 'neutral';
  /** 各持有期 alpha 均值 ∈ [-1,1]；回测姿态缩放的卷积度 */
  overallAlpha: number;
};

export type CompositeAlphaBatchItem = {
  stockCode: string;
  ok: boolean;
  /** 成功项才有；失败项缺省 */
  result?: CompositeAlphaResult;
  /** 失败原因；失败项才有 */
  error?: string;
};

export type CompositeAlphaBatchResult = {
  /** 去重后的请求代码数 */
  requested: number;
  succeeded: number;
  failed: number;
  /** 逐只结果（按输入顺序） */
  items: CompositeAlphaBatchItem[];
  /** 批次公共参数回显 */
  startDate: string;
  endDate: string;
  horizons: number[];
};

export type CompositeAlphaHorizon = {
  /** 持有期（交易日） */
  period: number;
  /** 方向性组合 alpha ∈ [-1,1] */
  alpha: number;
  direction: 'up' | 'down' | 'neutral';
  /** 去重后纳入加权的显著因子数 */
  significantCount: number;
  /** 该持有期下有预测力的因子总数（非 null） */
  evaluableCount: number;
  /** 显著因子方向一致率 ∈ [0,1] */
  agreement: number;
  /** 主导贡献因子（按 |贡献| 降序，最多 3 项） */
  topContributors: CompositeContributor[];
};

export type CompositeAlphaResult = {
  stockCode: string;
  /** 识别出的市场 */
  market: 'A' | 'HK' | 'US';
  /** 实际使用的基准指数 secid */
  benchmarkSecid: string;
  /** 持有期（交易日） */
  horizons: number[];
  compositeAlpha: CompositeAlpha;
  /** 逐因子时间序列预测力（组合 alpha 的构建块，供透明审视） */
  factorPredictability: FactorPredictability[];
  /** K 线条数 */
  bars: number;
  dataRange: {
    start: string;
    end: string;
  };
  /** 市场基准收益是否取到；false 时 Beta 类因子按 NaN 处理、不参与加权 */
  benchmarkAvailable: boolean;
  /** K 线是否来自取数失败后的合成降级；旧版结果可能缺此字段（缺省视为非模拟） */
  isSimulated?: boolean;
};

export type CompositeContributor = {
  /** 因子名 */
  name: string;
  /** 方向校正 IC（含符号） */
  effectiveIc: number;
  /** 置信度权重 = |tStat| */
  weight: number;
  /** 加权贡献 = weight × effectiveIc */
  contribution: number;
};

export type ConsensusSnapshot = {
  code: string;
  orgNum: number | null;
  ratings: {
    buy: number | null;
    add: number | null;
    neutral: number | null;
    reduce: number | null;
    sale: number | null;
  };
  forecasts: {
    year: number;
    eps: number;
    mark: 'A' | 'E';
  }[];
  targetPriceMax: number | null;
  targetPriceMin: number | null;
  north?: {
    date: string;
    holdSharesRatio: number | null;
    holdMarketCap: number | null;
  };
};

export type CostReport = {
  /** 累计估算成本（USD，保留 6 位小数） */
  totalCost: number;
  /** 累计输入 token */
  totalPromptTokens: number;
  /** 累计输出 token */
  totalCompletionTokens: number;
  /** 累计调用次数 */
  callCount: number;
  /** 模型 ID → 该模型的用量聚合 */
  byModel: Record<
    string,
    {
      cost: number;
      calls: number;
    }
  >;
};

export type CrossSectionFactor = {
  name: string;
  /** 因子族；pattern 是零额外网络调用的技术形态事件族 */
  type: 'price_volume' | 'fundamental' | 'margin' | 'event' | 'pattern';
  report: FactorEvaluationReport;
  /** 组合回测；仅请求了 portfolio 且该因子有原始观测面板时出现 */
  portfolio?: PortfolioBacktestResult;
};

export type CrossSectionResult = {
  universe: FactorUniverse;
  /** 参与组装的股票 */
  stocksIncluded: string[];
  /** 被跳过的股票及原因（K 线不足等） */
  stocksSkipped: StockSkip[];
  /** 实际测算的持有期档位 */
  horizons: number[];
  /** 逐因子的截面评估（仅含样本 ≥30 的因子） */
  factors: CrossSectionFactor[];
  run: RunSnapshot;
  preflight: Preflight;
  ledger: LedgerReceipt;
};

export type DataQualityReport = {
  /** 质量评分 0-100 */
  overallScore: number;
  totalRecords: number;
  /** 缺失的交易日 */
  missingDates: string[];
  /** 离群点 */
  outliers: {
    date: string;
    field: string;
    value: number;
    /** 预期区间的人话描述 */
    expected: string;
  }[];
  /** 重复日期 */
  duplicates: string[];
  /** 问题描述 */
  issues: string[];
  /** 预处理建议 */
  suggestions: string[];
  dataRange: {
    start: string;
    end: string;
    tradingDays: number;
  };
};

export type DataSource = {
  name: string;
  description: string;
  confidence: number;
  /** 报告中哪些模块的数据来自该来源 */
  coverage?: string;
};

export type DocumentInsight = {
  /** 全文摘要（中文） */
  summary: string;
  /** 利好要点 */
  positives: string[];
  /** 风险要点 */
  risks: string[];
  /** 催化剂要点 */
  catalysts: string[];
  confidence: 'high' | 'medium' | 'low';
  /** llm=模型抽取；heuristic=词典法兜底（LLM 未配置/失败） */
  source: 'llm' | 'heuristic';
};

export type DocumentList = {
  /** 文档总数 */
  count: number;
  /** 文档摘要列表 */
  docs: {
    id: string;
    source: string;
    /** 正文预览片段 */
    preview: string;
  }[];
};

export type EnsembleAnswer = {
  /** 模型 ID */
  model: string;
  /** 该模型是否调用成功（出现在 answers 里即为 true） */
  ok: boolean;
  /** 模型输出正文 */
  text: string;
  /** 失败原因；ok=false 时出现 */
  error?: string;
  /** 该模型本次的权重（校准命中率） */
  weight: number;
};

export type EnsembleResult = {
  /** 各候选模型的输出（只含成功项） */
  answers: EnsembleAnswer[];
  /** 按权重聚类胜出的答案 */
  consensus: string;
  /** 一致度 0-1：胜出组权重 / 全部权重 */
  agreement: number;
  /** 参与且成功的模型数 */
  effectiveModels: number;
};

export type ErrorResponse = {
  /** 可直接展示给用户的中文说明 */
  error: string;
  /** 内部细节，仅非生产环境回传；不保证稳定，消费方不应依赖 */
  detail?: string;
  /** 机器可读错误码（如 ANALYSIS_IN_FLIGHT） */
  code?: string;
};

export type ExpertOpinion = {
  expert: string;
  arguments: {
    text: string;
    confidence: number;
    type: 'support' | 'oppose';
    /** 论据性质 */
    evidenceType?: 'fact' | 'inference' | 'hypothesis';
  }[];
  overallSentiment: 'bullish' | 'neutral' | 'bearish';
  confidence: number;
  keyPoints: string[];
};

export type ExpressionBatchItem = {
  /** 表达式原文 */
  expression: string;
  /** 该条是否评估成功 */
  ok: boolean;
  /** 失败原因（解析错误或观测不足）；ok=false 时出现 */
  error?: string;
  /** ok=true 时出现 */
  stocksIncluded?: string[];
  /** 被跳过的股票；ok=true 时恒有，观测不足失败时也有 */
  stocksSkipped?: StockSkip[];
  /** ok=true 时出现 */
  horizons?: number[];
  factor?: ExpressionFactor;
  /** 组合回测；ok=true 且请求了 portfolio 时出现 */
  portfolio?: PortfolioBacktestResult | null;
  /** 本条的台账写入条数（ok=true 时出现） */
  ledger?: {
    recorded: number;
  };
};

export type ExpressionFactor = {
  /** 因子名；未传 name 时为 custom_expression */
  name: string;
  type: 'expression';
  report: FactorEvaluationReport;
};

export type ExternalApiProbe = {
  status: 'reachable' | 'unreachable';
  /** 上游 HTTP 状态码；仅 reachable 时出现 */
  httpStatus?: number;
  /** 失败原因；仅 unreachable 时出现 */
  error?: string;
  /** 该结论的产出时刻（memo 命中时是过去的时间） */
  checkedAt: string;
  /** true=结论来自 memo，本次未真正外呼 */
  cached: boolean;
};

export type FactorAlphaBeta = {
  /** 年化 alpha（小数） */
  alpha: number;
  /** 对市场（等权全市场收益）的 beta */
  beta: number;
  r2: number;
};

export type FactorEvaluationReport = {
  /** 参与分析的持有期（升序） */
  periods: number[];
  /** 逐持有期报告 */
  byPeriod: FactorPeriodReport[];
  /** 有效样本数（各期共用同一份清洗结果） */
  sampleSize: number;
  /** 因因子值/收益非有限被丢弃的样本数 */
  dropped: number;
  /** 丢弃比例 ∈ [0,1] */
  dropRatio: number;
  /** 中性化是否真的生效（缺市值与行业数据时为 false） */
  neutralized: boolean;
};

export type FactorExperiment = {
  id: string;
  createdAt: string;
  source: 'cross-section' | 'expression' | 'hypothesis';
  name: string;
  expression?: string;
  universe: {
    board?: string;
    codes?: string[];
    requested: number;
    included: number;
  };
  horizon: number;
  sampleSize: number;
  icMean: number;
  pValue: number;
  oosStable: boolean;
  kept: boolean;
  /** 判据输入留痕。**旧记录缺省**（该块是改造后才开始落的），改进循环只回放带它的记录——不猜、不补默认值 */
  evidence?: {
    /** IC 有效样本期数 */
    icN: number;
    /** 分档数 */
    quantileRows: number;
    /** 分档收益单调性 ∈ [-1,1] */
    monotonicity: number;
    /** 多空价差（小数） */
    spread: number;
  };
  notes?: string;
};

export type FactorExperimentSummary = {
  /** 台账总条数 */
  total: number;
  /** 被采信的条数 */
  kept: number;
  /** 来源 → 条数（cross-section / expression / hypothesis） */
  bySource: Record<string, number>;
  /** 最近一次实验时间；台账为空时为 null */
  lastAt: string | null;
  /** 采信集的期望假阳性数上界 = kept × 0.05 */
  keptExpectedFalse: number;
  /** 采信集中 OOS 稳定的占比 ∈ [0,1]；无采信项时为 0 */
  keptOosShare: number;
};

export type FactorExpressionBatchResult = {
  universe: FactorUniverse;
  horizons: number[];
  /** 本次请求的表达式条数 */
  requested: number;
  /** 评估成功的条数 */
  evaluated: number;
  /** 逐表达式结果（按输入顺序） */
  results: ExpressionBatchItem[];
  run: RunSnapshot;
  preflight: Preflight;
  ledger: LedgerReceipt;
};

export type FactorExpressionResult = {
  universe: FactorUniverse;
  stocksIncluded: string[];
  stocksSkipped: StockSkip[];
  horizons: number[];
  factor: ExpressionFactor;
  /** 组合回测；未请求时缺省 */
  portfolio?: PortfolioBacktestResult | null;
  run: RunSnapshot;
  preflight: Preflight;
  ledger: LedgerReceipt;
};

export type FactorPeriodReport = {
  /** 持有期（交易日） */
  period: number;
  sampleSize: number;
  ic: IcSignificance;
  oos: OosStability;
  quantile: QuantileReturnTable;
  /** 缺 symbol 或不足两个截面时为 null */
  turnover: TurnoverResult | null;
  /** 样本 < 3 天或市场收益无波动时为 null */
  alphaBeta: FactorAlphaBeta | null;
  /** 因子加权多空组合累计净值（起始 1） */
  longShortCumulative: number;
  verdict: FactorVerdict;
};

export type FactorPredictability = {
  /** 因子名（见 PriceVolumeFactor） */
  name: string;
  /** +1=值越高预期收益越高；-1=值越低越好（A 股实证已校正） */
  direction: 1 | -1;
  category: 'volatility' | 'reversal' | 'momentum' | 'liquidity' | 'volume' | 'risk';
  /** 持有期（交易日）→ 预测力；样本不足时该键值为 null */
  horizons: Record<string, FactorPredictabilityHorizon | null>;
  /** 是否有任一持有期达到统计显著（Holm 校正后） */
  hasSignal: boolean;
};

export type FactorPredictabilityHorizon = {
  /** Spearman 秩相关 IC ∈ [-1,1] */
  ic: number;
  /** 经济方向 IC = ic × direction；>0 即方向兑现 */
  effectiveIc: number;
  /** t 统计量（按重叠修正后的有效样本量 nEff） */
  tStat: number;
  /** Student t 双侧 p 值（未校正） */
  pValue: number;
  /** 跨因子 Holm 校正后 p 值；significant 判据用它 */
  pAdj?: number;
  /** pAdj < 0.05 即统计显著 */
  significant: boolean;
  /** 有效样本数 */
  n: number;
  /** 重叠修正后有效样本量 ≈ ceil(n/period) */
  nEff: number;
};

export type FactorUniverse = {
  source: 'codes' | 'board' | 'index';
  /** 板块代码；source=board 时出现 */
  board?: string;
  /** source=index 时出现 */
  index?: 'hs300' | 'zz500' | 'sz50';
  /** 请求的成分快照日；未指定时为 null（仅 source=index） */
  requestedDate?: string | null;
  /** 成分快照的实际调仓日；取不到时为 null（仅 source=index） */
  updateDate?: string | null;
  /** 解析出的成分/请求只数 */
  requested: number;
  /** 成分股；codes 源不返回（那只数已由 requested 给出） */
  constituents?: {
    code: string;
    /** Baostock 侧可能无名称 */
    name: string | null;
  }[];
  /** 上游失败但用了磁盘快照；仅 source=board 会出现 */
  stale?: boolean;
  /** 陈旧快照的年龄（毫秒） */
  staleAgeMs?: number;
  /** 幸存者偏差声明；仅截面端点返回 */
  survivorshipNote?: string;
};

export type FactorVerdict = {
  effective: boolean;
  /** 未通过的原因（中文）；effective=true 时为空数组 */
  reasons: string[];
};

export type FinancialData = {
  years: string[];
  revenue: number[];
  netProfit: number[];
  grossMargin: number[];
  netMargin: number[];
  roe: number[];
  operatingCashFlow: number[];
  eps: number[];
  totalAssets: number[];
  totalLiabilities: number[];
  equity: number[];
  accountsReceivable: number[];
  inventory: number[];
  goodwill: number[];
  debtRatio: number[];
  /** 资本支出（亿元） */
  capEx?: number[];
  /** 数据质量标记：哪些字段是估算/缺失 */
  dataQuality?: {
    estimatedFields: string[];
    missingFields: string[];
  };
};

export type HarnessPolicy = {
  /** IC 最小有效样本期数，不足直接判无效 */
  minIcSamples: number;
  /** 显著性水平；IC 的 p 值须严格小于它 */
  significanceLevel: number;
  /** 分档收益单调性下限（Spearman 秩相关） */
  minMonotonicity: number;
  /** 是否要求多空价差为正（关闭后允许方向不成立的因子被采信） */
  requirePositiveSpread: boolean;
};

export type HealthReport = {
  /** 恒为 ok；降级由 HTTP 503 表达而非本字段 */
  status: string;
  /** 本次响应生成时间（ISO） */
  timestamp: string;
  /** 进程运行时长（秒） */
  uptime: number;
  /** process.memoryUsage() 原始返回（单位字节） */
  memory: Record<string, number>;
  externalApi: ExternalApiProbe;
  cacheDir: CacheDirStatus;
  quantCacheDir: CacheDirStatus;
};

export type HistoryItem = HistorySummary & {
  result: AnalysisResult;
};

export type HistorySummary = {
  id: string;
  stockCode: string;
  stockName: string;
  createdAt: string;
  rating: string;
  totalScore: number;
  industry?: string;
  /** 评分/评级时间线（旧数据可能没有该字段） */
  timeline?: {
    date: string;
    score: number;
    rating: string;
  }[];
};

export type IcSignificance = {
  /** IC 序列长度（参与计算的天数） */
  n: number;
  /** IC 均值 */
  mean: number;
  /** IC 标准差（样本口径 ddof=1） */
  std: number;
  /** 信息比率 IR = mean / std */
  ir: number;
  /** t 统计量（启用 Newey-West 时为 HAC 修正值） */
  tStat: number;
  /** 双侧 p 值（H₀: IC = 0） */
  pValue: number;
  /** IC 分布偏度 */
  skew: number;
  /** IC 分布超额峰度（正态 = 0） */
  excessKurtosis: number;
  /** Newey-West 最大滞后阶 = period−1；iid 口径时不出现 */
  nwMaxLag?: number;
};

export type ImprovementLoopState = {
  /** 调度是否在运行 */
  running: boolean;
  /** 当前生效的轮询间隔（毫秒） */
  intervalMs: number;
  /** 最近一轮结束时间（ISO）；未跑过时缺省 */
  lastRunAt?: string;
  /** 最近一轮的结局说明（中文） */
  lastReason?: string;
  /** 最近一轮是否真的改动了判据 */
  lastChanged: boolean;
  /** 已发起的轮次（含失败轮次） */
  runCount: number;
  /** 抛异常的轮次数 */
  errorCount: number;
  /** 连续失败次数（成功后清零），退避与自动停止的依据 */
  consecutiveErrors: number;
  /** 是否因连续失败被自动停止（与用户主动 stop 区分） */
  stoppedByErrors: boolean;
  /** 最近一次失败原因 */
  lastError?: string;
};

export type ImprovementRecord = {
  id: string;
  createdAt: string;
  target: 'factor-verdict-policy';
  /** 本轮用到多少经验、怎么切的训练/验证集 */
  basis: {
    /** 带完整判据证据、可参与回放的记录数 */
    evidenceCount: number;
    /** 训练集条数（较早的一段） */
    trainCount: number;
    /** 验证集条数（较新的一段） */
    validationCount: number;
    /** 切分口径的人可读说明 */
    split: string;
  };
  /** 改动前的判据（回滚基准） */
  before: HarnessPolicy;
  /** 本轮胜出的候选判据 */
  after: HarnessPolicy;
  /** 决策指标：验证集上的「采信集样本外稳定占比」（使用者口径） */
  metric: {
    name: 'oos-precision';
    before: number;
    after: number;
    delta: number;
    /** 改前采信条数（精度须连着样本量读） */
    keptBefore: number;
    /** 改后采信条数 */
    keptAfter: number;
  };
  /** 配对 McNemar 精确检验的原始计数与判定 */
  significance: {
    /** 改前判定准确率 */
    accuracyBefore: number;
    /** 改后判定准确率 */
    accuracyAfter: number;
    /** 改后对、改前错的条数（McNemar b） */
    afterBetter: number;
    /** 改前对、改后错的条数（McNemar c） */
    beforeBetter: number;
    /** 双侧精确 p 值 */
    pValue: number;
    /** 判定阈值 */
    alpha: number;
    /** 是否达到显著（决策必要条件之一） */
    significant: boolean;
  };
  outcome: 'kept' | 'reverted';
  /** 中文判定说明，可直接展示给用户 */
  verdict: string;
  /** 本轮试过的全部候选（含被否的），用于避免重复试探 */
  tried: TriedCandidate[];
};

export type ImprovementRunResult = {
  /** 判据是否真的被改动并落盘生效 */
  changed: boolean;
  /** 结局说明（中文）；changed=false 时即为未改动的原因 */
  reason: string;
  /** 本轮真正评估过的候选数 */
  evaluated: number;
  /** 本次是否为演练（true=只评估不落盘） */
  dryRun: boolean;
  /** 写入台账的记录；dryRun=true 或本轮未产生记录时为 null */
  record: ImprovementRecord | null;
  policy: HarnessPolicy;
  policySource: 'default' | 'stored';
  policyRevision: number;
};

export type ImprovementStatus = {
  target: 'factor-verdict-policy';
  policy: HarnessPolicy;
  /** default=仍是出厂判据；stored=已从落盘文件读回 */
  policySource: 'default' | 'stored';
  /** 判据落盘时间 */
  policyUpdatedAt: string | null;
  /** 判据保留次数（每保留一次改动 +1） */
  policyRevision: number;
  /** 上一次改动的摘要 */
  lastChange: string | null;
  /** 判据是否仍是出厂值（从未被改动过） */
  isFactoryPolicy: boolean;
  /** 改进台账汇总（quant/improvementLedger.summarizeImprovements） */
  ledger: {
    total: number;
    kept: number;
    reverted: number;
    /** 最近一轮时间 */
    lastAt: string | null;
    /** 最近一次被保留的改动时间 */
    lastKeptAt: string | null;
    /** 历史试过的去重候选数（负结果复用的抓手） */
    triedCandidates: number;
  };
  /** 可回放证据盘点：ready=false 时 run 会直接返回原因、不评估候选 */
  replay: {
    /** 带判据证据、可参与回放的记录数 */
    available: number;
    /** 跑一轮所需的最小证据数 */
    required: number;
    /** 验证集所需的最小条数 */
    validationRequired: number;
    /** 按同一口径切出的验证集条数 */
    validationAvailable: number;
    /** 现在跑一轮是否会真的评估候选 */
    ready: boolean;
    /** 口径说明（改造前的历史记录不参与回放） */
    note: string;
  };
  /** 决策门槛：让调用方知道「显著」是按什么标准判的 */
  decision: {
    /** 显著性阈值（DECISION_ALPHA） */
    alpha: number;
    /** 检验方法（人话说明） */
    test: string;
  };
  /** 周期调度状态；未启动为 null */
  scheduler: ImprovementLoopState | null;
};

export type IndustryBoard = {
  code: string;
  name: string;
};

export type IntlFundamentals = {
  code: string;
  market: 'HK' | 'US';
  name: string;
  pe: number;
  pb: number;
  /** 亿元（本币计） */
  marketCap: number;
  revenue: number;
  netIncome: number;
  totalAssets: number;
  totalLiabilities: number;
  /** HKD / USD */
  currency: string;
  dataSource: string;
};

export type IntlFundamentalsResult = {
  /** 上游不可用时为 null（降级场景） */
  fundamentals: IntlFundamentals | null;
  /** 是否为降级结果 */
  degraded: boolean;
  source: string;
  fetchedAt: string;
};

export type IntlKline = {
  /** YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 上游取数失败降级为模拟数据 */
  isSimulated?: boolean;
};

export type LedgerReceipt = {
  /** 本次实际写入的台账条数；batch 端点不返回 */
  recorded?: number;
  /** 台账现存总条数 */
  total: number;
};

export type MetricDelta = {
  name:
    | 'totalReturn'
    | 'annualizedReturn'
    | 'sharpeRatio'
    | 'sortinoRatio'
    | 'maxDrawdown'
    | 'winRate'
    | 'profitFactor';
  baseline: number;
  experiment: number;
  /** experiment − baseline（maxDrawdown 为负=改善） */
  delta: number;
  /** 改善方向是否为「好」（回撤↓好，其余↑好） */
  improved: boolean;
};

export type ModelRoutingInfo = {
  /** LLM 是否可用（已配置 API key） */
  available: boolean;
  /** 嵌入模型是否已配置 */
  embeddingEnabled: boolean;
  registry: ModelSpec[];
  /** 任务标签 → 选中的模型 ID */
  routing: Record<string, string>;
};

export type ModelSpec = {
  /** 模型 ID（传给上游的 model 值） */
  id: string;
  /** 展示名 */
  label: string;
  /** 输入单价（USD / 1k token，未配置时 0） */
  costPer1kInput: number;
  /** 输出单价（USD / 1k token，未配置时 0） */
  costPer1kOutput: number;
  /** 该模型擅长的任务标签（路由的候选集合） */
  tasks: ('chat' | 'analysis' | 'debate' | 'extract' | 'reasoning' | 'embedding')[];
};

export type NewsSignal = {
  /** 加权极性 [-1,1] */
  polarity: number;
  sentimentZ: number;
  /** 看多占比 [0,1] */
  bullishRatio: number;
  newsCount: number;
  freshness: number;
  weightedImpact: number;
  items: {
    id: string;
    title: string;
    summary?: string;
    /** 约束：格式 date-time */
    publishedAt: string;
    source?: string;
    polarity?: number;
  }[];
  hasNews: boolean;
};

export type OkResult = {
  ok: boolean;
};

export type OosStability = {
  /** 样本内 IC 均值 */
  isMeanIc: number;
  /** 样本外 IC 均值 */
  oosMeanIc: number;
  /** 两段 IC 均值同号 */
  signAgree: boolean;
  isSignificant: boolean;
  oosSignificant: boolean;
  /** 方向同号且两段都显著才为 true */
  stable: boolean;
  /** 样本内 IC 天数 */
  isN: number;
  /** 样本外 IC 天数 */
  oosN: number;
};

export type OptimizationReport = {
  /** 性能评分 0-100 */
  performanceScore: number;
  suggestions: {
    category: 'parameter' | 'risk' | 'entry' | 'exit' | 'position';
    title: string;
    detail: string;
    impact: 'high' | 'medium' | 'low';
  }[];
  parameterSensitivity: {
    param: string;
    currentValue: number;
    suggestedRange: {
      min: number;
      max: number;
      optimal: number;
    };
    sensitivity: 'high' | 'medium' | 'low';
  }[];
  riskMetrics: {
    /** 95% VaR */
    var95: number;
    maxConsecutiveLoss: number;
    avgHoldingDays: number;
  };
  /** 迭代优化方向 */
  iterationDirections: string[];
};

export type PaperEquityPoint = {
  date: string;
  /** 现金 + 持仓市值 */
  value: number;
};

export type PaperOrder = {
  id: string;
  code: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  price?: number;
  quantity: number;
  placedDate: string;
  status: 'pending' | 'filled' | 'expired' | 'rejected';
  fillDate?: string;
  fillPrice?: number;
  filledQuantity?: number;
  commission?: number;
  /** 仅卖出产生 */
  stampDuty?: number;
  rejectReason?: string;
};

export type PaperPortfolio = {
  initialCapital: number;
  cash: number;
  /** 当前交易日 */
  currentDate: string | null;
  positions: PaperPosition[];
  /** 最近 50 笔订单 */
  orders: PaperOrder[];
  /** 每日净值 */
  equity: PaperEquityPoint[];
};

export type PaperPosition = {
  code: string;
  /** 股数（100 整数倍） */
  quantity: number;
  /** 摊薄成本（含买入佣金） */
  avgCost: number;
  /** 最近一次买入日 YYYY-MM-DD（T+1 校验用） */
  buyDate: string;
};

export type PaperStats = {
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  /** 净值点不足时为 null */
  sharpeRatio: number | null;
  totalDays: number;
  /** 逐日收益率（保留窗口内的有界数组，供前端画图） */
  dailyReturns: number[];
};

export type PortfolioBacktestResult = {
  /** 组合净值曲线（每个调仓期平仓成交日一个点，起始 1） */
  equityCurve: {
    date: string;
    value: number;
  }[];
  /** 基准净值曲线（同口径） */
  benchmarkCurve: {
    date: string;
    value: number;
  }[];
  /** 逐次调仓记录 */
  rebalances: RebalanceRecord[];
  /** 总收益 %（扣费后） */
  totalReturn: number;
  /** 年化收益 %（扣费后） */
  annualizedReturn: number;
  sharpe: number;
  /** 最大回撤 %（扣费后净值口径） */
  maxDrawdown: number;
  /** 周期胜率 %：跑赢基准的调仓期占比 */
  winRate: number;
  /** 平均换手率 ∈ [0,1] */
  avgTurnover: number;
  /** 调仓期数 */
  periods: number;
};

export type Preflight = {
  ok: boolean;
  checks: {
    key: string;
    ok: boolean;
    detail: string;
  }[];
  degraded: string[];
  checkedAt: string;
};

export type PriceHistoryPoint = {
  /** YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 取数失败降级为模拟数据 */
  isSimulated?: boolean;
};

export type PriceVolumeFactor = {
  /** 因子名（11 个量价因子之一） */
  name: string;
  /** 最新一日的因子快照值；数据不足时为 NaN，**JSON 序列化为 null**——据此配合 available 剔除，绝不可当 0 参与加权 */
  value: number | null;
  /** +1=值越高越好；-1=值越低越好 */
  direction: 1 | -1;
  category: 'volatility' | 'reversal' | 'momentum' | 'liquidity' | 'volume' | 'risk';
  /** 实证依据摘要（第三方研究结论） */
  evidence: string;
  /** 是否按 A 股实证做过方向翻转（true = 与美股经典口径相反） */
  aShareAdjusted: boolean;
  /** 快照值是否可用（Number.isFinite(value)） */
  available: boolean;
  /** 该因子对本股远期收益的时间序列预测力；预测力计算失败时缺省 */
  predictability?: FactorPredictability;
};

export type QuantReport = {
  /** 生效的策略配置（parseStrategyInput 解析并补齐日期区间后的结果） */
  strategy: {
    name: string;
    type: 'ma_cross' | 'momentum' | 'mean_reversion' | 'custom';
    stockCode: string;
    /** 策略参数（键随 type 而异：短长周期 / 阈值 / 均线周期…） */
    params: Record<string, number>;
    startDate: string;
    endDate: string;
    /** 初始资金，默认 100 万 */
    initialCapital?: number;
    /** 佣金率 */
    commission?: number;
    /** 滑点 */
    slippage?: number;
    /** 交易成本模型；未设置时按 commission/slippage 构造对称模型 */
    costModel?: 'a_share';
    /** 新闻情绪叠加层；未启用时缺省 */
    newsOverlay?: {
      /** 聚合极性 ∈ [-1,1] */
      polarity: number;
      /** 旧口径下姿态自该日起常数生效 */
      since?: string;
      /** 分段情绪时间线（严格时序口径，优先于 since） */
      items?: {
        publishedAt: string;
        polarity: number;
      }[];
    };
    /** 组合 alpha 信号叠加层；未注入时缺省 */
    factorOverlay?: {
      direction: 'up' | 'down' | 'neutral';
      /** 组合 alpha ∈ [-1,1] */
      alpha: number;
      /** 建仓资金缩放系数 ∈ [0,1] */
      posture?: number;
    };
  };
  dataQuality: DataQualityReport;
  backtest: BacktestResult;
  /** 无叠加层的基线回测；仅在有新闻时才回传 */
  backtestBaseline?: BacktestResult;
  /** 最新消息情绪；仅在抓到/粘贴到新闻时才回传 */
  newsSentiment?: NewsSignal;
  /** 量价因子快照值 + 时间序列预测力（A 股方向已按本土实证校正） */
  priceVolumeFactors: PriceVolumeFactor[];
  /** 多因子按 |t| 置信度加权的方向性组合 alpha；计算失败时缺省 */
  compositeAlpha?: CompositeAlpha;
  audit: AuditReport;
  optimization: OptimizationReport;
  /** 中文摘要（generateSummary 产出） */
  summary: string;
  /** 研究置信度；由数据质量分与审计分联合分档 */
  confidence: '高' | '中' | '低';
  /** 局限性说明，多条以「；」拼接 */
  limitations: string;
};

export type QuantileReturnTable = {
  /** 持有期（交易日） */
  period: number;
  /** 各档收益；档号 1 = 因子值最低档，某日样本不足时该档为空 */
  rows: {
    /** 档号 ∈ [1, quantiles] */
    quantile: number;
    /** 落入该档的样本数 */
    count: number;
    /** 加权平均周期收益（小数） */
    meanReturn: number;
    /** 收益标准差（样本口径） */
    stdReturn: number;
  }[];
  /** 多空价差 = 最高档 − 最低档（小数） */
  spread: number;
  /** 单调性 ∈ [-1,1]：档号与各档收益的 Spearman 秩相关 */
  monotonicity: number;
};

export type RatingAccuracy = {
  /** 已评估样本数 */
  sampleCount: number;
  /** 参与命中判定的样本数（排除中性评级） */
  judgedCount: number;
  hitCount: number;
  /** 命中率 %；样本不足为 null */
  accuracyPct: number | null;
  /** 平均区间收益 % */
  avgReturnPct: number | null;
  /** 已记录但未到期（<20 天）的样本数 */
  pendingCount?: number;
};

export type RebalanceRecord = {
  /** 决策日（t 日收盘计算因子） */
  date: string;
  /** 建仓成交日（t+1 开盘撮合） */
  fillDate: string;
  /** 平仓成交日（与下一期建仓同日） */
  exitDate: string;
  /** 期末日期（下一调仓日前一交易日 / 数据末日） */
  endDate: string;
  /** 持仓代码（因子值降序） */
  holdings: string[];
  /** 换手率 ∈ [0,1]（首期为 1） */
  turnover: number;
  /** 本期组合收益（扣费前，小数） */
  grossReturn: number;
  /** 本期成本拖累（负收益形式） */
  costDrag: number;
  /** 本期基准收益（小数） */
  benchmarkReturn: number;
};

export type ResearchDigest = {
  id: string;
  createdAt: string;
  screener: {
    at: string | null;
    scanned: number | null;
    eligible: number | null;
    hitCount: number | null;
    topHits: {
      code: string;
      name: string;
      strategy: string;
      detail: string;
    }[];
  };
  ledger: {
    total: number;
    kept: number;
    /** 期望假阳性上界 = 采信数 × 5% */
    keptExpectedFalse: number;
    /** 采信集中 OOS 稳定的占比（0-1） */
    keptOosShare: number;
    bySource: Record<string, number>;
  };
  notes: string[];
};

export type ResearchMemory = {
  stockCode: string;
  /** 同股票的上一次分析；从未分析过时为 null */
  previous: {
    createdAt: string;
    rating: string;
    totalScore: number;
  } | null;
  /** 该股票历史分析次数 */
  historyCount: number;
  /** 近期评分序列（由旧到新，最多 5 条） */
  scoreTrend: number[];
  /** 台账中被采信的因子（近 5 条）作为「已验证过什么」的先验 */
  validatedFactors: {
    name: string;
    /** 持有期（交易日） */
    horizon: number;
    /** 该条记录的截面 IC 均值 */
    icMean: number;
  }[];
  /** 拼好的中文摘要（可直接注入提示词）；无记忆时为 null */
  summary: string | null;
};

export type RunSnapshot = {
  /** 运行种类（如 cross-section / composite-batch） */
  kind: string;
  /** 快照时刻（ISO） */
  at?: string;
  /** 产出该快照的 Node 版本 */
  node?: string;
  /** 取数起始日（截面/表达式系端点） */
  start?: string;
  /** 取数结束日（截面/表达式系端点） */
  end?: string;
  /** 取数起始日（composite-batch 用此名，非 start） */
  startDate?: string;
  /** 取数结束日（composite-batch 用此名，非 end） */
  endDate?: string;
  horizons?: number[];
  /** 因子表达式原文（仅表达式系端点） */
  expression?: string;
  /** 请求只数（仅 composite-batch） */
  requested?: number;
  /** 是否含基本面因子族（仅截面） */
  includeFundamental?: boolean;
  /** 是否含事件因子族（仅截面） */
  includeEvents?: boolean;
  /** 取数并发度（仅截面） */
  concurrency?: number;
  /** 截面宽度上限（仅截面） */
  maxCodes?: number;
};

export type ScenarioResult = {
  name: '乐观' | '中性' | '悲观';
  probability: number;
  keyAssumptions: string[];
  targetPriceRange: {
    low: number;
    high: number;
  };
  preconditions: string[];
  /** 支撑该情景的专家论据 */
  supportingArguments: {
    expert: string;
    text: string;
    confidence: number;
  }[];
};

export type ScreenerHit = {
  code: string;
  name: string;
  strategy: string;
  detail: string;
};

export type ScreenerRunResult = {
  at: string;
  /** 实际扫描的股票数 */
  scanned: number;
  /** K 线可用、参与判定的股票数 */
  eligible: number;
  failed: number;
  strategies: string[];
  hits: ScreenerHit[];
  /** 宇宙披露：全市场总数与本次覆盖率（RPS 分位参照范围） */
  universe: {
    total: number;
    coverage: number;
  };
  durationMs?: number;
};

export type SectorRotation = {
  sector: string;
  compositeScore: number;
  rank: number;
  recommendation: 'overweight' | 'neutral' | 'underweight';
  prosperity: number;
  trend: number;
  crowding: number;
  /** 杠杆代理估算，非回归结果 */
  industryBeta: number;
  summary: string;
  date: string;
};

export type SkillId = 'quant_factor' | 'backtest' | 'news' | 'compare' | 'watchlist' | 'chat';

export type SkillRoute = {
  skill: SkillId;
  /** 置信度 0-1（规则命中 0.9，兜底 0.6） */
  confidence: number;
  /** 判定理由（中文） */
  reason: string;
};

export type StockPoolItem = {
  stock_code: string;
  stock_name: string;
  industry: string;
  /** 核心结论摘要 */
  core_summary: string;
  total_score: number;
  rating: string;
  /** 分项评分 */
  score_detail: {
    profit_quality: number;
    growth: number;
    valuation: number;
    industry_boom: number;
    risk_deduction: number;
  };
  strengths: string[];
  risk_list: string[];
  controversy_points: {
    topic: string;
    bullishView: string;
    bearishView: string;
    arbitration: string;
    confidence: number;
  }[];
  finance_metrics: FinancialData;
  valuation: ValuationData;
  /** 估值水位判断 */
  valuation_level: string;
  expert_opinions: ExpertOpinion[];
  reflection_notes: string[];
  chart_list: ChartConfig[];
  follow_up_indicators: string[];
  scenarios?: ScenarioResult[];
  strategyList?: StrategyRecommendation[];
  newsSentiment?: NewsSignal;
  /** 日 K 线；取数失败降级为模拟数据（isSimulated=true） */
  priceHistory?: PriceHistoryPoint[];
  /** 与上次分析的对比（记忆反思闭环） */
  vs_previous?: {
    previous_date: string;
    previous_rating: string;
    previous_score: number;
    score_delta: number;
    rating_changed: boolean;
  };
  /** 本次降级的专家名单（单专家失败不影响整体） */
  degraded_experts?: string[];
  consensus?: ConsensusSnapshot;
  riskAttribution?: {
    exposures: {
      size: number;
      value: number;
      momentum: number;
      profitability: number;
      leverage: number;
    };
    decomposition: {
      systematicVol: number;
      specificVol: number;
      totalVol: number;
      explainedRatio: number;
    };
  };
  sectorRotation?: SectorRotation;
  announcement_brief?: string;
  knowledgeGraphContext?: string;
  mcpContext?: {
    serverUrl: string;
    toolCount: number;
    tools: string[];
  };
  rating_accuracy?: {
    stock: RatingAccuracy;
    overall: RatingAccuracy;
  };
};

export type StockSkip = {
  code: string;
  /** 如「K线不足（12 根）」；中文可直接展示 */
  reason: string;
};

export type StrategyRecommendation = {
  strategyType: string;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalReturn: number;
  applicableMarket: string;
  fatalWeakness: string;
  backtestWarning: string;
  /** 叠加最新消息情绪后的回测对比（仅有新闻时存在） */
  newsAware?: {
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    posture: number;
  };
};

export type TimeseriesAnalyzeResult = {
  test: 'adf' | 'garch' | 'coint' | 'arima' | 'kalman-beta';
  code: string | string[];
  window: {
    startDate: string;
    endDate: string;
    /** 窗口内观测数（双序列按日期对齐后） */
    n: number;
  };
  /** 检验/拟合结果；形状随 test 改变，须按 test 收窄后读取 */
  result: Record<string, unknown>;
  /** adf 作用于价格还是对数收益序列；其余 test 缺省 */
  input?: 'price' | 'return';
  /** 口径提示与注意事项（中文） */
  note?: string;
};

export type TriedCandidate = {
  policy: HarnessPolicy;
  /** 训练集得分；无法评分时为 null */
  trainScore: number | null;
  /** 验证集得分；非最终候选不评验证集时为 null */
  validationScore: number | null;
};

export type TurnoverResult = {
  /** 档号 → 该档平均换手率 ∈ [0,1]（本期新进入该档的标的占比） */
  byQuantile: Record<string, number>;
  /** 因子排序的平均自相关（滞后 lag 个截面） */
  rankAutocorrelation: number;
  /** 参与计算的日期对数 */
  datePairs: number;
};

export type ValuationData = {
  currentPrice: number;
  pe: number;
  pb: number;
  ps: number;
  marketCap: number;
  historicalPE: {
    year: string;
    pe: number;
    isEstimated?: boolean;
  }[];
  peerComparison: {
    name: string;
    code: string;
    pe: number;
    pb: number;
    roe: number;
    marketCap: number;
  }[];
};

export type ValuationModelResult = {
  model: 'two_stage_eps_dcf';
  code: string;
  /** 每股内在价值；DCF 不可算时为 null */
  fairValue: number | null;
  currentPrice: number;
  /** 现价相对内在价值的折溢价 %（正=高估）；fairValue 不可算时为 null */
  upsidePct: number | null;
  /** 两阶段 EPS 贴现结果；不可执行时为 null（原因见 limitations） */
  dcf: {
    fairValue: number;
    /** 显性期现值合计 */
    explicitValue: number;
    /** 终值（未折现） */
    terminalValue: number;
    /** 终值现值 */
    discountedTerminalValue: number;
    /** 逐期现金流 */
    cashFlows: {
      /** 第 t 年（1 起） */
      year: number;
      eps: number;
      /** 1/(1+r)^t */
      discountFactor: number;
      presentValue: number;
    }[];
    assumptions: {
      growthRate1: number;
      explicitYears: number;
      growthRate2: number;
      discountRate: number;
      baseEps: number;
    };
  } | null;
  sensitivity: {
    /** 折现率轴（升序） */
    discountRates: number[];
    /** 显性期增速轴（升序） */
    growthRates1: number[];
    /** [i][j] = r_i × g1_j 下的每股价值；非法假设格为 null */
    matrix: (number | null)[][];
  } | null;
  comparables: ComparableAnalysis;
  /** 实际生效的假设（自动推导的也回传，便于复现） */
  assumptions: {
    /** 基期 EPS；估值模型要求为正数，非正即抛错，故不会是 null */
    baseEps: number;
    /** 显性期增速（小数） */
    growthRate1: number;
    /** input=调用方传入；eps_cagr_3y=由 EPS 3 年 CAGR 钳制推导 */
    growthRate1Source: 'input' | 'eps_cagr_3y';
    /** 永续增速（小数，须 < discountRate） */
    growthRate2: number;
    /** 折现率（小数） */
    discountRate: number;
    /** 显性期年数（1-15） */
    explicitYears: number;
  };
  /** 模型口径与局限（中文，逐条展示） */
  limitations: string[];
};

export type WatchlistAlert = {
  code: string;
  name: string | null;
  level: 'strong-bull' | 'strong-bear' | 'high-impact';
  polarity: number;
  weightedImpact: number;
  detail: string;
};

export type WatchlistCodes = {
  /** 当前自选股代码列表 */
  codes: string[];
};

export type WatchlistMonitorResult = {
  /** 快照时间；从未监控过时为 null（端点仍回 200，不回 404） */
  generatedAt: string | null;
  /** 本次监控的标的数 */
  monitored: number;
  alerts: WatchlistAlert[];
  /** 本轮请求的清单总只数（裁剪前）；仅在发生裁剪时出现 */
  requested?: number;
  /** 因单次上限被跳过、本轮未取数的只数；仅在发生裁剪时出现 */
  skipped?: number;
};

export type WatchlistNewsBacktestReport = {
  generatedAt: string;
  /** 参与回测的代码数 */
  count: number;
  /** 其中命中最新消息的代码数 */
  withNewsCount: number;
  /** 本轮请求的原始只数（含格式非法被 normalizeAShareCode 丢掉的） */
  requested?: number;
  /** 因单次上限（本端点 >20 直接 400，此处为服务层默认上限）被跳过的只数 */
  skipped?: number;
  results: {
    code: string;
    /** 无主数据时为 null */
    name: string | null;
    /** 无新闻（或该只取数失败）时缺省或为 null */
    newsSentiment?: NewsSignal | null;
    strategyList: StrategyRecommendation[];
    /** 按 sharpeRatio 选出的最优策略；strategyList 为空时缺省 */
    bestStrategy?: {
      strategyType: string;
      totalReturn: number;
      sharpeRatio: number;
      maxDrawdown: number;
      winRate: number;
      /** 叠加最新消息后的回测对比（仅有新闻时存在） */
      newsAware?: {
        totalReturn: number;
        sharpeRatio: number;
        maxDrawdown: number;
        winRate: number;
        posture: number;
      };
    };
    /** K 线是否含降级的模拟数据 */
    simulatedKline: boolean;
    /** 该只失败原因；成功时缺省 */
    error?: string;
  }[];
};

// ===== operations =====

/**
 * 单股多专家研判
 * POST/PUT 等请求体
 * 端点：POST /api/analyze
 */
export type POSTApiAnalyzeRequestBody = {
  /**
   * 6 位 A 股股票代码，如 600519
   * 约束：需匹配 ^\d{6}$
   */
  stockCode: string;
};

/**
 * 单股多专家研判
 * 8 位专家独立研判 + 辩论仲裁 + 量化打分 + 策略回测。耗时约 1-3 分钟。
 * 成功响应（HTTP 200）
 * 端点：POST /api/analyze
 */
export type POSTApiAnalyzeResponse = AnalysisResult;

/**
 * 流式分析（SSE）
 * 以 text/event-stream 逐阶段推送分析进度（data/experts/arbitration/scoring/strategy/done）。
 * 成功响应（HTTP 200）
 * 端点：GET /api/analyze/stream
 */
export type GETApiAnalyzeStreamResponse = string;

/**
 * 流式分析（SSE）
 * 路径/查询参数
 * 端点：GET /api/analyze/stream
 */
export type GETApiAnalyzeStreamParams = {
  /** 约束：需匹配 ^\d{6}$ */
  stockCode: string;
};

/**
 * 合规审计查询（金融监管 8 号文）
 * 成功响应（HTTP 200）
 * 端点：GET /api/audit
 */
export type GETApiAuditResponse = {
  /** 匹配条目总数（不受 limit/offset 影响，分页时也用它算总页数） */
  count: number;
  /** 本页条目；offset 越界时为空数组（据此判断「没有更多」） */
  entries: AuditEntry[];
};

/**
 * 合规审计查询（金融监管 8 号文）
 * 路径/查询参数
 * 端点：GET /api/audit
 */
export type GETApiAuditParams = {
  category?: string;
  riskLevel?: string;
  startTime?: number;
  endTime?: number;
  sessionId?: string;
  /**
   * 本页条数上限（>= 0 的整数）；不传则返回全部分页
   * 约束：最小 0
   */
  limit?: number;
  /**
   * 起始偏移（>= 0 的整数）；不传则从第一条开始，与 limit 均不传时返回全部
   * 约束：最小 0
   */
  offset?: number;
};

/**
 * 启动自治监控循环
 * POST/PUT 等请求体
 * 端点：POST /api/autonomous/start
 */
export type POSTApiAutonomousStartRequestBody = {
  /**
   * 轮询间隔，夹紧到 [30 秒, 24 小时]，默认 5 分钟
   * 约束：最小 30000；最大 86400000
   */
  intervalMs?: number;
};

/**
 * 启动自治监控循环
 * 连续失败指数退避（封顶 8 倍），连续失败 10 次自动停止。
 * 成功响应（HTTP 200）
 * 端点：POST /api/autonomous/start
 */
export type POSTApiAutonomousStartResponse = {
  /** 恒为 true（启动成功才走到这行） */
  started: boolean;
  /** 循环是否在运行（连续失败达上限会自动置 false） */
  running: boolean;
  /** 当前生效的轮询间隔（毫秒，已夹紧到 [30 秒, 24 小时]） */
  intervalMs: number;
  /** 最近一轮完成时间（ISO）；尚未跑完一轮时缺省 */
  lastRunAt?: string;
  /** 最近一轮检出的异动预警条数 */
  lastAlertCount: number;
  /** 已发起的监控轮次（含失败轮次） */
  runCount: number;
  /** 失败轮次数 */
  errorCount: number;
  /** 最近一次失败原因；无失败时缺省 */
  lastError?: string;
  /** 本轮请求的清单总只数（裁剪前） */
  requested?: number;
  /** 因单次上限被跳过、本轮未取数的只数 */
  skipped?: number;
};

/**
 * 自治循环状态
 * 成功响应（HTTP 200）
 * 端点：GET /api/autonomous/status
 */
export type GETApiAutonomousStatusResponse = {
  /** 循环是否在运行（连续失败达上限会自动置 false） */
  running: boolean;
  /** 当前生效的轮询间隔（毫秒，已夹紧到 [30 秒, 24 小时]） */
  intervalMs?: number;
  /** 最近一轮完成时间（ISO）；尚未跑完一轮时缺省 */
  lastRunAt?: string;
  /** 最近一轮检出的异动预警条数 */
  lastAlertCount?: number;
  /** 已发起的监控轮次（含失败轮次） */
  runCount?: number;
  /** 失败轮次数 */
  errorCount?: number;
  /** 最近一次失败原因；无失败时缺省 */
  lastError?: string;
  /** 本轮请求的清单总只数（裁剪前） */
  requested?: number;
  /** 因单次上限被跳过、本轮未取数的只数 */
  skipped?: number;
};

/**
 * 停止自治监控循环
 * 成功响应（HTTP 200）
 * 端点：POST /api/autonomous/stop
 */
export type POSTApiAutonomousStopResponse = {
  /** 恒为 true（未在运行也回 true，属幂等停止） */
  stopped: boolean;
  /** 最近一轮检出的预警（进程内缓存，重启即空；从未预警过时为空数组） */
  lastAlerts: WatchlistAlert[];
};

/**
 * 受控评估：新闻叠加 vs 基线
 * POST/PUT 等请求体
 * 端点：POST /api/backtest/evaluate
 */
export type POSTApiBacktestEvaluateRequestBody = {
  /**
   * 6 位 A 股股票代码，如 600519
   * 约束：需匹配 ^\d{6}$
   */
  stockCode: string;
  /** 策略名，默认 ma_cross */
  strategy?: string;
  /**
   * 默认近两年
   * 约束：格式 date
   */
  startDate?: string;
  /**
   * 默认今天
   * 约束：格式 date
   */
  endDate?: string;
};

/**
 * 受控评估：新闻叠加 vs 基线
 * 配对 t 检验 / Block Bootstrap CI / Deflated Sharpe Ratio，量化新闻信号是否真增 alpha。
 * 成功响应（HTTP 200）
 * 端点：POST /api/backtest/evaluate
 */
export type POSTApiBacktestEvaluateResponse = BacktestEvaluation;

/**
 * 自然语言研究助手
 * POST/PUT 等请求体
 * 端点：POST /api/chat
 */
export type POSTApiChatRequestBody = {
  /** 约束：最长 2000 */
  message: string;
  /** 会话历史。role 非法（非 user/assistant）或 content 非字符串**直接 400**；条数/单条/总字符超限则夹紧（最近 N 条、超长截断），不报错 */
  history?: {
    role: 'user' | 'assistant';
    content: string;
  }[];
  stockCode?: string;
  /** 会话级记忆 ID */
  sessionId?: string;
};

/**
 * 自然语言研究助手
 * 路由规划 / 工具调用 / 多空辩论 / 证据引用与事实校验。
 * 成功响应（HTTP 200）
 * 端点：POST /api/chat
 */
export type POSTApiChatResponse = ChatAgentResponse;

/**
 * 清空会话持久记忆
 * POST/PUT 等请求体
 * 端点：POST /api/chat/history/clear
 */
export type POSTApiChatHistoryClearRequestBody = {
  sessionId: string;
};

/**
 * 清空会话持久记忆
 * 成功响应（HTTP 200）
 * 端点：POST /api/chat/history/clear
 */
export type POSTApiChatHistoryClearResponse = OkResult;

/**
 * 流式对话（SSE）
 * 逐阶段推送执行进度（planning/retrieving/tool_calling/debating/verifying/done）。
 * 成功响应（HTTP 200）
 * 端点：GET /api/chat/stream
 */
export type GETApiChatStreamResponse = string;

/**
 * 流式对话（SSE）
 * 路径/查询参数
 * 端点：GET /api/chat/stream
 */
export type GETApiChatStreamParams = {
  /** 约束：最长 2000 */
  message: string;
  sessionId?: string;
};

/**
 * 2-3 只股票横向对比
 * POST/PUT 等请求体
 * 端点：POST /api/compare
 */
export type POSTApiCompareRequestBody = {
  /** 约束：最少 2 项；最多 3 项 */
  stockCodes: string[];
};

/**
 * 2-3 只股票横向对比
 * 成功响应（HTTP 200）
 * 端点：POST /api/compare
 */
export type POSTApiCompareResponse = CompareResponse;

/**
 * LLM 成本报告
 * 成功响应（HTTP 200）
 * 端点：GET /api/cost
 */
export type GETApiCostResponse = CostReport;

/**
 * 重置 LLM 成本账本
 * 成功响应（HTTP 200）
 * 端点：POST /api/cost/reset
 */
export type POSTApiCostResetResponse = OkResult;

/**
 * 已入库文档列表（含预览）
 * 成功响应（HTTP 200）
 * 端点：GET /api/documents
 */
export type GETApiDocumentsResponse = DocumentList;

/**
 * 健康检查（外部 API 可达性 + 缓存目录）
 * 外呼探测带 60 秒 memo（HEALTH_PROBE_MEMO_MS 可覆盖，0=关闭）且并发合流；响应中的 cached/checkedAt 如实标注结论来自缓存还是本次探测。GET 只读，不创建目录。
 * 成功响应（HTTP 200）
 * 端点：GET /api/health
 */
export type GETApiHealthResponse = HealthReport;

/**
 * 研究历史列表（倒序摘要，不含完整结果）
 * 成功响应（HTTP 200）
 * 端点：GET /api/history
 */
export type GETApiHistoryResponse = {
  /** 历史摘要（按 createdAt 倒序；不含完整 result） */
  items: HistorySummary[];
};

/**
 * 研究历史列表（倒序摘要，不含完整结果）
 * 路径/查询参数
 * 端点：GET /api/history
 */
export type GETApiHistoryParams = {
  /** 返回条数上限（1-200） */
  limit?: number;
};

/**
 * 删除一条研究历史
 * 成功响应（HTTP 200）
 * 端点：DELETE /api/history/{id}
 */
export type DELETEApiHistoryIdResponse = {
  /** 恒为 true（不存在时回 404，不会出现 false） */
  deleted: boolean;
};

/**
 * 删除一条研究历史
 * 路径/查询参数
 * 端点：DELETE /api/history/{id}
 */
export type DELETEApiHistoryIdParams = {
  id: string;
};

/**
 * 研究历史详情（含完整分析结果，可恢复研究报告）
 * 成功响应（HTTP 200）
 * 端点：GET /api/history/{id}
 */
export type GETApiHistoryIdResponse = HistoryItem;

/**
 * 研究历史详情（含完整分析结果，可恢复研究报告）
 * 路径/查询参数
 * 端点：GET /api/history/{id}
 */
export type GETApiHistoryIdParams = {
  id: string;
};

/**
 * 改进轮次历史（倒序）
 * 成功响应（HTTP 200）
 * 端点：GET /api/improvement/history
 */
export type GETApiImprovementHistoryResponse = {
  /** 实际生效的条数上限（>200 会被夹到 200） */
  limit: number;
  /** 改进轮次记录（按 createdAt 倒序） */
  items: ImprovementRecord[];
};

/**
 * 改进轮次历史（倒序）
 * 路径/查询参数
 * 端点：GET /api/improvement/history
 */
export type GETApiImprovementHistoryParams = {
  limit?: number;
};

/**
 * 手动跑一轮改进（dryRun=true 时只评估不落盘）
 * POST/PUT 等请求体
 * 端点：POST /api/improvement/run
 */
export type POSTApiImprovementRunRequestBody = {
  dryRun?: boolean;
};

/**
 * 手动跑一轮改进（dryRun=true 时只评估不落盘）
 * 成功响应（HTTP 200）
 * 端点：POST /api/improvement/run
 */
export type POSTApiImprovementRunResponse = ImprovementRunResult;

/**
 * 启动改进闭环的周期调度（无人值守）
 * POST/PUT 等请求体
 * 端点：POST /api/improvement/scheduler/start
 */
export type POSTApiImprovementSchedulerStartRequestBody = {
  intervalHours?: number;
};

/**
 * 启动改进闭环的周期调度（无人值守）
 * intervalHours 未传时回落 harness policy 的默认间隔。
 * 成功响应（HTTP 200）
 * 端点：POST /api/improvement/scheduler/start
 */
export type POSTApiImprovementSchedulerStartResponse = {
  /** 是否真的注册了定时器；env 显式关闭（IMPROVEMENT_INTERVAL_HOURS=0）且未传 intervalHours 时路由回 400，因此 200 下恒为 true */
  started: boolean;
  /** 调度状态；started=false 时为 null */
  scheduler: ImprovementLoopState | null;
};

/**
 * 停止改进闭环的周期调度
 * 成功响应（HTTP 200）
 * 端点：POST /api/improvement/scheduler/stop
 */
export type POSTApiImprovementSchedulerStopResponse = {
  /** 恒为 true（未在运行也回 true，属幂等停止） */
  stopped: boolean;
  /** 停止后恒为 null（不假装还有调度器在跑） */
  scheduler: null;
};

/**
 * 改进闭环状态（harness policy + 台账汇总）
 * 成功响应（HTTP 200）
 * 端点：GET /api/improvement/status
 */
export type GETApiImprovementStatusResponse = ImprovementStatus;

/**
 * 研报/公告入库（文本或 PDF Base64）
 * POST/PUT 等请求体
 * 端点：POST /api/ingest
 */
export type POSTApiIngestRequestBody = {
  title: string;
  text?: string;
  /** 与 text 二选一 */
  pdfBase64?: string;
};

/**
 * 研报/公告入库（文本或 PDF Base64）
 * 洞察抽取（利好/风险/催化剂）→ 注入 RAG 检索库。
 * 成功响应（HTTP 200）
 * 端点：POST /api/ingest
 */
export type POSTApiIngestResponse = {
  /** 文档 ID（`ingested:<时间戳>`，内存态不落盘） */
  id: string;
  /** 回显的标题（已 trim 并截断到 200 字符） */
  title: string;
  /** 恒为 true（失败走 500，不会出现 false） */
  ingested: boolean;
  insight: DocumentInsight;
};

/**
 * 港美股财务估值（东财 datacenter RPT 网关）
 * 成功响应（HTTP 200）
 * 端点：GET /api/intl/fundamentals
 */
export type GETApiIntlFundamentalsResponse = IntlFundamentalsResult;

/**
 * 港美股财务估值（东财 datacenter RPT 网关）
 * 路径/查询参数
 * 端点：GET /api/intl/fundamentals
 */
export type GETApiIntlFundamentalsParams = {
  code: string;
  market?: 'HK' | 'US';
};

/**
 * 港美股 K 线（默认近 2 年）
 * 仅港/美股；A 股代码请走量化/行情既有接口，传入会返回 400 而非误导性数据。
 * 成功响应（HTTP 200）
 * 端点：GET /api/intl/klines
 */
export type GETApiIntlKlinesResponse = {
  /** 归一后的证券代码 */
  code: string;
  market: 'HK' | 'US';
  /** 实际生效的起始日 YYYY-MM-DD（未传则默认近 2 年） */
  startDate: string;
  /** 实际生效的结束日 YYYY-MM-DD（未传则今天） */
  endDate: string;
  /** klines 条数（= 返回的 K 线根数） */
  count: number;
  /** 日 K 线（升序）；取数失败时为空数组而非报错 */
  klines: IntlKline[];
};

/**
 * 港美股 K 线（默认近 2 年）
 * 路径/查询参数
 * 端点：GET /api/intl/klines
 */
export type GETApiIntlKlinesParams = {
  code: string;
  market: 'HK' | 'US';
  startDate?: string;
  endDate?: string;
};

/**
 * 模型权重（校准结果）
 * 成功响应（HTTP 200）
 * 端点：GET /api/llm/calibration
 */
export type GETApiLlmCalibrationResponse = {
  /** 模型 ID → 权重（Laplace 平滑命中率，下限 1/3） */
  weights: Record<string, number>;
};

/**
 * 记录一次模型判断的验证结果（correct = 事后被验证正确）
 * POST/PUT 等请求体
 * 端点：POST /api/llm/calibration
 */
export type POSTApiLlmCalibrationRequestBody = {
  model: string;
  correct?: boolean;
};

/**
 * 记录一次模型判断的验证结果（correct = 事后被验证正确）
 * 成功响应（HTTP 200）
 * 端点：POST /api/llm/calibration
 */
export type POSTApiLlmCalibrationResponse = {
  /** 恒为 true（记录成功才走到这行） */
  ok: boolean;
  /** 记录后的模型权重快照（同 GET /api/llm/calibration） */
  weights: Record<string, number>;
};

/**
 * 多模型集成调用（可指定 models / temperature / maxTokens）
 * POST/PUT 等请求体
 * 端点：POST /api/llm/ensemble
 */
export type POSTApiLlmEnsembleRequestBody = {
  messages: Record<string, unknown>[];
  /** 约束：最多 5 项 */
  models?: string[];
  task?: string;
  temperature?: number;
  maxTokens?: number;
};

/**
 * 多模型集成调用（可指定 models / temperature / maxTokens）
 * models 最多 5 个；temperature / maxTokens 越界时**夹紧到上限**并在服务端日志记录原值（不报错），因此客户端不会因边界值直接失败。
 * 成功响应（HTTP 200）
 * 端点：POST /api/llm/ensemble
 */
export type POSTApiLlmEnsembleResponse = EnsembleResult;

/**
 * 技能路由（给定一句话判定该走哪个专用技能）
 * 规则表判定，确定性输出，不调用模型。
 * 成功响应（HTTP 200）
 * 端点：GET /api/llm/skills
 */
export type GETApiLlmSkillsResponse = SkillRoute;

/**
 * 技能路由（给定一句话判定该走哪个专用技能）
 * 路径/查询参数
 * 端点：GET /api/llm/skills
 */
export type GETApiLlmSkillsParams = {
  message?: string;
};

/**
 * Prometheus 指标（文本格式 0.0.4）
 * HTTP 请求计数/耗时直方图、进程内存、LLM 成本、熔断器状态。
 * 成功响应（HTTP 200）
 * 端点：GET /api/metrics
 */
export type GETApiMetricsResponse = string;

/**
 * 多模型注册表与任务路由
 * 成功响应（HTTP 200）
 * 端点：GET /api/models
 */
export type GETApiModelsResponse = ModelRoutingInfo;

/**
 * 本 OpenAPI 规范文档
 * 成功响应（HTTP 200）
 * 端点：GET /api/openapi.json
 */
export type GETApiOpenapiJsonResponse = Record<string, unknown>;

/**
 * 模拟下单（市价/限价，A 股规则撮合）
 * POST/PUT 等请求体
 * 端点：POST /api/paper/order
 */
export type POSTApiPaperOrderRequestBody = {
  /**
   * 6 位 A 股股票代码，如 600519
   * 约束：需匹配 ^\d{6}$
   */
  code: string;
  side: 'buy' | 'sell';
  type?: 'market' | 'limit';
  /** 限价单必填 */
  price?: number;
  /** 股数（向下取整到 100 股整数倍） */
  quantity: number;
  /**
   * 可选：切换当前交易日
   * 约束：格式 date
   */
  date?: string;
};

/**
 * 模拟下单（市价/限价，A 股规则撮合）
 * T+1 / 主板 ±10% 涨跌停拒单 / 整手 100 股 / 佣金万三 + 卖出印花税 0.1%。
 * 成功响应（HTTP 200）
 * 端点：POST /api/paper/order
 */
export type POSTApiPaperOrderResponse = {
  order: PaperOrder;
};

/**
 * 模拟盘账户：现金 / 持仓 / 订单 / 每日净值
 * 成功响应（HTTP 200）
 * 端点：GET /api/paper/portfolio
 */
export type GETApiPaperPortfolioResponse = PaperPortfolio;

/**
 * 日终结算：收盘价撮合挂单 + 记录当日净值
 * POST/PUT 等请求体
 * 端点：POST /api/paper/settle
 */
export type POSTApiPaperSettleRequestBody = {
  /** 约束：格式 date */
  date: string;
  /** 代码 → 当日收盘价 */
  closePrices: Record<string, number>;
  /** 代码 → 昨收（用于涨跌停判定） */
  prevClosePrices?: Record<string, number>;
};

/**
 * 日终结算：收盘价撮合挂单 + 记录当日净值
 * 成功响应（HTTP 200）
 * 端点：POST /api/paper/settle
 */
export type POSTApiPaperSettleResponse = {
  date: string;
  cash: number;
  /** 当日净值点；无新增点时为 undefined（JSON 中缺省） */
  latestEquity?: PaperEquityPoint | null;
  history: PaperEquityPoint[];
};

/**
 * 累计收益 / 最大回撤 / 年化夏普
 * 成功响应（HTTP 200）
 * 端点：GET /api/paper/stats
 */
export type GETApiPaperStatsResponse = PaperStats;

/**
 * 量化研究（回测 + 数据质量 + 审计 + 优化 + 摘要）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/analyze
 */
export type POSTApiQuantAnalyzeRequestBody = {
  /** 策略配置对象或策略名（ma_cross/rsi_mean_reversion 等） */
  strategy: unknown;
  /** 是否实时抓取新闻情绪叠加回测 */
  useNews?: boolean;
  /** 用户粘贴的新闻条目（优先于实时抓取） */
  newsItems?: {
    id?: string;
    title?: string;
    summary?: string;
    /** 约束：格式 date-time */
    publishedAt?: string;
    polarity?: number;
  }[];
};

/**
 * 量化研究（回测 + 数据质量 + 审计 + 优化 + 摘要）
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/analyze
 */
export type POSTApiQuantAnalyzeResponse = QuantReport;

/**
 * 个股公告列表 / 单篇公告全文
 * 带 artCode 时返回该篇全文；否则按 6 位 A 股代码返回公告列表。
 * 成功响应（HTTP 200）
 * 端点：GET /api/quant/announcements
 */
export type GETApiQuantAnnouncementsResponse =
  | AnnouncementListResult
  | {
      /** 请求的公告 art_code（回显） */
      artCode: string;
      /** 公告正文（纯文本；PDF 公告上游可能返回空串） */
      content: string;
    };

/**
 * 个股公告列表 / 单篇公告全文
 * 路径/查询参数
 * 端点：GET /api/quant/announcements
 */
export type GETApiQuantAnnouncementsParams = {
  /** 约束：需匹配 ^\d{6}$ */
  code?: string;
  artCode?: string;
  pageSize?: number;
};

/**
 * 研究简报列表（倒序）
 * 成功响应（HTTP 200）
 * 端点：GET /api/quant/digests
 */
export type GETApiQuantDigestsResponse = {
  /** 研究简报（按 createdAt 倒序，上限 60 条） */
  items: ResearchDigest[];
};

/**
 * 研究简报列表（倒序）
 * 路径/查询参数
 * 端点：GET /api/quant/digests
 */
export type GETApiQuantDigestsParams = {
  limit?: number;
};

/**
 * 手动触发一份研究简报
 * 与定时任务（QUANT_DIGEST_INTERVAL_HOURS，默认关闭）共用同一落盘。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/digests/run
 */
export type POSTApiQuantDigestsRunResponse = ResearchDigest;

/**
 * 多因子加权组合 alpha（单只股票，时间序列 IC 口径）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/factor/composite
 */
export type POSTApiQuantFactorCompositeRequestBody = {
  /** 股票代码（A 股6位 / 美股字母 / 港股5位） */
  stockCode: string;
  /**
   * 默认近两年
   * 约束：格式 date
   */
  startDate?: string;
  /**
   * 默认今天
   * 约束：格式 date
   */
  endDate?: string;
  /**
   * 持有期档位（交易日）：1-504 的整数，最多 8 档，缺省 [21, 63]；非法即 400
   * 约束：最少 1 项；最多 8 项
   */
  horizons?: number[];
};

/**
 * 多因子加权组合 alpha（单只股票，时间序列 IC 口径）
 * 拉取单只股票 K 线与市场基准（按市场选沪深300/标普500/恒生），计算各量价因子对自身远期收益的时间序列 IC（21/63 交易日），再按 |t| 置信度加权方向校正 IC 合成方向性组合 alpha。不跑回测/数据质量/审计/优化，适合批量测算单标的的方向性信号。市场基准拉取失败时优雅降级（Beta 类因子不参与加权）。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/factor/composite
 */
export type POSTApiQuantFactorCompositeResponse = CompositeAlphaResult;

/**
 * 批量多因子加权组合 alpha（多只股票）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/factor/composite/batch
 */
export type POSTApiQuantFactorCompositeBatchRequestBody = {
  /** 股票代码数组（最多 20 个，自动去重） */
  stockCodes: string[];
  /**
   * 默认近两年
   * 约束：格式 date
   */
  startDate?: string;
  /**
   * 默认今天
   * 约束：格式 date
   */
  endDate?: string;
  /**
   * 持有期档位（交易日）：1-504 的整数，最多 8 档，缺省 [21, 63]；非法即 400
   * 约束：最少 1 项；最多 8 项
   */
  horizons?: number[];
};

/**
 * 批量多因子加权组合 alpha（多只股票）
 * 一次请求测算多只股票的方向性组合 alpha，参数与单只端点一致（K 线 + 市场基准 → 时间序列 IC → 组合 alpha）。代码按首次出现顺序去重、并发度受限（默认 4、上限 8）；单只失败（无 K 线 / 网络异常）只标记该项 ok:false，其余照常返回，结果按输入顺序排列。市场基准可用环境变量覆盖：QUANT_BENCHMARK_SECID_A / _US / _HK（如美股改纳指100 `100.NDX`、A 股改中证500 `1.000905`），留空则回落内置默认。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/factor/composite/batch
 */
export type POSTApiQuantFactorCompositeBatchResponse = CompositeAlphaBatchResult & {
  run: RunSnapshot;
  preflight: Preflight;
};

/**
 * 因子截面评估（IC / 分层收益 / 多空组合）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/factor/cross-section
 */
export type POSTApiQuantFactorCrossSectionRequestBody = {
  codes?: string[];
  board?: string;
  topN?: number;
  /**
   * 持有期档位（交易日）：1-504 的整数，最多 8 档，缺省 [21, 63]；非法即 400
   * 约束：最少 1 项；最多 8 项
   */
  horizons?: number[];
  includeFundamental?: boolean;
  includeEvents?: boolean;
  includeMargin?: boolean;
  portfolio?: Record<string, unknown>;
};

/**
 * 因子截面评估（IC / 分层收益 / 多空组合）
 * 可选 universe（codes 或 board）、topN、horizons；includeFundamental/Events/Margin 为按需叠加的因子族，portfolio=true 时为每个因子附带 top-N 等权周期调仓回测。indexUniverse 走 Baostock sidecar 取指数历史成分（point-in-time）。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/factor/cross-section
 */
export type POSTApiQuantFactorCrossSectionResponse = CrossSectionResult;

/**
 * 单因子评估 tear sheet（IC 显著性 / 分层回测 / 换手率 / alpha-beta）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/factor/evaluate
 */
export type POSTApiQuantFactorEvaluateRequestBody = {
  /** 因子观测面板：{ date(YYYY-MM-DD), symbol?, value, returns: { [持有期]: 收益 }, marketCap?, group?, weight? } */
  observations: Record<string, unknown>[];
  /** 评估参数：quantiles(默认5)、maxLoss(默认0.25)、neutralize、winsorize、periods、lag(默认1)、demeaned、groupAdjust */
  options?: Record<string, unknown>;
};

/**
 * 单因子评估 tear sheet（IC 显著性 / 分层回测 / 换手率 / alpha-beta）
 * 输入截面面板（多标的 × 多交易日），方法学对齐 alphalens / qlib。返回逐持有期的 IC 均值、IR、t 统计量与双侧 p 值，各分位收益与多空价差、单调性，因子换手率与排序自相关，以及因子加权多空组合的年化 alpha / beta；并附「是否采信」判定（IC 显著 + 分层单调 + 多空价差为正三者同时成立）。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/factor/evaluate
 */
export type POSTApiQuantFactorEvaluateResponse = FactorEvaluationReport;

/**
 * 因子实验台账（列出 + 汇总）
 * 成功响应（HTTP 200）
 * 端点：GET /api/quant/factor/experiments
 */
export type GETApiQuantFactorExperimentsResponse = {
  /** 台账条目（按 createdAt 倒序，受 source/kept/limit 过滤） */
  items: FactorExperiment[];
  /** 全量台账概览（不受上述过滤影响） */
  summary: FactorExperimentSummary;
};

/**
 * 因子实验台账（列出 + 汇总）
 * 路径/查询参数
 * 端点：GET /api/quant/factor/experiments
 */
export type GETApiQuantFactorExperimentsParams = {
  source?: string;
  kept?: boolean;
  limit?: number;
};

/**
 * 补录因子实验（外部脚本/离线评估的结论也能进台账）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/factor/experiments
 */
export type POSTApiQuantFactorExperimentsRequestBody = {
  /** 约束：最少 1 项；最多 200 项 */
  entries: Record<string, unknown>[];
};

/**
 * 补录因子实验（外部脚本/离线评估的结论也能进台账）
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/factor/experiments
 */
export type POSTApiQuantFactorExperimentsResponse = {
  /** 实际写入的台账条数。**写盘失败时为 0**（台账是研究资产不是数据源，记录失败不阻断主流程） */
  recorded: number;
};

/**
 * 自定义因子表达式评估（受限 DSL，不执行模型生成的代码）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/factor/expression
 */
export type POSTApiQuantFactorExpressionRequestBody = {
  /** 因子表达式（白名单 DSL） */
  expression: string;
  name?: string;
  board?: string;
  codes?: string[];
  topN?: number;
  /**
   * 持有期档位（交易日）：1-504 的整数，最多 8 档，缺省 [21, 63]；非法即 400
   * 约束：最少 1 项；最多 8 项
   */
  horizons?: number[];
  portfolio?: Record<string, unknown>;
  /** YYYY-MM-DD */
  startDate?: string;
  /** YYYY-MM-DD */
  endDate?: string;
};

/**
 * 自定义因子表达式评估（受限 DSL，不执行模型生成的代码）
 * LLM 生成假设或手输表达式 → parseFactorExpression 解析为白名单语法 AST → 截面评估器验证 → 台账留痕。关键点：**不 eval 任何模型产出的代码**，因此没有沙箱逃逸面。startDate/endDate 未传时沿用 730 天默认窗口。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/factor/expression
 */
export type POSTApiQuantFactorExpressionResponse = FactorExpressionResult;

/**
 * 批量因子假设验证（多表达式一次测算）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/factor/expression/batch
 */
export type POSTApiQuantFactorExpressionBatchRequestBody = {
  expressions: Record<string, unknown>[];
  board?: string;
  topN?: number;
  /**
   * 持有期档位（交易日）：1-504 的整数，最多 8 档，缺省 [21, 63]；非法即 400
   * 约束：最少 1 项；最多 8 项
   */
  horizons?: number[];
};

/**
 * 批量因子假设验证（多表达式一次测算）
 * 逐条评估并汇总 ok 计数；results 内每条带 stocksIncluded / stocksSkipped。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/factor/expression/batch
 */
export type POSTApiQuantFactorExpressionBatchResponse = FactorExpressionBatchResult;

/**
 * 量化侧上游预检（行情源 / LLM / 缓存 / 增强通道）
 * 动手前先判「行情源通不通 / LLM 配没配 / 缓存有没有」，避免用户干等超时后只拿到一句没有行动指引的 502。tushare / baostock 为可选增强通道，未配置或失败都如实降级披露，不影响 preflight.ok。
 * 成功响应（HTTP 200）
 * 端点：GET /api/quant/health
 */
export type GETApiQuantHealthResponse = Preflight & {
  /** Tushare 增强通道（退市股名单/主表，24h 缓存）。未配置时只有 configured:false */
  tushare: {
    /** 是否配置了 Tushare token */
    configured: boolean;
    /** 主表股票总数；取到时出现 */
    total?: number;
    /** 上市（L）只数 */
    listed?: number;
    /** 退市（D）只数 */
    delisted?: number;
    /** 暂停上市（P）只数 */
    suspended?: number;
    /** 已配置但取数失败（原因在 detail，不在响应里回传） */
    degraded?: boolean;
  };
  /** Baostock sidecar 通道（指数历史成分，Python 子进程） */
  baostock: {
    /** sidecar 是否可用 */
    available: boolean;
    /** 最近一次 hs300 成分数；可用时出现 */
    hs300Count?: number;
    /** 成分快照的实际调仓日；可用时出现 */
    updateDate?: string | null;
    /** 解释器路径（PYTHON_BIN 或 python） */
    python: string;
    /** 不可用原因；available=false 时出现 */
    detail?: string;
  };
};

/**
 * 个股研究记忆（历史结论与追踪指标）
 * 成功响应（HTTP 200）
 * 端点：GET /api/quant/research-memory/{code}
 */
export type GETApiQuantResearchMemoryCodeResponse = ResearchMemory;

/**
 * 个股研究记忆（历史结论与追踪指标）
 * 路径/查询参数
 * 端点：GET /api/quant/research-memory/{code}
 */
export type GETApiQuantResearchMemoryCodeParams = {
  /**
   * 6 位 A 股代码
   * 约束：需匹配 ^\d{6}$
   */
  code: string;
};

/**
 * 最近一次初筛结果（无人值守运行后回看）
 * 成功响应（HTTP 200）
 * 端点：GET /api/quant/screener/latest
 */
export type GETApiQuantScreenerLatestResponse = ScreenerRunResult;

/**
 * 全市场初筛（长任务，客户端提前断开则级联中止在途取数）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/screener/run
 */
export type POSTApiQuantScreenerRunRequestBody = {
  maxStocks?: number;
  /** YYYY-MM-DD */
  startDate?: string;
  /** YYYY-MM-DD */
  endDate?: string;
};

/**
 * 全市场初筛（长任务，客户端提前断开则级联中止在途取数）
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/screener/run
 */
export type POSTApiQuantScreenerRunResponse = ScreenerRunResult;

/**
 * 时间序列因子分析（时序 IC / 滚动稳定性）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/timeseries/analyze
 */
export type POSTApiQuantTimeseriesAnalyzeRequestBody = Record<string, unknown>;

/**
 * 时间序列因子分析（时序 IC / 滚动稳定性）
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/timeseries/analyze
 */
export type POSTApiQuantTimeseriesAnalyzeResponse = TimeseriesAnalyzeResult;

/**
 * 行业板块列表（横截面选股 universe 的可选范围）
 * 东财新旧两套行业体系并存（银行 / 银行Ⅱ / 国有大型银行Ⅲ），已滤掉名称以 Ⅱ/Ⅲ 结尾的旧体系子级，只保留现行一级板块（纯降噪：这些代码本身仍可直接请求）。上游失败但磁盘有快照时返回 stale=true 与 staleAgeMs，如实披露这是陈旧快照。
 * 成功响应（HTTP 200）
 * 端点：GET /api/quant/universe/boards
 */
export type GETApiQuantUniverseBoardsResponse = {
  /** 现行一级行业板块（已滤掉名称以 Ⅱ/Ⅲ 结尾的旧体系子级） */
  boards: IndustryBoard[];
  /** 上游失败但磁盘有快照时为 true（如实披露这是陈旧快照） */
  stale?: true;
  /** 陈旧快照的年龄（毫秒）；仅 stale 时出现 */
  staleAgeMs?: number;
};

/**
 * 估值建模（DCF / 相对估值，假设可覆盖默认值）
 * POST/PUT 等请求体
 * 端点：POST /api/quant/valuation/model
 */
export type POSTApiQuantValuationModelRequestBody = {
  /**
   * 6 位 A 股股票代码，如 600519
   * 约束：需匹配 ^\d{6}$
   */
  code: string;
  assumptions?: {
    growthRate1?: number;
    growthRate2?: number;
    discountRate?: number;
    explicitYears?: number;
    baseEps?: number;
  };
};

/**
 * 估值建模（DCF / 相对估值，假设可覆盖默认值）
 * assumptions 可覆盖 growthRate1/2、discountRate、explicitYears、baseEps；非有限数值的项被忽略并回落默认值（不是报错）。
 * 成功响应（HTTP 200）
 * 端点：POST /api/quant/valuation/model
 */
export type POSTApiQuantValuationModelResponse = ValuationModelResult;

/**
 * 已缓存股票列表
 * 成功响应（HTTP 200）
 * 端点：GET /api/stocks
 */
export type GETApiStocksResponse = {
  code: string;
  name: string;
  industry: string;
}[];

/**
 * 股票模糊搜索
 * 东方财富 suggest 为主，空结果回退本地全表模糊匹配（支持全称/子串/代码）。
 * 成功响应（HTTP 200）
 * 端点：GET /api/stocks/search
 */
export type GETApiStocksSearchResponse = {
  code: string;
  name: string;
}[];

/**
 * 股票模糊搜索
 * 路径/查询参数
 * 端点：GET /api/stocks/search
 */
export type GETApiStocksSearchParams = {
  keyword: string;
};

/**
 * 获取自选股清单
 * 成功响应（HTTP 200）
 * 端点：GET /api/watchlist
 */
export type GETApiWatchlistResponse = WatchlistCodes;

/**
 * 添加自选股（去重）
 * POST/PUT 等请求体
 * 端点：POST /api/watchlist
 */
export type POSTApiWatchlistRequestBody = {
  /**
   * 6 位 A 股股票代码，如 600519
   * 约束：需匹配 ^\d{6}$
   */
  code: string;
};

/**
 * 添加自选股（去重）
 * 成功响应（HTTP 200）
 * 端点：POST /api/watchlist
 */
export type POSTApiWatchlistResponse = WatchlistCodes;

/**
 * 最近一次异动监控快照
 * 返回最近一次 POST /api/watchlist/monitor 落盘的快照（生成时间 + 覆盖只数 + 预警条目），供自选股页常驻展示；从未监控过时返回 generatedAt=null 的空结构而非 404。
 * 成功响应（HTTP 200）
 * 端点：GET /api/watchlist/alerts
 */
export type GETApiWatchlistAlertsResponse = WatchlistMonitorResult;

/**
 * 主动监控：批量回测 + 异动预警
 * 对自选股清单跑批量新闻回测并检出异动。单次处理上限默认 20 只（WATCHLIST_MAX_CODES 可调），超出部分被跳过并在响应中如实披露 requested/skipped（不静默截断）；结果落盘，可由 GET /api/watchlist/alerts 回看。
 * 成功响应（HTTP 200）
 * 端点：POST /api/watchlist/monitor
 */
export type POSTApiWatchlistMonitorResponse = WatchlistMonitorResult;

/**
 * 批量「含最新消息回测」
 * POST/PUT 等请求体
 * 端点：POST /api/watchlist/news-backtest
 */
export type POSTApiWatchlistNewsBacktestRequestBody = {
  /**
   * 缺省为全部自选股
   * 约束：最多 20 项
   */
  codes?: string[];
};

/**
 * 批量「含最新消息回测」
 * 成功响应（HTTP 200）
 * 端点：POST /api/watchlist/news-backtest
 */
export type POSTApiWatchlistNewsBacktestResponse = WatchlistNewsBacktestReport;

/**
 * 移除自选股（幂等）
 * 成功响应（HTTP 200）
 * 端点：DELETE /api/watchlist/{code}
 */
export type DELETEApiWatchlistCodeResponse = WatchlistCodes;

/**
 * 移除自选股（幂等）
 * 路径/查询参数
 * 端点：DELETE /api/watchlist/{code}
 */
export type DELETEApiWatchlistCodeParams = {
  /** 约束：需匹配 ^\d{6}$ */
  code: string;
};
