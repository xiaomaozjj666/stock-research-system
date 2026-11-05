import { stockCodeSchema } from '../shared.js';

export const quantSchemas = {
  /**
   * 策略配置（quant/types.ts 的 StrategyConfig）。
   *
   * POST /api/quant/analyze 的 `strategy` 字段既可传策略名（string）、
   * 也可传本对象，由 orchestrator.parseStrategyInput 二选一解析。
   * 此前该字段只写 description 不给 type，生成的 TS 里是 unknown；
   * 补这个组件后请求体类型才真正对得上调用方能传的东西。
   */
  StrategyConfig: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: {
        type: 'string',
        enum: ['ma_cross', 'momentum', 'mean_reversion', 'custom'],
      },
      stockCode: stockCodeSchema,
      params: {
        type: 'object',
        description: '策略参数（键随 type 而异：短长周期 / 阈值 / 均线周期）',
        additionalProperties: { type: 'number' },
      },
      startDate: { type: 'string', format: 'date', description: '回测区间起' },
      endDate: { type: 'string', format: 'date', description: '回测区间止' },
      initialCapital: { type: 'number', description: '初始资金，默认 100 万' },
      commission: { type: 'number', description: '佣金率，默认万三' },
      slippage: { type: 'number', description: '滑点，默认 0.1%' },
      costModel: {
        type: 'string',
        enum: ['a_share'],
        description: 'a_share=真实 A 股费率；未设则按 commission/slippage 对称建模',
      },
      newsOverlay: {
        type: 'object',
        description: '新闻情绪叠加层；与 factorOverlay 取较小值（AND 语义）',
        properties: {
          polarity: { type: 'number', description: '聚合极性 ∈ [−1,1]' },
          since: { type: 'string', format: 'date', description: '旧口径生效起始日' },
          items: {
            type: 'array',
            description: '严格时序（推荐）：引擎只用发布日 ≤ bar 日期的新闻，无前视偏差',
            items: {
              type: 'object',
              properties: {
                publishedAt: { type: 'string', description: '发布日或 ISO datetime' },
                polarity: { type: 'number', description: '确定性极性 ∈ [−1,1]' },
              },
              required: ['publishedAt', 'polarity'],
            },
          },
        },
        required: ['polarity'],
      },
      factorOverlay: {
        type: 'object',
        description: '组合 alpha 叠加层（opt-in）：方向性 alpha 翻成建仓资金缩放系数',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'neutral'] },
          alpha: { type: 'number' },
          posture: { type: 'number', description: '建仓缩放 ∈ [0,1]' },
        },
        required: ['direction', 'alpha'],
      },
    },
    required: ['name', 'type', 'stockCode', 'params', 'startDate', 'endDate'],
  },
  ValuationData: {
    type: 'object',
    properties: {
      currentPrice: { type: 'number' },
      pe: { type: 'number' },
      pb: { type: 'number' },
      ps: { type: 'number' },
      marketCap: { type: 'number' },
      historicalPE: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            year: { type: 'string' },
            pe: { type: 'number' },
            isEstimated: { type: 'boolean' },
          },
          required: ['year', 'pe'],
        },
      },
      peerComparison: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            code: { type: 'string' },
            pe: { type: 'number' },
            pb: { type: 'number' },
            roe: {
              type: ['number', 'null'],
              description:
                '同业 ROE：上游估值接口不提供该字段，无数据时为 null（非 0——0 会被当成真实 ROE 参与统计）',
            },
            marketCap: { type: 'number' },
            peUnavailable: {
              type: 'boolean',
              description: 'true = 该同业亏损（PE 为负被置 0），展示层应披露「亏损」',
            },
          },
          required: ['name', 'code', 'pe', 'pb', 'roe', 'marketCap'],
        },
      },
    },
    required: ['currentPrice', 'pe', 'pb', 'ps', 'marketCap', 'historicalPE', 'peerComparison'],
  },
  StrategyRecommendation: {
    type: 'object',
    properties: {
      strategyType: { type: 'string' },
      sharpeRatio: { type: 'number' },
      maxDrawdown: { type: 'number' },
      winRate: { type: 'number' },
      totalReturn: { type: 'number' },
      applicableMarket: { type: 'string' },
      fatalWeakness: { type: 'string' },
      backtestWarning: { type: 'string' },
      newsAware: {
        type: 'object',
        description: '叠加最新消息情绪后的回测对比（仅有新闻时存在）',
        properties: {
          totalReturn: { type: 'number' },
          sharpeRatio: { type: 'number' },
          maxDrawdown: { type: 'number' },
          winRate: { type: 'number' },
          posture: { type: 'number' },
        },
        required: ['totalReturn', 'sharpeRatio', 'maxDrawdown', 'winRate', 'posture'],
      },
    },
    required: [
      'strategyType',
      'sharpeRatio',
      'maxDrawdown',
      'winRate',
      'totalReturn',
      'applicableMarket',
      'fatalWeakness',
      'backtestWarning',
    ],
  },
  /** 因子实验台账条目（因子 × 持有期） */
  FactorExperiment: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'string' },
      source: { type: 'string', enum: ['cross-section', 'expression', 'hypothesis'] },
      name: { type: 'string' },
      expression: { type: 'string' },
      universe: {
        type: 'object',
        properties: {
          board: { type: 'string' },
          codes: { type: 'array', items: { type: 'string' } },
          requested: { type: 'number' },
          included: { type: 'number' },
        },
        required: ['requested', 'included'],
      },
      horizon: { type: 'number' },
      sampleSize: { type: 'number' },
      icMean: { type: 'number' },
      pValue: { type: 'number' },
      oosStable: { type: 'boolean' },
      kept: { type: 'boolean' },
      evidence: {
        type: 'object',
        description:
          '判据输入留痕。**旧记录缺省**（该块是改造后才开始落的），改进循环只回放带它的记录——不猜、不补默认值',
        properties: {
          icN: { type: 'number', description: 'IC 有效样本期数' },
          quantileRows: { type: 'number', description: '分档数' },
          monotonicity: { type: 'number', description: '分档收益单调性 ∈ [-1,1]' },
          spread: { type: 'number', description: '多空价差（小数）' },
        },
        required: ['icN', 'quantileRows', 'monotonicity', 'spread'],
      },
      notes: { type: 'string' },
    },
    required: [
      'id',
      'createdAt',
      'source',
      'name',
      'universe',
      'horizon',
      'sampleSize',
      'icMean',
      'pValue',
      'oosStable',
      'kept',
    ],
  },
  /** 研究简报（初筛 + 台账聚合的定期快照） */
  ResearchDigest: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'string' },
      screener: {
        type: 'object',
        properties: {
          at: { type: 'string', nullable: true },
          scanned: { type: 'number', nullable: true },
          eligible: { type: 'number', nullable: true },
          hitCount: { type: 'number', nullable: true },
          topHits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                strategy: { type: 'string' },
                detail: { type: 'string' },
              },
              required: ['code', 'name', 'strategy', 'detail'],
            },
          },
        },
        required: ['at', 'scanned', 'eligible', 'hitCount', 'topHits'],
      },
      ledger: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          kept: { type: 'number' },
          // 服务端 factorLedger.summarizeFactorExperiments 无条件写入这两个
          // （分别是「采信数 × 5% 的期望假阳性上界」与「采信集 OOS 稳定占比」），
          // 此前契约把它们标成可选，生成出的类型会让消费方以为可能缺字段
          keptExpectedFalse: { type: 'number', description: '期望假阳性上界 = 采信数 × 5%' },
          keptOosShare: { type: 'number', description: '采信集中 OOS 稳定的占比（0-1）' },
          bySource: { type: 'object', additionalProperties: { type: 'number' } },
        },
        required: ['total', 'kept', 'keptExpectedFalse', 'keptOosShare', 'bySource'],
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'createdAt', 'screener', 'ledger', 'notes'],
  },
  /** 全市场初筛命中项 */
  ScreenerHit: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      name: { type: 'string' },
      strategy: { type: 'string' },
      detail: { type: 'string' },
    },
    required: ['code', 'name', 'strategy', 'detail'],
  },
  /** 全市场初筛结果（POST /run 与 GET /latest 同一形状） */
  ScreenerRunResult: {
    type: 'object',
    properties: {
      at: { type: 'string' },
      scanned: { type: 'number', description: '实际扫描的股票数' },
      eligible: { type: 'number', description: 'K 线可用、参与判定的股票数' },
      failed: { type: 'number' },
      strategies: { type: 'array', items: { type: 'string' } },
      hits: { type: 'array', items: { $ref: '#/components/schemas/ScreenerHit' } },
      universe: {
        type: 'object',
        description: '宇宙披露：全市场总数与本次覆盖率（RPS 分位参照范围）',
        properties: {
          total: { type: 'number' },
          coverage: { type: 'number' },
        },
        required: ['total', 'coverage'],
      },
      durationMs: { type: 'number' },
    },
    required: ['at', 'scanned', 'eligible', 'failed', 'strategies', 'hits', 'universe'],
  },

  /* ===== LLM 运维（集成投票 / 权重校准 / 技能路由）===== */

  /**
   * 多模型集成结果（POST /api/llm/ensemble）。
   * 字段来源：server/src/llm/ensemble.ts 的 EnsembleResult / EnsembleAnswer。
   * 注意 answers 只含**成功**的模型（失败的被 runEnsemble 过滤后，
   * 全部失败时直接抛错走 5xx，不会出现在这里）；单模型时 agreement 恒为 1。
   */
  EnsembleResult: {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        description: '各候选模型的输出（只含成功项）',
        items: { $ref: '#/components/schemas/EnsembleAnswer' },
      },
      consensus: { type: 'string', description: '按权重聚类胜出的答案' },
      agreement: { type: 'number', description: '一致度 0-1：胜出组权重 / 全部权重' },
      effectiveModels: { type: 'number', description: '参与且成功的模型数' },
    },
    required: ['answers', 'consensus', 'agreement', 'effectiveModels'],
  },

  /** 单个候选模型的输出（EnsembleResult 的 answers 元素） */
  EnsembleAnswer: {
    type: 'object',
    properties: {
      model: { type: 'string', description: '模型 ID' },
      ok: {
        type: 'boolean',
        description: '该模型是否调用成功（出现在 answers 里即为 true）',
      },
      text: { type: 'string', description: '模型输出正文' },
      error: { type: 'string', description: '失败原因；ok=false 时出现' },
      weight: { type: 'number', description: '该模型本次的权重（校准命中率）' },
    },
    required: ['model', 'ok', 'text', 'weight'],
  },

  /**
   * 技能路由判定（GET /api/llm/skills）。
   * 字段来源：server/src/llm/skillRouter.ts 的 SkillRoute。
   * 纯规则表判定（不调模型）：命中专用技能 confidence=0.9，兜底 chat=0.6。
   */
  SkillRoute: {
    type: 'object',
    properties: {
      skill: { $ref: '#/components/schemas/SkillId' },
      confidence: { type: 'number', description: '置信度 0-1（规则命中 0.9，兜底 0.6）' },
      reason: { type: 'string', description: '判定理由（中文）' },
    },
    required: ['skill', 'confidence', 'reason'],
  },

  /**
   * 技能 ID（skillRouter.SkillId）。
   * 独立成组件是因为它同时出现在「技能路由结果」与「对话回答的 plan.skill」
   * 两处——枚举在两处各写一遍，扩容时必有一处漏改。
   */
  SkillId: {
    type: 'string',
    enum: ['quant_factor', 'backtest', 'news', 'compare', 'watchlist', 'chat'],
  },

  /* ===== 量化域（因子 / 组合 alpha / 截面 / 台账 / 简报 / 估值 / 时序）=====
           下列形状此前只有 operation description 一句话。字段全部来自
           server/src/quant/{types,factorEvaluation,factorPredictability,compositeAlpha,
           compositeService,priceVolumeFactors,portfolioBacktest,valuationModel,
           researchDigest,factorLedger,backtestEvaluator}.ts 与
           server/src/{routes/quantCore,routes/quantOps,routes/quantCrossSection,
           llm/researchMemory,quant/announcementProvider,quant/timeseries/analyze}.ts，
           并与 client/src/{pages/quant/types.ts,api/client.ts} 的消费方类型对齐。 */

  /**
   * 回测结果（POST /api/quant/analyze 的 backtest / backtestBaseline、
   * POST /api/backtest/evaluate 的 baseline / experiment 四处共用）。
   * 字段来源：server/src/quant/types.ts 的 BacktestResult。
   * 叠加层标记的纪律：newsAware / factorAware 由引擎**无条件回传**（恒在），
   * 而 newsPosture / newsSince / factorPosture / factorDirection 只在对应
   * 叠加层真正生效时才写入返回值，故一律不进 required——把「生效了才有」
   * 写成必填，会让调用方以为没生效时也能读到一个 0。
   * newsSince 是条件展开（`...(newsSince ? { newsSince } : {})`）：
   * 聚合常数叠加且取不到最早新闻日时该字段整个不存在。
   */
  BacktestResult: {
    type: 'object',
    properties: {
      totalReturn: { type: 'number', description: '总收益率 %' },
      annualizedReturn: { type: 'number', description: '年化收益率 %' },
      sharpeRatio: { type: 'number' },
      sortinoRatio: { type: 'number', description: '索提诺比率；引擎当前恒返回' },
      maxDrawdown: { type: 'number', description: '最大回撤 %' },
      winRate: { type: 'number', description: '胜率 %' },
      tradeCount: { type: 'number', description: '交易次数' },
      profitFactor: { type: 'number', description: '盈亏比' },
      equityCurve: {
        type: 'array',
        description: '策略净值曲线（起始为初始资金）',
        items: {
          type: 'object',
          properties: { date: { type: 'string' }, value: { type: 'number' } },
          required: ['date', 'value'],
        },
      },
      trades: {
        type: 'array',
        description: '成交流水',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            type: { type: 'string', enum: ['buy', 'sell'] },
            price: { type: 'number' },
            shares: { type: 'number' },
            commission: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['date', 'type', 'price', 'shares', 'commission', 'reason'],
        },
      },
      benchmark: {
        type: 'array',
        description: '基准（买入持有）净值曲线',
        items: {
          type: 'object',
          properties: { date: { type: 'string' }, value: { type: 'number' } },
          required: ['date', 'value'],
        },
      },
      newsAware: { type: 'boolean', description: '是否应用了新闻情绪叠加层' },
      newsPosture: { type: 'number', description: '新闻姿态 = clamp(0.5+0.5·polarity,0,1)' },
      newsSince: { type: 'string', description: '情绪叠加生效起始日；取不到时缺省' },
      factorAware: { type: 'boolean', description: '是否应用了组合 alpha 信号叠加层' },
      factorPosture: {
        type: 'number',
        description: '组合 alpha 姿态；仅 factorAware 时出现',
      },
      factorDirection: {
        type: 'string',
        enum: ['up', 'down', 'neutral'],
        description: '组合 alpha 综合方向；仅因子叠加层生效时出现',
      },
    },
    required: [
      'totalReturn',
      'annualizedReturn',
      'sharpeRatio',
      'maxDrawdown',
      'winRate',
      'tradeCount',
      'profitFactor',
      'equityCurve',
      'trades',
      'benchmark',
    ],
  },

  /**
   * 单因子的时间序列预测力（POST /api/quant/analyze 的
   * priceVolumeFactors[].predictability 与 /factor/composite 的
   * factorPredictability[] 共用同一形状）。
   * 字段来源：server/src/quant/factorPredictability.ts 的 FactorPredictability。
   * horizons 的键是持有期（交易日），**值可显式为 null**（该持有期样本不足时
   * singleFactorPredictability 返回 null，而不是省略该键），故声明为可空字典。
   */
  FactorPredictability: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '因子名（见 PriceVolumeFactor）' },
      direction: {
        type: 'number',
        enum: [1, -1],
        description: '+1=值越高预期收益越高；-1=值越低越好（A 股实证已校正）',
      },
      category: {
        type: 'string',
        enum: ['volatility', 'reversal', 'momentum', 'liquidity', 'volume', 'risk'],
      },
      horizons: {
        type: 'object',
        description: '持有期（交易日）→ 预测力；样本不足时该键值为 null',
        additionalProperties: {
          oneOf: [{ $ref: '#/components/schemas/FactorPredictabilityHorizon' }, { type: 'null' }],
        },
      },
      hasSignal: {
        type: 'boolean',
        description: '是否有任一持有期达到统计显著（Holm 校正后）',
      },
    },
    required: ['name', 'direction', 'category', 'horizons', 'hasSignal'],
  },

  /** 单因子单持有期的预测力（FactorPredictability.horizons 的值） */
  FactorPredictabilityHorizon: {
    type: 'object',
    properties: {
      ic: { type: 'number', description: 'Spearman 秩相关 IC ∈ [-1,1]' },
      effectiveIc: {
        type: 'number',
        description: '经济方向 IC = ic × direction；>0 即方向兑现',
      },
      tStat: { type: 'number', description: 't 统计量（按重叠修正后的有效样本量 nEff）' },
      pValue: { type: 'number', description: 'Student t 双侧 p 值（未校正）' },
      pAdj: { type: 'number', description: '跨因子 Holm 校正后 p 值；significant 判据用它' },
      significant: { type: 'boolean', description: 'pAdj < 0.05 即统计显著' },
      n: { type: 'number', description: '有效样本数' },
      nEff: { type: 'number', description: '重叠修正后有效样本量 ≈ ceil(n/period)' },
    },
    required: ['ic', 'effectiveIc', 'tStat', 'pValue', 'significant', 'n', 'nEff'],
  },

  /**
   * 组合 alpha（POST /api/quant/analyze 的 compositeAlpha 与
   * /factor/composite 的 compositeAlpha 共用）。
   * 字段来源：server/src/quant/compositeAlpha.ts 的 CompositeAlpha。
   * 口径：只把 Holm 校正后显著的因子纳入加权（不显著=无证据，权重置 0），
   * 权重取 |t|，alpha = Σ(w·effectiveIc)/Σw；跨持有期各自结算后多数表决出
   * overallDirection，平票/全中性为 neutral。
   */
  CompositeAlpha: {
    type: 'object',
    properties: {
      horizons: {
        type: 'array',
        description: '逐持有期的组合 alpha',
        items: { $ref: '#/components/schemas/CompositeAlphaHorizon' },
      },
      hasSignal: { type: 'boolean', description: '任一持有期存在显著因子' },
      overallDirection: {
        type: 'string',
        enum: ['up', 'down', 'neutral'],
        description: '跨持有期多数表决的综合方向',
      },
      overallAlpha: {
        type: 'number',
        description: '各持有期 alpha 均值 ∈ [-1,1]；回测姿态缩放的卷积度',
      },
    },
    required: ['horizons', 'hasSignal', 'overallDirection', 'overallAlpha'],
  },

  /** 单持有期的组合 alpha（CompositeAlpha.horizons 的元素） */
  CompositeAlphaHorizon: {
    type: 'object',
    properties: {
      period: { type: 'number', description: '持有期（交易日）' },
      alpha: { type: 'number', description: '方向性组合 alpha ∈ [-1,1]' },
      direction: { type: 'string', enum: ['up', 'down', 'neutral'] },
      significantCount: { type: 'number', description: '去重后纳入加权的显著因子数' },
      evaluableCount: {
        type: 'number',
        description: '该持有期下有预测力的因子总数（非 null）',
      },
      agreement: { type: 'number', description: '显著因子方向一致率 ∈ [0,1]' },
      topContributors: {
        type: 'array',
        description: '主导贡献因子（按 |贡献| 降序，最多 3 项）',
        items: { $ref: '#/components/schemas/CompositeContributor' },
      },
    },
    required: [
      'period',
      'alpha',
      'direction',
      'significantCount',
      'evaluableCount',
      'agreement',
      'topContributors',
    ],
  },

  /** 单个显著因子对组合的贡献（CompositeAlphaHorizon.topContributors 的元素） */
  CompositeContributor: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '因子名' },
      effectiveIc: { type: 'number', description: '方向校正 IC（含符号）' },
      weight: { type: 'number', description: '置信度权重 = |tStat|' },
      contribution: { type: 'number', description: '加权贡献 = weight × effectiveIc' },
    },
    required: ['name', 'effectiveIc', 'weight', 'contribution'],
  },

  /**
   * 单只股票的组合 alpha 结果（POST /api/quant/factor/composite 的 200，
   * 以及 /factor/composite/batch 的 items[].result）。
   * 字段来源：server/src/quant/compositeService.ts 的 CompositeAlphaResult。
   * isSimulated 必填：行情源不可达且无历史时 dataProvider 会返回确定性合成
   * K 线并逐根打 isSimulated——调用方据此判断这批指标是不是真的算了。
   */
  CompositeAlphaResult: {
    type: 'object',
    properties: {
      stockCode: { type: 'string' },
      market: { type: 'string', enum: ['A', 'HK', 'US'], description: '识别出的市场' },
      benchmarkSecid: { type: 'string', description: '实际使用的基准指数 secid' },
      horizons: { type: 'array', items: { type: 'number' }, description: '持有期（交易日）' },
      compositeAlpha: { $ref: '#/components/schemas/CompositeAlpha' },
      factorPredictability: {
        type: 'array',
        description: '逐因子时间序列预测力（组合 alpha 的构建块，供透明审视）',
        items: { $ref: '#/components/schemas/FactorPredictability' },
      },
      bars: { type: 'number', description: 'K 线条数' },
      dataRange: {
        type: 'object',
        properties: { start: { type: 'string' }, end: { type: 'string' } },
        required: ['start', 'end'],
      },
      benchmarkAvailable: {
        type: 'boolean',
        description: '市场基准收益是否取到；false 时 Beta 类因子按 NaN 处理、不参与加权',
      },
      // 刻意**不进 required**：批量路径的闸门用
      // `item.result?.isSimulated !== true` 判读（routes/quantCore.ts 第 85 行），
      // 显式兼容「旧版结果没有该字段」的历史数据。契约若声明为必填，
      // 消费方按契约写代码就会假定它一定在 —— 与实现的实际兼容行为不符。
      isSimulated: {
        type: 'boolean',
        description: 'K 线是否来自取数失败后的合成降级；旧版结果可能缺此字段（缺省视为非模拟）',
      },
    },
    required: [
      'stockCode',
      'market',
      'benchmarkSecid',
      'horizons',
      'compositeAlpha',
      'factorPredictability',
      'bars',
      'dataRange',
      'benchmarkAvailable',
    ],
  },

  /**
   * 批量组合 alpha 的结果主体（POST /api/quant/factor/composite/batch 的 200
   * = 本组件 & { run, preflight }，见该 operation 的 allOf）。
   * 字段来源：compositeService.ts 的 CompositeAlphaBatchResult。
   * items 按**输入顺序（去重后）**排列，失败项只带 error 不带 result——
   * 「一只拉不到就整批失败」是批量场景下最差的失败模式。
   */
  CompositeAlphaBatchResult: {
    type: 'object',
    properties: {
      requested: { type: 'number', description: '去重后的请求代码数' },
      succeeded: { type: 'number' },
      failed: { type: 'number' },
      items: {
        type: 'array',
        description: '逐只结果（按输入顺序）',
        items: { $ref: '#/components/schemas/CompositeAlphaBatchItem' },
      },
      startDate: { type: 'string', description: '批次公共参数回显' },
      endDate: { type: 'string' },
      horizons: { type: 'array', items: { type: 'number' } },
    },
    required: ['requested', 'succeeded', 'failed', 'items', 'startDate', 'endDate', 'horizons'],
  },

  /** 批量组合 alpha 的单项（成功带 result / 失败带 error） */
  CompositeAlphaBatchItem: {
    type: 'object',
    properties: {
      stockCode: { type: 'string' },
      ok: { type: 'boolean' },
      result: {
        $ref: '#/components/schemas/CompositeAlphaResult',
        description: '成功项才有；失败项缺省',
      },
      error: { type: 'string', description: '失败原因；失败项才有' },
    },
    required: ['stockCode', 'ok'],
  },

  /**
   * 单因子评估报告（POST /api/quant/factor/evaluate 的 200；
   * 同一形状也作为 cross-section 的 factors[].report 与
   * expression / expression-batch 的 factor.report 出现）。
   * 字段来源：server/src/quant/factorEvaluation.ts 的 FactorEvaluationReport。
   * verdict 不在评估器返回类型里，而是**路由层**用 judgeWithActivePolicy
   * 逐持有期补上的（quantCore / quantOps / quantCrossSection 三处都补），
   * 所以对本契约的四个端点而言它恒在。
   * turnover / alphaBeta 是**必填可空**：缺 symbol 或样本不足时评估器返回
   * null（不是省略键），调用方须按 null 判断「算不出」而非「没跑」。
   */
  FactorEvaluationReport: {
    type: 'object',
    properties: {
      periods: {
        type: 'array',
        items: { type: 'number' },
        description: '参与分析的持有期（升序）',
      },
      byPeriod: {
        type: 'array',
        description: '逐持有期报告',
        items: { $ref: '#/components/schemas/FactorPeriodReport' },
      },
      sampleSize: { type: 'number', description: '有效样本数（各期共用同一份清洗结果）' },
      dropped: { type: 'number', description: '因因子值/收益非有限被丢弃的样本数' },
      dropRatio: { type: 'number', description: '丢弃比例 ∈ [0,1]' },
      neutralized: {
        type: 'boolean',
        description: '中性化是否真的生效（缺市值与行业数据时为 false）',
      },
    },
    required: ['periods', 'byPeriod', 'sampleSize', 'dropped', 'dropRatio', 'neutralized'],
  },

  /** 逐持有期的因子报告（FactorEvaluationReport.byPeriod 的元素） */
  FactorPeriodReport: {
    type: 'object',
    properties: {
      period: { type: 'number', description: '持有期（交易日）' },
      sampleSize: { type: 'number' },
      ic: { $ref: '#/components/schemas/IcSignificance' },
      oos: { $ref: '#/components/schemas/OosStability' },
      quantile: { $ref: '#/components/schemas/QuantileReturnTable' },
      turnover: {
        oneOf: [{ $ref: '#/components/schemas/TurnoverResult' }, { type: 'null' }],
        description: '缺 symbol 或不足两个截面时为 null',
      },
      alphaBeta: {
        oneOf: [{ $ref: '#/components/schemas/FactorAlphaBeta' }, { type: 'null' }],
        description: '样本 < 3 天或市场收益无波动时为 null',
      },
      longShortCumulative: {
        type: 'number',
        description: '因子加权多空组合累计净值（起始 1）',
      },
      verdict: { $ref: '#/components/schemas/FactorVerdict' },
    },
    required: [
      'period',
      'sampleSize',
      'ic',
      'oos',
      'quantile',
      'turnover',
      'alphaBeta',
      'longShortCumulative',
      'verdict',
    ],
  },

  /** 分档收益表（factorEvaluation.QuantileReturnTable） */
  QuantileReturnTable: {
    type: 'object',
    properties: {
      period: { type: 'number', description: '持有期（交易日）' },
      rows: {
        type: 'array',
        description: '各档收益；档号 1 = 因子值最低档，某日样本不足时该档为空',
        items: {
          type: 'object',
          properties: {
            quantile: { type: 'number', description: '档号 ∈ [1, quantiles]' },
            count: { type: 'number', description: '落入该档的样本数' },
            meanReturn: { type: 'number', description: '加权平均周期收益（小数）' },
            stdReturn: { type: 'number', description: '收益标准差（样本口径）' },
          },
          required: ['quantile', 'count', 'meanReturn', 'stdReturn'],
        },
      },
      spread: { type: 'number', description: '多空价差 = 最高档 − 最低档（小数）' },
      monotonicity: {
        type: 'number',
        description: '单调性 ∈ [-1,1]：档号与各档收益的 Spearman 秩相关',
      },
    },
    required: ['period', 'rows', 'spread', 'monotonicity'],
  },

  /** 因子加权多空组合的年化 alpha / 对等权全市场的 beta */
  FactorAlphaBeta: {
    type: 'object',
    properties: {
      alpha: { type: 'number', description: '年化 alpha（小数）' },
      beta: { type: 'number', description: '对市场（等权全市场收益）的 beta' },
      r2: { type: 'number' },
    },
    required: ['alpha', 'beta', 'r2'],
  },

  /** 「是否采信」判定（IC 显著 + 分层单调 + 多空价差为正，三者同时成立） */
  FactorVerdict: {
    type: 'object',
    properties: {
      effective: { type: 'boolean' },
      reasons: {
        type: 'array',
        items: { type: 'string' },
        description: '未通过的原因（中文）；effective=true 时为空数组',
      },
    },
    required: ['effective', 'reasons'],
  },

  /**
   * 因子组合回测（截面 factors[].portfolio、expression 的 portfolio、
   * expression-batch 的 results[].portfolio 三处共用）。
   * 字段来源：server/src/quant/portfolioBacktest.ts 的 PortfolioBacktestResult。
   * 口径：T+1 次日开盘撮合、持有 holdDays 个交易日后换仓、成本按双边成交额
   * 计提，基准为**同宇宙等权组合**（同 T+1 开盘口径），故它回答的是
   * 「按这个因子选股是否跑赢不选股」，与截面 IC 语义一致。
   */
  PortfolioBacktestResult: {
    type: 'object',
    properties: {
      equityCurve: {
        type: 'array',
        description: '组合净值曲线（每个调仓期平仓成交日一个点，起始 1）',
        items: {
          type: 'object',
          properties: { date: { type: 'string' }, value: { type: 'number' } },
          required: ['date', 'value'],
        },
      },
      benchmarkCurve: {
        type: 'array',
        description: '基准净值曲线（同口径）',
        items: {
          type: 'object',
          properties: { date: { type: 'string' }, value: { type: 'number' } },
          required: ['date', 'value'],
        },
      },
      rebalances: {
        type: 'array',
        description: '逐次调仓记录',
        items: { $ref: '#/components/schemas/RebalanceRecord' },
      },
      totalReturn: { type: 'number', description: '总收益 %（扣费后）' },
      annualizedReturn: { type: 'number', description: '年化收益 %（扣费后）' },
      sharpe: { type: 'number' },
      maxDrawdown: { type: 'number', description: '最大回撤 %（扣费后净值口径）' },
      winRate: { type: 'number', description: '周期胜率 %：跑赢基准的调仓期占比' },
      avgTurnover: { type: 'number', description: '平均换手率 ∈ [0,1]' },
      periods: { type: 'number', description: '调仓期数' },
    },
    required: [
      'equityCurve',
      'benchmarkCurve',
      'rebalances',
      'totalReturn',
      'annualizedReturn',
      'sharpe',
      'maxDrawdown',
      'winRate',
      'avgTurnover',
      'periods',
    ],
  },

  /**
   * 因子面板的 universe 描述（截面 / expression / expression-batch 三处共用）。
   * 字段来源：services/quant/panelService.ts 的 resolveUniverse，三种来源字段不同：
   * - codes：只有 source + requested；
   * - board：另有 board、constituents（上游抖动但有快照时带 stale/staleAgeMs）；
   * - index：另有 index、requestedDate、updateDate、constituents
   *   （Baostock 历史成分，**含其后退市证券**，是幸存者偏差的正面修复）。
   * survivorshipNote 只由截面路由追加（它按来源生成幸存者偏差声明），
   * 另两个端点不返回，故不进 required。
   * requestedDate / updateDate 必填可空：Baostock 侧该字段取不到时显式为 null。
   */
  FactorUniverse: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['codes', 'board', 'index'] },
      board: { type: 'string', description: '板块代码；source=board 时出现' },
      index: {
        type: 'string',
        enum: ['hs300', 'zz500', 'sz50'],
        description: 'source=index 时出现',
      },
      requestedDate: {
        type: 'string',
        nullable: true,
        description: '请求的成分快照日；未指定时为 null（仅 source=index）',
      },
      updateDate: {
        type: 'string',
        nullable: true,
        description: '成分快照的实际调仓日；取不到时为 null（仅 source=index）',
      },
      requested: { type: 'number', description: '解析出的成分/请求只数' },
      constituents: {
        type: 'array',
        description: '成分股；codes 源不返回（那只数已由 requested 给出）',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string', nullable: true, description: 'Baostock 侧可能无名称' },
          },
          required: ['code', 'name'],
        },
      },
      stale: {
        type: 'boolean',
        description: '上游失败但用了磁盘快照；仅 source=board 会出现',
      },
      staleAgeMs: { type: 'number', description: '陈旧快照的年龄（毫秒）' },
      survivorshipNote: { type: 'string', description: '幸存者偏差声明；仅截面端点返回' },
    },
    required: ['source', 'requested'],
  },

  /**
   * 量化研究报告（POST /api/quant/analyze 的 200）。
   * 字段来源：server/src/routes/quantCore.ts 的 report 字面量
   * （= quant/types.ts 的 QuantResearchReport 加上该路由新透出的三块）。
   * 三个条件性回传都是**缺省而非 null**：backtestBaseline 只在有新闻时出现
   * （否则它就等于 backtest，重复一份没有信息量）、newsSentiment 同理、
   * compositeAlpha 只在算出因子预测力且合成未抛错时出现。
   * limitations 是**以「；」拼接的字符串**（limitations.join('；')），
   * 不是数组——前端整段展示。
   */
  QuantReport: {
    type: 'object',
    properties: {
      strategy: {
        type: 'object',
        description: '生效的策略配置（parseStrategyInput 解析并补齐日期区间后的结果）',
        properties: {
          name: { type: 'string' },
          type: {
            type: 'string',
            enum: ['ma_cross', 'momentum', 'mean_reversion', 'custom'],
          },
          stockCode: { type: 'string' },
          params: {
            type: 'object',
            description: '策略参数（键随 type 而异：短长周期 / 阈值 / 均线周期…）',
            additionalProperties: { type: 'number' },
          },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          initialCapital: { type: 'number', description: '初始资金，默认 100 万' },
          commission: { type: 'number', description: '佣金率' },
          slippage: { type: 'number', description: '滑点' },
          costModel: {
            type: 'string',
            enum: ['a_share'],
            description: '交易成本模型；未设置时按 commission/slippage 构造对称模型',
          },
          newsOverlay: {
            type: 'object',
            description: '新闻情绪叠加层；未启用时缺省',
            properties: {
              polarity: { type: 'number', description: '聚合极性 ∈ [-1,1]' },
              since: { type: 'string', description: '旧口径下姿态自该日起常数生效' },
              items: {
                type: 'array',
                description: '分段情绪时间线（严格时序口径，优先于 since）',
                items: {
                  type: 'object',
                  properties: {
                    publishedAt: { type: 'string' },
                    polarity: { type: 'number' },
                  },
                  required: ['publishedAt', 'polarity'],
                },
              },
            },
            required: ['polarity'],
          },
          factorOverlay: {
            type: 'object',
            description: '组合 alpha 信号叠加层；未注入时缺省',
            properties: {
              direction: { type: 'string', enum: ['up', 'down', 'neutral'] },
              alpha: { type: 'number', description: '组合 alpha ∈ [-1,1]' },
              posture: { type: 'number', description: '建仓资金缩放系数 ∈ [0,1]' },
            },
            required: ['direction', 'alpha'],
          },
        },
        required: ['name', 'type', 'stockCode', 'params', 'startDate', 'endDate'],
      },
      dataQuality: { $ref: '#/components/schemas/DataQualityReport' },
      backtest: { $ref: '#/components/schemas/BacktestResult' },
      backtestBaseline: {
        $ref: '#/components/schemas/BacktestResult',
        description: '无叠加层的基线回测；仅在有新闻时才回传',
      },
      newsSentiment: {
        $ref: '#/components/schemas/NewsSignal',
        description: '最新消息情绪；仅在抓到/粘贴到新闻时才回传',
      },
      priceVolumeFactors: {
        type: 'array',
        description: '量价因子快照值 + 时间序列预测力（A 股方向已按本土实证校正）',
        items: { $ref: '#/components/schemas/PriceVolumeFactor' },
      },
      compositeAlpha: {
        $ref: '#/components/schemas/CompositeAlpha',
        description: '多因子按 |t| 置信度加权的方向性组合 alpha；计算失败时缺省',
      },
      audit: { $ref: '#/components/schemas/AuditReport' },
      optimization: { $ref: '#/components/schemas/OptimizationReport' },
      summary: { type: 'string', description: '中文摘要（generateSummary 产出）' },
      confidence: {
        type: 'string',
        enum: ['高', '中', '低'],
        description: '研究置信度；由数据质量分与审计分联合分档',
      },
      limitations: { type: 'string', description: '局限性说明，多条以「；」拼接' },
    },
    required: [
      'strategy',
      'dataQuality',
      'backtest',
      'priceVolumeFactors',
      'audit',
      'optimization',
      'summary',
      'confidence',
      'limitations',
    ],
  },

  /** 单个量价因子（QuantReport.priceVolumeFactors 的元素） */
  PriceVolumeFactor: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '因子名（11 个量价因子之一）' },
      value: {
        type: 'number',
        nullable: true,
        description:
          '最新一日的因子快照值；数据不足时为 NaN，**JSON 序列化为 null**——据此配合 available 剔除，绝不可当 0 参与加权',
      },
      direction: {
        type: 'number',
        enum: [1, -1],
        description: '+1=值越高越好；-1=值越低越好',
      },
      category: {
        type: 'string',
        enum: ['volatility', 'reversal', 'momentum', 'liquidity', 'volume', 'risk'],
      },
      evidence: { type: 'string', description: '实证依据摘要（第三方研究结论）' },
      aShareAdjusted: {
        type: 'boolean',
        description: '是否按 A 股实证做过方向翻转（true = 与美股经典口径相反）',
      },
      available: { type: 'boolean', description: '快照值是否可用（Number.isFinite(value)）' },
      predictability: {
        $ref: '#/components/schemas/FactorPredictability',
        description: '该因子对本股远期收益的时间序列预测力；预测力计算失败时缺省',
      },
    },
    required: ['name', 'value', 'direction', 'category', 'evidence', 'aShareAdjusted', 'available'],
  },

  /**
   * 截面因子评估结果（POST /api/quant/factor/cross-section 的 200）。
   * 字段来源：server/src/routes/quantCrossSection.ts 的响应字面量。
   * factors 只含**样本 ≥30** 的因子：样本不足的因子被如实跳过而不是硬出报告，
   * 所以 factors 条数少不代表「只有这几个因子存在」。
   */
  CrossSectionResult: {
    type: 'object',
    properties: {
      universe: { $ref: '#/components/schemas/FactorUniverse' },
      stocksIncluded: {
        type: 'array',
        items: { type: 'string' },
        description: '参与组装的股票',
      },
      stocksSkipped: {
        type: 'array',
        description: '被跳过的股票及原因（K 线不足等）',
        items: { $ref: '#/components/schemas/StockSkip' },
      },
      horizons: {
        type: 'array',
        items: { type: 'number' },
        description: '实际测算的持有期档位',
      },
      factors: {
        type: 'array',
        description: '逐因子的截面评估（仅含样本 ≥30 的因子）',
        items: { $ref: '#/components/schemas/CrossSectionFactor' },
      },
      run: { $ref: '#/components/schemas/RunSnapshot' },
      preflight: { $ref: '#/components/schemas/Preflight' },
      ledger: { $ref: '#/components/schemas/LedgerReceipt' },
    },
    required: [
      'universe',
      'stocksIncluded',
      'stocksSkipped',
      'horizons',
      'factors',
      'run',
      'preflight',
      'ledger',
    ],
  },

  /** 截面结果里的单个因子（CrossSectionResult.factors 的元素） */
  CrossSectionFactor: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: {
        type: 'string',
        enum: ['price_volume', 'fundamental', 'margin', 'event', 'pattern'],
        description: '因子族；pattern 是零额外网络调用的技术形态事件族',
      },
      report: { $ref: '#/components/schemas/FactorEvaluationReport' },
      portfolio: {
        $ref: '#/components/schemas/PortfolioBacktestResult',
        description: '组合回测；仅请求了 portfolio 且该因子有原始观测面板时出现',
      },
    },
    required: ['name', 'type', 'report'],
  },

  /**
   * 单条表达式评估结果（POST /api/quant/factor/expression 的 200）。
   * 字段来源：server/src/routes/quantOps.ts 的响应字面量。
   * portfolio 是**必填可空**：未请求组合回测时表达式为 undefined、JSON 里直接
   * 没有这个键；请求了但引擎返回 null 时该键存在且值为 null。两种情况都按
   * 「没有可用的组合回测」处理，故声明为可空（消费方仍须容忍键缺失）。
   * factor.type 恒为 'expression'（与截面族的 type 枚举不同，故不共用组件）。
   */
  FactorExpressionResult: {
    type: 'object',
    properties: {
      universe: { $ref: '#/components/schemas/FactorUniverse' },
      stocksIncluded: { type: 'array', items: { type: 'string' } },
      stocksSkipped: {
        type: 'array',
        items: { $ref: '#/components/schemas/StockSkip' },
      },
      horizons: { type: 'array', items: { type: 'number' } },
      factor: { $ref: '#/components/schemas/ExpressionFactor' },
      portfolio: {
        oneOf: [{ $ref: '#/components/schemas/PortfolioBacktestResult' }, { type: 'null' }],
        description: '组合回测；未请求时缺省',
      },
      run: { $ref: '#/components/schemas/RunSnapshot' },
      preflight: { $ref: '#/components/schemas/Preflight' },
      ledger: { $ref: '#/components/schemas/LedgerReceipt' },
    },
    required: [
      'universe',
      'stocksIncluded',
      'stocksSkipped',
      'horizons',
      'factor',
      'run',
      'preflight',
      'ledger',
    ],
  },

  /** 表达式因子（FactorExpressionResult.factor 与批量结果的 factor） */
  ExpressionFactor: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '因子名；未传 name 时为 custom_expression' },
      type: { type: 'string', enum: ['expression'] },
      report: { $ref: '#/components/schemas/FactorEvaluationReport' },
    },
    required: ['name', 'type', 'report'],
  },

  /**
   * 批量表达式验证结果（POST /api/quant/factor/expression/batch 的 200）。
   * 字段来源：server/src/routes/quantOps.ts 的响应字面量。
   * requested 是去空后的表达式数，evaluated 是其中**评估成功**的条数
   * （非法表达式与观测 <30 的都算失败，只标记该项、不拖垮整批）。
   * results[] 刻意声明成「公共字段 + 按 ok 追加」的扁平对象而不是 oneOf：
   * 失败项可能是「解析失败」（只有 error）或「观测不足」（error + stocksSkipped），
   * 两种失败形状不同，oneOf 会让消费方多一层收窄才能读到 error。
   */
  FactorExpressionBatchResult: {
    type: 'object',
    properties: {
      universe: { $ref: '#/components/schemas/FactorUniverse' },
      horizons: { type: 'array', items: { type: 'number' } },
      requested: { type: 'number', description: '本次请求的表达式条数' },
      evaluated: { type: 'number', description: '评估成功的条数' },
      results: {
        type: 'array',
        description: '逐表达式结果（按输入顺序）',
        items: { $ref: '#/components/schemas/ExpressionBatchItem' },
      },
      run: { $ref: '#/components/schemas/RunSnapshot' },
      preflight: { $ref: '#/components/schemas/Preflight' },
      ledger: { $ref: '#/components/schemas/LedgerReceipt' },
    },
    required: [
      'universe',
      'horizons',
      'requested',
      'evaluated',
      'results',
      'run',
      'preflight',
      'ledger',
    ],
  },

  /**
   * 个股研究记忆（GET /api/quant/research-memory/{code} 的 200）。
   * 字段来源：server/src/llm/researchMemory.ts 的 ResearchMemory。
   * previous 与 summary 都是**必填可空**：没有历史分析时 previous=null，
   * 拼不出任何一句可注入提示词时 summary=null。数据源全是本地已有资产
   * （historyService 的历史 + factorLedger 的台账），缺一项只让记忆变短、不报错。
   */
  ResearchMemory: {
    type: 'object',
    properties: {
      stockCode: { type: 'string' },
      previous: {
        oneOf: [
          {
            type: 'object',
            properties: {
              createdAt: { type: 'string' },
              rating: { type: 'string' },
              totalScore: { type: 'number' },
            },
            required: ['createdAt', 'rating', 'totalScore'],
          },
          { type: 'null' },
        ],
        description: '同股票的上一次分析；从未分析过时为 null',
      },
      historyCount: { type: 'number', description: '该股票历史分析次数' },
      scoreTrend: {
        type: 'array',
        items: { type: 'number' },
        description: '近期评分序列（由旧到新，最多 5 条）',
      },
      validatedFactors: {
        type: 'array',
        description: '台账中被采信的因子（近 5 条）作为「已验证过什么」的先验',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            horizon: { type: 'number', description: '持有期（交易日）' },
            icMean: { type: 'number', description: '该条记录的截面 IC 均值' },
          },
          required: ['name', 'horizon', 'icMean'],
        },
      },
      summary: {
        type: 'string',
        nullable: true,
        description: '拼好的中文摘要（可直接注入提示词）；无记忆时为 null',
      },
    },
    required: [
      'stockCode',
      'previous',
      'historyCount',
      'scoreTrend',
      'validatedFactors',
      'summary',
    ],
  },

  /**
   * 公告列表（GET /api/quant/announcements 的列表形态）。
   * 字段来源：server/src/quant/announcementProvider.ts 的 AnnouncementListResult。
   * 该端点响应是 oneOf：带 artCode 时返回单篇全文（{ artCode, content }），
   * 否则返回本组件。date 取 notice_date 的前 10 位（YYYY-MM-DD）。
   */
  AnnouncementListResult: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位 A 股代码' },
      announcements: {
        type: 'array',
        description: '公告列表（按日期倒序，pageSize 上限 30）',
        items: { $ref: '#/components/schemas/AnnouncementRow' },
      },
    },
    required: ['code', 'announcements'],
  },

  /** 单条公告（AnnouncementListResult.announcements 的元素） */
  AnnouncementRow: {
    type: 'object',
    properties: {
      artCode: { type: 'string', description: '公告正文 art_code（拉全文的键）' },
      title: { type: 'string', description: '公告标题（原文）' },
      date: { type: 'string', description: '公告日期 YYYY-MM-DD' },
    },
    required: ['artCode', 'title', 'date'],
  },

  /**
   * 估值建模结果（POST /api/quant/valuation/model 的 200）。
   * 字段来源：server/src/quant/valuationModel.ts 的 ValuationModelResult。
   * dcf / sensitivity 是**必填可空**：基期 EPS 缺失/非正或假设违反约束时，
   * 服务端如实回 null 并往 limitations 追加原因，而不是伪造数值——
   * 「DCF 算不出来」与「DCF 算出来是 0」必须能被调用方区分。
   * assumptions.baseEps 在取不到时是 NaN，JSON 序列化为 null。
   */
  ValuationModelResult: {
    type: 'object',
    properties: {
      model: { type: 'string', enum: ['two_stage_eps_dcf'] },
      code: { type: 'string' },
      fairValue: {
        type: 'number',
        nullable: true,
        description: '每股内在价值；DCF 不可算时为 null',
      },
      currentPrice: { type: 'number' },
      upsidePct: {
        type: 'number',
        nullable: true,
        description: '现价相对内在价值的折溢价 %（正=高估）；fairValue 不可算时为 null',
      },
      dcf: {
        oneOf: [
          {
            type: 'object',
            properties: {
              fairValue: { type: 'number' },
              explicitValue: { type: 'number', description: '显性期现值合计' },
              terminalValue: { type: 'number', description: '终值（未折现）' },
              discountedTerminalValue: { type: 'number', description: '终值现值' },
              cashFlows: {
                type: 'array',
                description: '逐期现金流',
                items: {
                  type: 'object',
                  properties: {
                    year: { type: 'number', description: '第 t 年（1 起）' },
                    eps: { type: 'number' },
                    discountFactor: { type: 'number', description: '1/(1+r)^t' },
                    presentValue: { type: 'number' },
                  },
                  required: ['year', 'eps', 'discountFactor', 'presentValue'],
                },
              },
              assumptions: {
                type: 'object',
                properties: {
                  growthRate1: { type: 'number' },
                  explicitYears: { type: 'number' },
                  growthRate2: { type: 'number' },
                  discountRate: { type: 'number' },
                  baseEps: { type: 'number' },
                },
                required: [
                  'growthRate1',
                  'explicitYears',
                  'growthRate2',
                  'discountRate',
                  'baseEps',
                ],
              },
            },
            required: [
              'fairValue',
              'explicitValue',
              'terminalValue',
              'discountedTerminalValue',
              'cashFlows',
              'assumptions',
            ],
          },
          { type: 'null' },
        ],
        description: '两阶段 EPS 贴现结果；不可执行时为 null（原因见 limitations）',
      },
      sensitivity: {
        oneOf: [
          {
            type: 'object',
            properties: {
              discountRates: {
                type: 'array',
                items: { type: 'number' },
                description: '折现率轴（升序）',
              },
              growthRates1: {
                type: 'array',
                items: { type: 'number' },
                description: '显性期增速轴（升序）',
              },
              matrix: {
                type: 'array',
                description: '[i][j] = r_i × g1_j 下的每股价值；非法假设格为 null',
                items: {
                  type: 'array',
                  items: { type: 'number', nullable: true },
                },
              },
            },
            required: ['discountRates', 'growthRates1', 'matrix'],
          },
          { type: 'null' },
        ],
      },
      comparables: { $ref: '#/components/schemas/ComparableAnalysis' },
      assumptions: {
        type: 'object',
        description: '实际生效的假设（自动推导的也回传，便于复现）',
        properties: {
          baseEps: {
            type: 'number',
            description: '基期 EPS；估值模型要求为正数，非正即抛错，故不会是 null',
          },
          growthRate1: { type: 'number', description: '显性期增速（小数）' },
          growthRate1Source: {
            type: 'string',
            enum: ['input', 'eps_cagr_3y'],
            description: 'input=调用方传入；eps_cagr_3y=由 EPS 3 年 CAGR 钳制推导',
          },
          growthRate2: { type: 'number', description: '永续增速（小数，须 < discountRate）' },
          discountRate: { type: 'number', description: '折现率（小数）' },
          explicitYears: { type: 'number', description: '显性期年数（1-15）' },
        },
        required: [
          'baseEps',
          'growthRate1',
          'growthRate1Source',
          'growthRate2',
          'discountRate',
          'explicitYears',
        ],
      },
      limitations: {
        type: 'array',
        items: { type: 'string' },
        description: '模型口径与局限（中文，逐条展示）',
      },
    },
    required: [
      'model',
      'code',
      'fairValue',
      'currentPrice',
      'upsidePct',
      'dcf',
      'sensitivity',
      'comparables',
      'assumptions',
      'limitations',
    ],
  },

  /**
   * 时序计量分析结果（POST /api/quant/timeseries/analyze 的 200）。
   * 字段来源：server/src/quant/timeseries/analyze.ts 的 TimeseriesAnalyzeResult。
   * code 是**联合类型**：单序列检验（adf/garch/arima）回一个代码，
   * 双序列检验（coint/kalman-beta）回 [code, code2]。
   * result 刻意宽松：它的形状随 test 完全改变（adf 的统计量 + 定阶诊断 /
   * garch 的 GARCH-EGARCH 拟合与条件方差序列 / coint 的协整向量与残差 /
   * arima 的定阶与参数 / kalman 的时变 β 序列），逐 test 展开会得到五份
   * 互相矛盾的声明，反而让人以为只有一种形状——消费方必须先读 test
   * 再收窄 result，故此处声明为开放对象。
   * window.n 是**对齐后**的观测数（双序列取日期交集后），不是单边 K 线条数。
   */
  TimeseriesAnalyzeResult: {
    type: 'object',
    properties: {
      test: { type: 'string', enum: ['adf', 'garch', 'coint', 'arima', 'kalman-beta'] },
      code: {
        oneOf: [
          { type: 'string' },
          {
            type: 'array',
            description: '[code, code2]，仅 coint / kalman-beta',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 2,
          },
        ],
      },
      window: {
        type: 'object',
        properties: {
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          n: { type: 'number', description: '窗口内观测数（双序列按日期对齐后）' },
        },
        required: ['startDate', 'endDate', 'n'],
      },
      result: {
        type: 'object',
        description: '检验/拟合结果；形状随 test 改变，须按 test 收窄后读取',
        additionalProperties: true,
      },
      input: {
        type: 'string',
        enum: ['price', 'return'],
        description: 'adf 作用于价格还是对数收益序列；其余 test 缺省',
      },
      note: { type: 'string', description: '口径提示与注意事项（中文）' },
    },
    required: ['test', 'code', 'window', 'result'],
  },

  /**
   * 受控回测评估（POST /api/backtest/evaluate 的 200）。
   * 字段来源：server/src/routes/quantOps.ts 的响应字面量
   * （baseline / experiment 各是一次 runBacktest，comparison 来自
   * quant/backtestEvaluator.compareBacktests）。
   * newsSource 只有两个取值：新闻抓取成功并叠加为 'live'；
   * 未启用或抓取失败/超时（实验组退化为基线）时为 'none'。
   */
  BacktestEvaluation: {
    type: 'object',
    properties: {
      baseline: {
        $ref: '#/components/schemas/BacktestResult',
        description: '基线：同区间、不叠加任何信号',
      },
      experiment: {
        $ref: '#/components/schemas/BacktestResult',
        description: '实验组：叠加新闻情绪（抓取失败时与基线同值）',
      },
      comparison: { $ref: '#/components/schemas/BacktestComparison' },
      newsSource: {
        type: 'string',
        enum: ['live', 'none'],
        description: 'live=实时抓到并叠加；none=未启用或抓取失败，实验组退化为基线',
      },
    },
    required: ['baseline', 'experiment', 'comparison', 'newsSource'],
  },

  /**
   * 基线 vs 实验组的受控对比（BacktestEvaluation.comparison）。
   * 字段来源：server/src/quant/backtestEvaluator.ts 的 BacktestComparison。
   * 统计量的出现条件必须知道：配对日收益不足 30 个（insufficient_sample）
   * 时**不产出** t/p/DSR/PSR/MinTRL/Bootstrap，只给 verdict=inconclusive
   * 与一条 caveat——所以这些字段一律不进 required，而不是给假默认值。
   * nonNormality / bootstrap / deflatedSharpeRatio / probabilisticSharpeRatio /
   * minTrackRecordLength 同理按需出现（DSR 与 MinTRL 还要求搜索次数 N>1 等条件，
   * MinTRL 在 sr=0 时算出 Infinity，服务端因此不写该键）。
   */
  BacktestComparison: {
    type: 'object',
    properties: {
      metrics: {
        type: 'array',
        description: '逐指标对比（7 项固定口径）',
        items: { $ref: '#/components/schemas/MetricDelta' },
      },
      alphaAnnualized: { type: 'number', description: '超额年化收益（百分点）' },
      tStatistic: { type: 'number', description: '配对日收益差 t 统计量' },
      significance: {
        type: 'string',
        enum: [
          'significant_strong',
          'significant_marginal',
          'not_significant',
          'insufficient_sample',
        ],
        description: 'Harvey-Liu-Zhu(2016) 分级：|t|>3 强显著、2<|t|≤3 边际显著',
      },
      verdict: {
        type: 'string',
        enum: ['experiment_wins', 'baseline_wins', 'tie', 'inconclusive'],
      },
      summary: { type: 'string', description: '人类可读结论（中文，含 DSR/CI 数字）' },
      caveats: {
        type: 'array',
        items: { type: 'string' },
        description: '注意事项（数据质量/样本量/过拟合/非正态/成本）',
      },
      nonNormality: {
        type: 'object',
        description: '差值序列的非正态诊断；样本 ≥30 时出现',
        properties: {
          skewness: { type: 'number' },
          excessKurtosis: { type: 'number' },
          nonNormal: { type: 'boolean', description: 'true=偏离正态，t 检验假设不成立' },
          warning: { type: 'string', description: '非正态时的提示；正态时为空串' },
        },
        required: ['skewness', 'excessKurtosis', 'nonNormal', 'warning'],
      },
      deflatedSharpeRatio: {
        type: 'number',
        description: 'DSR ∈ [0,1]：校正搜索次数/非正态/样本长度后真实 SR>0 的概率',
      },
      probabilisticSharpeRatio: {
        type: 'number',
        description: 'PSR ∈ [0,1]：未校正搜索次数的基准版',
      },
      minTrackRecordLength: {
        type: 'number',
        description: 'MinTRL：达到 DSR≥0.95 所需最短回测年数',
      },
      bootstrap: {
        type: 'object',
        description: '配对 Block Bootstrap（Stationary Bootstrap）95% 置信区间',
        properties: {
          ci95: {
            type: 'array',
            description: '[下限, 上限]',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
          },
          pValue: { type: 'number', description: '配对差均值 > 0 的 bootstrap p 值（单尾）' },
          iterations: { type: 'number', description: '重采样次数' },
          crossesZero: { type: 'boolean', description: 'CI 跨 0 = 不显著（此时以它为准）' },
        },
        required: ['ci95', 'pValue', 'iterations', 'crossesZero'],
      },
    },
    required: [
      'metrics',
      'alphaAnnualized',
      'tStatistic',
      'significance',
      'verdict',
      'summary',
      'caveats',
    ],
  },

  /**
   * 实验台账概览（GET /api/quant/factor/experiments 的 summary）。
   * 字段来源：server/src/quant/factorLedger.ts 的 summarizeFactorExperiments。
   * 注意 summary 统计的是**全量台账**（含被 source/kept/limit 过滤掉的部分），
   * 与 items 是过滤后的关系——limit=10 时 items 十条、summary.total 仍是全量。
   * keptExpectedFalse 是「采信集里期望的假阳性数**上界**」= kept × 0.05
   * （最坏情形「采信集全是真原假设」恰为该值），不是 ΣpValue。
   */
  FactorExperimentSummary: {
    type: 'object',
    properties: {
      total: { type: 'number', description: '台账总条数' },
      kept: { type: 'number', description: '被采信的条数' },
      bySource: {
        type: 'object',
        description: '来源 → 条数（cross-section / expression / hypothesis）',
        additionalProperties: { type: 'number' },
      },
      lastAt: {
        type: 'string',
        nullable: true,
        description: '最近一次实验时间；台账为空时为 null',
      },
      keptExpectedFalse: {
        type: 'number',
        description: '采信集的期望假阳性数上界 = kept × 0.05',
      },
      keptOosShare: {
        type: 'number',
        description: '采信集中 OOS 稳定的占比 ∈ [0,1]；无采信项时为 0',
      },
    },
    required: ['total', 'kept', 'bySource', 'lastAt', 'keptExpectedFalse', 'keptOosShare'],
  },
};
