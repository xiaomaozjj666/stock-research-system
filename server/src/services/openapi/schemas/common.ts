export const commonSchemas = {
  /**
   * 全项目统一的错误响应体。
   * detail 只在非生产环境回传（见 utils/errorDetail.ts），生产环境为
   * 精简后的可读文案或缺省——它**不是**稳定契约，消费方不应依赖它。
   */
  ErrorResponse: {
    type: 'object',
    properties: {
      error: { type: 'string', description: '可直接展示给用户的中文说明' },
      detail: {
        type: 'string',
        description: '内部细节，仅非生产环境回传；不保证稳定，消费方不应依赖',
      },
      code: { type: 'string', description: '机器可读错误码（如 ANALYSIS_IN_FLIGHT）' },
    },
    required: ['error'],
  },
  /** 仅确认语义的操作（成本重置 / 清空对话记忆 / 删除历史） */
  OkResult: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
  /** 评级命中率统计（决策-结果闭环）；样本不足时准确率为 null */
  RatingAccuracy: {
    type: 'object',
    properties: {
      sampleCount: { type: 'number', description: '已评估样本数' },
      judgedCount: { type: 'number', description: '参与命中判定的样本数（排除中性评级）' },
      hitCount: { type: 'number' },
      accuracyPct: {
        type: 'number',
        nullable: true,
        description: '命中率 %；样本不足为 null',
      },
      avgReturnPct: { type: 'number', nullable: true, description: '平均区间收益 %' },
      pendingCount: { type: 'number', description: '已记录但未到期（<20 天）的样本数' },
    },
    required: ['sampleCount', 'judgedCount', 'hitCount', 'accuracyPct', 'avgReturnPct'],
  },
  /** 行业轮动信号（附行业 beta 曝光参考） */
  SectorRotation: {
    type: 'object',
    properties: {
      sector: { type: 'string' },
      compositeScore: { type: 'number' },
      rank: { type: 'number' },
      recommendation: { type: 'string', enum: ['overweight', 'neutral', 'underweight'] },
      prosperity: { type: 'number' },
      trend: { type: 'number' },
      crowding: { type: 'number' },
      industryBeta: { type: 'number', description: '杠杆代理估算，非回归结果' },
      summary: { type: 'string' },
      date: { type: 'string' },
    },
    required: [
      'sector',
      'compositeScore',
      'rank',
      'recommendation',
      'prosperity',
      'trend',
      'crowding',
      'industryBeta',
      'summary',
      'date',
    ],
  },
  /** 机构一致预期快照 */
  ConsensusSnapshot: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      orgNum: { type: 'number', nullable: true },
      ratings: {
        type: 'object',
        properties: {
          buy: { type: 'number', nullable: true },
          add: { type: 'number', nullable: true },
          neutral: { type: 'number', nullable: true },
          reduce: { type: 'number', nullable: true },
          sale: { type: 'number', nullable: true },
        },
        required: ['buy', 'add', 'neutral', 'reduce', 'sale'],
      },
      forecasts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            year: { type: 'number' },
            eps: { type: 'number' },
            mark: { type: 'string', enum: ['A', 'E'] },
          },
          required: ['year', 'eps', 'mark'],
        },
      },
      targetPriceMax: { type: 'number', nullable: true },
      targetPriceMin: { type: 'number', nullable: true },
      north: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          holdSharesRatio: { type: 'number', nullable: true },
          holdMarketCap: { type: 'number', nullable: true },
        },
        required: ['date', 'holdSharesRatio', 'holdMarketCap'],
      },
    },
    required: ['code', 'orgNum', 'ratings', 'forecasts', 'targetPriceMax', 'targetPriceMin'],
  },
  /** 单只标的的完整研判条目 */
  StockPoolItem: {
    type: 'object',
    properties: {
      stock_code: { type: 'string' },
      stock_name: { type: 'string' },
      industry: { type: 'string' },
      core_summary: { type: 'string', description: '核心结论摘要' },
      total_score: { type: 'number' },
      rating: { type: 'string' },
      score_detail: {
        type: 'object',
        description: '分项评分',
        properties: {
          profit_quality: { type: 'number' },
          growth: { type: 'number' },
          valuation: { type: 'number' },
          industry_boom: { type: 'number' },
          risk_deduction: { type: 'number' },
        },
        required: ['profit_quality', 'growth', 'valuation', 'industry_boom', 'risk_deduction'],
      },
      strengths: { type: 'array', items: { type: 'string' } },
      risk_list: { type: 'array', items: { type: 'string' } },
      controversy_points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            bullishView: { type: 'string' },
            bearishView: { type: 'string' },
            arbitration: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['topic', 'bullishView', 'bearishView', 'arbitration', 'confidence'],
        },
      },
      finance_metrics: { $ref: '#/components/schemas/FinancialData' },
      valuation: { $ref: '#/components/schemas/ValuationData' },
      valuation_level: { type: 'string', description: '估值水位判断' },
      expert_opinions: {
        type: 'array',
        items: { $ref: '#/components/schemas/ExpertOpinion' },
      },
      reflection_notes: { type: 'array', items: { type: 'string' } },
      chart_list: { type: 'array', items: { $ref: '#/components/schemas/ChartConfig' } },
      follow_up_indicators: { type: 'array', items: { type: 'string' } },
      scenarios: { type: 'array', items: { $ref: '#/components/schemas/ScenarioResult' } },
      strategyList: {
        type: 'array',
        items: { $ref: '#/components/schemas/StrategyRecommendation' },
      },
      newsSentiment: { $ref: '#/components/schemas/NewsSignal' },
      priceHistory: {
        type: 'array',
        description: '日 K 线；取数失败降级为模拟数据（isSimulated=true）',
        items: { $ref: '#/components/schemas/PriceHistoryPoint' },
      },
      vs_previous: {
        type: 'object',
        description: '与上次分析的对比（记忆反思闭环）',
        properties: {
          previous_date: { type: 'string' },
          previous_rating: { type: 'string' },
          previous_score: { type: 'number' },
          score_delta: { type: 'number' },
          rating_changed: { type: 'boolean' },
        },
        required: [
          'previous_date',
          'previous_rating',
          'previous_score',
          'score_delta',
          'rating_changed',
        ],
      },
      degraded_experts: {
        type: 'array',
        items: { type: 'string' },
        description: '本次降级的专家名单（单专家失败不影响整体）',
      },
      /** 机构一致预期快照（可选；盈利预测/评级分布/北向持股，当前快照口径） */
      consensus: { $ref: '#/components/schemas/ConsensusSnapshot' },
      /** 风险归因（可选；风格因子暴露 + 系统/特异风险分解） */
      riskAttribution: {
        type: 'object',
        properties: {
          exposures: {
            type: 'object',
            properties: {
              size: { type: 'number' },
              value: { type: 'number' },
              momentum: { type: 'number' },
              profitability: { type: 'number' },
              leverage: { type: 'number' },
            },
            required: ['size', 'value', 'momentum', 'profitability', 'leverage'],
          },
          decomposition: {
            type: 'object',
            properties: {
              systematicVol: { type: 'number' },
              specificVol: { type: 'number' },
              totalVol: { type: 'number' },
              explainedRatio: { type: 'number' },
            },
            required: ['systematicVol', 'specificVol', 'totalVol', 'explainedRatio'],
          },
        },
        required: ['exposures', 'decomposition'],
      },
      /** 行业轮动信号（可选；股票有行业归属时附加） */
      sectorRotation: { $ref: '#/components/schemas/SectorRotation' },
      /** 最近公告语境（可选；标题一览 + 最新一篇正文摘录） */
      announcement_brief: { type: 'string' },
      /** 知识图谱增强上下文（可选） */
      knowledgeGraphContext: { type: 'string' },
      /** MCP 外部工具上下文（可选；仅配置 MCP_SERVER_URL 时附加） */
      mcpContext: {
        type: 'object',
        properties: {
          serverUrl: { type: 'string' },
          toolCount: { type: 'number' },
          tools: { type: 'array', items: { type: 'string' } },
        },
        required: ['serverUrl', 'toolCount', 'tools'],
      },
      /** 评级事后校准（可选；决策-结果闭环） */
      rating_accuracy: {
        type: 'object',
        properties: {
          stock: { $ref: '#/components/schemas/RatingAccuracy' },
          overall: { $ref: '#/components/schemas/RatingAccuracy' },
        },
        required: ['stock', 'overall'],
      },
    },
    required: [
      'stock_code',
      'stock_name',
      'industry',
      'core_summary',
      'total_score',
      'rating',
      'score_detail',
      'strengths',
      'risk_list',
      'controversy_points',
      'finance_metrics',
      'valuation',
      'valuation_level',
      'expert_opinions',
      'reflection_notes',
      'chart_list',
      'follow_up_indicators',
    ],
  },
  /** 多年财务数据（各序列按 years 下标对齐） */
  FinancialData: {
    type: 'object',
    properties: {
      years: { type: 'array', items: { type: 'string' } },
      revenue: { type: 'array', items: { type: 'number' } },
      netProfit: { type: 'array', items: { type: 'number' } },
      grossMargin: { type: 'array', items: { type: 'number' } },
      netMargin: { type: 'array', items: { type: 'number' } },
      roe: { type: 'array', items: { type: 'number' } },
      operatingCashFlow: { type: 'array', items: { type: 'number' } },
      eps: { type: 'array', items: { type: 'number' } },
      totalAssets: { type: 'array', items: { type: 'number' } },
      totalLiabilities: { type: 'array', items: { type: 'number' } },
      equity: { type: 'array', items: { type: 'number' } },
      accountsReceivable: { type: 'array', items: { type: 'number' } },
      inventory: { type: 'array', items: { type: 'number' } },
      goodwill: { type: 'array', items: { type: 'number' } },
      debtRatio: { type: 'array', items: { type: 'number' } },
      capEx: { type: 'array', items: { type: 'number' }, description: '资本支出（亿元）' },
      dataQuality: {
        type: 'object',
        description: '数据质量标记：哪些字段是估算/缺失',
        properties: {
          estimatedFields: { type: 'array', items: { type: 'string' } },
          missingFields: { type: 'array', items: { type: 'string' } },
        },
        required: ['estimatedFields', 'missingFields'],
      },
    },
    required: [
      'years',
      'revenue',
      'netProfit',
      'grossMargin',
      'netMargin',
      'roe',
      'operatingCashFlow',
      'eps',
      'totalAssets',
      'totalLiabilities',
      'equity',
      'accountsReceivable',
      'inventory',
      'goodwill',
      'debtRatio',
    ],
  },
  DataSource: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      confidence: { type: 'number' },
      coverage: { type: 'string', description: '报告中哪些模块的数据来自该来源' },
    },
    required: ['name', 'description', 'confidence'],
  },
  ChartConfig: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      title: { type: 'string' },
      config: { type: 'object', additionalProperties: true },
    },
    required: ['type', 'title', 'config'],
  },
  ScenarioResult: {
    type: 'object',
    properties: {
      name: { type: 'string', enum: ['乐观', '中性', '悲观'] },
      probability: { type: 'number' },
      keyAssumptions: { type: 'array', items: { type: 'string' } },
      targetPriceRange: {
        type: 'object',
        properties: { low: { type: 'number' }, high: { type: 'number' } },
        required: ['low', 'high'],
      },
      preconditions: { type: 'array', items: { type: 'string' } },
      supportingArguments: {
        type: 'array',
        description: '支撑该情景的专家论据',
        items: {
          type: 'object',
          properties: {
            expert: { type: 'string' },
            text: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['expert', 'text', 'confidence'],
        },
      },
    },
    required: [
      'name',
      'probability',
      'keyAssumptions',
      'targetPriceRange',
      'preconditions',
      'supportingArguments',
    ],
  },
  /** 最新消息情绪信号 */
  NewsSignal: {
    type: 'object',
    properties: {
      polarity: { type: 'number', description: '加权极性 [-1,1]' },
      sentimentZ: { type: 'number' },
      bullishRatio: { type: 'number', description: '看多占比 [0,1]' },
      newsCount: { type: 'number' },
      freshness: { type: 'number' },
      weightedImpact: { type: 'number' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            publishedAt: { type: 'string', format: 'date-time' },
            source: { type: 'string' },
            polarity: { type: 'number' },
          },
          required: ['id', 'title', 'publishedAt'],
        },
      },
      hasNews: { type: 'boolean' },
    },
    required: [
      'polarity',
      'sentimentZ',
      'bullishRatio',
      'newsCount',
      'freshness',
      'weightedImpact',
      'items',
      'hasNews',
    ],
  },
  /** 合规审计条目（金融监管 8 号文） */
  AuditEntry: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      timestamp: { type: 'number', description: 'epoch 毫秒' },
      sessionId: { type: 'string' },
      userId: { type: 'string' },
      action: { type: 'string', description: '如 llm.chat / tool.run_analysis' },
      category: {
        type: 'string',
        enum: ['llm_call', 'tool_call', 'trade_signal', 'data_access', 'user_query', 'system'],
      },
      detail: { type: 'string' },
      riskLevel: {
        type: 'string',
        enum: ['info', 'low', 'medium', 'high', 'critical'],
      },
      traceId: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
    },
    required: ['id', 'timestamp', 'sessionId', 'action', 'category', 'detail', 'riskLevel'],
  },
  /** 上游预检结果（量化健康检查的 preflight 字段，多个端点复用） */
  Preflight: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            ok: { type: 'boolean' },
            detail: { type: 'string' },
          },
          required: ['key', 'ok', 'detail'],
        },
      },
      degraded: { type: 'array', items: { type: 'string' } },
      checkedAt: { type: 'string' },
    },
    required: ['ok', 'checks', 'degraded', 'checkedAt'],
  },
  /**
   * 可复现运行快照（run 字段，多个量化端点复用）。
   *
   * 字段来源：services/quant/panelService.ts 的 runSnapshot() —— 它返回
   * `{ at, node, ...fields }`，而 fields 由各调用方传入，因此**逐个端点不同**：
   * composite-batch 传 startDate/endDate/requested，factor-expression 传
   * expression，cross-section 传 includeFundamental/includeEvents/concurrency/maxCodes。
   * start 与 startDate 并存是真实存在的口径差异（不是笔误），故两者都声明为可选。
   * 除 kind 外一律可选：不同 kind 携带的字段本就不一样。
   */
  RunSnapshot: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: '运行种类（如 cross-section / composite-batch）' },
      at: { type: 'string', description: '快照时刻（ISO）' },
      node: { type: 'string', description: '产出该快照的 Node 版本' },
      start: { type: 'string', description: '取数起始日（截面/表达式系端点）' },
      end: { type: 'string', description: '取数结束日（截面/表达式系端点）' },
      startDate: {
        type: 'string',
        description: '取数起始日（composite-batch 用此名，非 start）',
      },
      endDate: {
        type: 'string',
        description: '取数结束日（composite-batch 用此名，非 end）',
      },
      horizons: { type: 'array', items: { type: 'number' } },
      expression: { type: 'string', description: '因子表达式原文（仅表达式系端点）' },
      requested: { type: 'number', description: '请求只数（仅 composite-batch）' },
      includeFundamental: { type: 'boolean', description: '是否含基本面因子族（仅截面）' },
      includeEvents: { type: 'boolean', description: '是否含事件因子族（仅截面）' },
      concurrency: { type: 'number', description: '取数并发度（仅截面）' },
      maxCodes: { type: 'number', description: '截面宽度上限（仅截面）' },
    },
    required: ['kind'],
  },
  /** 行业板块（universe 下拉用） */
  IndustryBoard: {
    type: 'object',
    properties: { code: { type: 'string' }, name: { type: 'string' } },
    required: ['code', 'name'],
  },

  /**
   * 模型注册表单项（GET /api/models 的 registry 元素）。
   * 字段来源：server/src/llm/config.ts 的 ModelSpec。tasks 的取值域来自
   * 同文件的 LLMTask 联合类型（六个任务标签，逐条对齐）。
   */
  ModelSpec: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '模型 ID（传给上游的 model 值）' },
      label: { type: 'string', description: '展示名' },
      costPer1kInput: {
        type: 'number',
        description: '输入单价（USD / 1k token，未配置时 0）',
      },
      costPer1kOutput: {
        type: 'number',
        description: '输出单价（USD / 1k token，未配置时 0）',
      },
      tasks: {
        type: 'array',
        description: '该模型擅长的任务标签（路由的候选集合）',
        items: {
          type: 'string',
          enum: ['chat', 'analysis', 'debate', 'extract', 'reasoning', 'embedding'],
        },
      },
    },
    required: ['id', 'label', 'costPer1kInput', 'costPer1kOutput', 'tasks'],
  },

  /**
   * 模型注册表与任务路由（GET /api/models）。
   * 字段来源：server/src/routes/cost.ts 的 GET /api/models + llm/config.ts。
   * routing 是 tasks → 模型 ID 的映射（六个键恒定出现，值随 selectModel 变化），
   * 声明成 additionalProperties 字典而不是逐键列举：键集合就是上面的 LLMTask
   * 枚举，逐处复制会在枚举扩容时静默分叉。
   */
  ModelRoutingInfo: {
    type: 'object',
    properties: {
      available: { type: 'boolean', description: 'LLM 是否可用（已配置 API key）' },
      embeddingEnabled: { type: 'boolean', description: '嵌入模型是否已配置' },
      registry: { type: 'array', items: { $ref: '#/components/schemas/ModelSpec' } },
      routing: {
        type: 'object',
        description: '任务标签 → 选中的模型 ID',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['available', 'embeddingEnabled', 'registry', 'routing'],
  },

  /**
   * LLM 成本报告（GET /api/cost）。
   * 字段来源：server/src/llm/cost.ts 的 CostReport。
   * 注意 byModel 的元素**只有 cost / calls 两项**——服务端聚合时并不保留
   * 分模型的 token 数（那是前端 CostReport 类型的旧假设，服务端从未这么回）。
   * 口径为生命周期累计：被容量上限淘汰的条目其用量并入累计，故总额不随运行时长缩水。
   */
  CostReport: {
    type: 'object',
    properties: {
      totalCost: { type: 'number', description: '累计估算成本（USD，保留 6 位小数）' },
      totalPromptTokens: { type: 'number', description: '累计输入 token' },
      totalCompletionTokens: { type: 'number', description: '累计输出 token' },
      callCount: { type: 'number', description: '累计调用次数' },
      byModel: {
        type: 'object',
        description: '模型 ID → 该模型的用量聚合',
        additionalProperties: {
          type: 'object',
          properties: {
            cost: { type: 'number' },
            calls: { type: 'number' },
          },
          required: ['cost', 'calls'],
        },
      },
    },
    required: ['totalCost', 'totalPromptTokens', 'totalCompletionTokens', 'callCount', 'byModel'],
  },

  /**
   * 健康检查（GET /api/health 200 态）。
   * 字段来源：server/src/routes/health.ts。
   * 关键口径：status 恒为 'ok'——**降级信息在 HTTP 状态码（503）里**，
   * 不靠 status 字段表达；两个 cacheDir 各自独立报告（共享目录时也能看出
   * 路径解析是否符合预期）；externalApi.checkedAt 记录结论的产出时刻，
   * 配合 cached 区分「此刻可达」与「最近一次探测可达」。
   */
  HealthReport: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '恒为 ok；降级由 HTTP 503 表达而非本字段' },
      timestamp: { type: 'string', description: '本次响应生成时间（ISO）' },
      uptime: { type: 'number', description: '进程运行时长（秒）' },
      memory: {
        type: 'object',
        description: 'process.memoryUsage() 原始返回（单位字节）',
        additionalProperties: { type: 'number' },
      },
      externalApi: { $ref: '#/components/schemas/ExternalApiProbe' },
      cacheDir: { $ref: '#/components/schemas/CacheDirStatus' },
      quantCacheDir: { $ref: '#/components/schemas/CacheDirStatus' },
    },
    required: [
      'status',
      'timestamp',
      'uptime',
      'memory',
      'externalApi',
      'cacheDir',
      'quantCacheDir',
    ],
  },

  /**
   * 外呼探测结果（HealthReport 的 externalApi）。
   * 字段来源：health.ts 的 probeExternalApi / ExternalApiProbe。
   * reachable 时有 httpStatus、unreachable 时有 error，二者都只到不了时缺省；
   * cached=true 表示结论来自 60 秒 memo 窗口（本次未真正外呼）。
   */
  ExternalApiProbe: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['reachable', 'unreachable'] },
      httpStatus: { type: 'number', description: '上游 HTTP 状态码；仅 reachable 时出现' },
      error: { type: 'string', description: '失败原因；仅 unreachable 时出现' },
      checkedAt: {
        type: 'string',
        description: '该结论的产出时刻（memo 命中时是过去的时间）',
      },
      cached: { type: 'boolean', description: 'true=结论来自 memo，本次未真正外呼' },
    },
    required: ['status', 'checkedAt', 'cached'],
  },

  /**
   * 缓存目录状态（HealthReport 的 cacheDir / quantCacheDir）。
   * 字段来源：health.ts 的 describeCacheDir。
   * missing 不是故障（全新部署尚未发生任何分析），此时**没有** error 字段；
   * error 存在即意味着该目录不可读写，路由据此回 503。
   */
  CacheDirStatus: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'missing', 'error'] },
      path: { type: 'string', description: '绝对路径（如实回传，便于运维定位）' },
      error: { type: 'string', description: '不可读写的原因；仅 status=error 时出现' },
    },
    required: ['status', 'path'],
  },

  /** 计算型错误（AnswerVerification.calculationErrors 的元素） */
  CalculationError: {
    type: 'object',
    properties: {
      claim: { type: 'string', description: '回答中的原始断言文本' },
      reconstructedFormula: { type: 'string', description: '核查员重构的算术公式' },
      recomputedValue: { type: 'string', description: '按公式重算的结果' },
      claimedValue: { type: 'string', description: '回答中给出的数值' },
      discrepancy: { type: 'string', description: '不一致的说明' },
    },
    required: ['claim', 'reconstructedFormula', 'recomputedValue', 'claimedValue', 'discrepancy'],
  },

  /**
   * 分析流式事件（GET /api/analyze/stream 的单帧 JSON）。
   * 字段来源：server/src/services/analysisPipeline.ts 的 AnalysisStage，
   * 外加路由在失败时补发的 error 事件（analysis.ts 里 sse.trySend 的
   * `{ phase:'error', message, code? }`——SSE 已 flushHeaders，状态码改不了，
   * 故排队超时/在途冲突都靠这个 code 区分）。
   * 同样按 client.ts 的 AnalysisStage 口径声明为扁平对象。
   */
  AnalyzeStreamEvent: {
    type: 'object',
    properties: {
      phase: {
        type: 'string',
        enum: ['data', 'experts', 'arbitration', 'scoring', 'strategy', 'done', 'error'],
      },
      message: { type: 'string', description: '该阶段的人话进度说明' },
      totalScore: { type: 'number', description: '综合评分；仅 phase=scoring 时出现' },
      rating: { type: 'string', description: '评级；仅 phase=scoring 时出现' },
      result: {
        $ref: '#/components/schemas/AnalysisResult',
        description: '完整分析报告；仅 phase=done 时出现',
      },
      code: {
        type: 'string',
        description:
          '机器可读错误码（如 LLM_QUEUE_TIMEOUT / ANALYSIS_IN_FLIGHT）；仅 phase=error 时出现',
      },
    },
    required: ['phase', 'message'],
  },

  /* ===== 改进闭环（harness policy + 台账 + 调度）===== */

  /**
   * 因子判据（HarnessPolicy）。
   * 字段来源：server/src/quant/harnessPolicy.ts 的 HarnessPolicy。
   * 这是「改进闭环」的被改进对象，故单独成组件：status.policy、run.policy、
   * ImprovementRecord 的 before/after 四处共用同一形状。
   */
  HarnessPolicy: {
    type: 'object',
    properties: {
      minIcSamples: { type: 'number', description: 'IC 最小有效样本期数，不足直接判无效' },
      significanceLevel: {
        type: 'number',
        description: '显著性水平；IC 的 p 值须严格小于它',
      },
      minMonotonicity: {
        type: 'number',
        description: '分档收益单调性下限（Spearman 秩相关）',
      },
      requirePositiveSpread: {
        type: 'boolean',
        description: '是否要求多空价差为正（关闭后允许方向不成立的因子被采信）',
      },
    },
    required: ['minIcSamples', 'significanceLevel', 'minMonotonicity', 'requirePositiveSpread'],
  },

  /** 本轮试过的一个候选判据（ImprovementRecord.tried 的元素） */
  TriedCandidate: {
    type: 'object',
    properties: {
      policy: { $ref: '#/components/schemas/HarnessPolicy' },
      trainScore: {
        type: 'number',
        nullable: true,
        description: '训练集得分；无法评分时为 null',
      },
      validationScore: {
        type: 'number',
        nullable: true,
        description: '验证集得分；非最终候选不评验证集时为 null',
      },
    },
    required: ['policy', 'trainScore', 'validationScore'],
  },

  /** IC 显著性（factorEvaluation.IcSignificance） */
  IcSignificance: {
    type: 'object',
    properties: {
      n: { type: 'number', description: 'IC 序列长度（参与计算的天数）' },
      mean: { type: 'number', description: 'IC 均值' },
      std: { type: 'number', description: 'IC 标准差（样本口径 ddof=1）' },
      ir: { type: 'number', description: '信息比率 IR = mean / std' },
      tStat: { type: 'number', description: 't 统计量（启用 Newey-West 时为 HAC 修正值）' },
      pValue: { type: 'number', description: '双侧 p 值（H₀: IC = 0）' },
      skew: { type: 'number', description: 'IC 分布偏度' },
      excessKurtosis: { type: 'number', description: 'IC 分布超额峰度（正态 = 0）' },
      nwMaxLag: {
        type: 'number',
        description: 'Newey-West 最大滞后阶 = period−1；iid 口径时不出现',
      },
    },
    required: ['n', 'mean', 'std', 'ir', 'tStat', 'pValue', 'skew', 'excessKurtosis'],
  },

  /** 样本外稳定性复核（前 70% vs 后 30% 的 IC 方向与显著性） */
  OosStability: {
    type: 'object',
    properties: {
      isMeanIc: { type: 'number', description: '样本内 IC 均值' },
      oosMeanIc: { type: 'number', description: '样本外 IC 均值' },
      signAgree: { type: 'boolean', description: '两段 IC 均值同号' },
      isSignificant: { type: 'boolean' },
      oosSignificant: { type: 'boolean' },
      stable: { type: 'boolean', description: '方向同号且两段都显著才为 true' },
      isN: { type: 'number', description: '样本内 IC 天数' },
      oosN: { type: 'number', description: '样本外 IC 天数' },
    },
    required: [
      'isMeanIc',
      'oosMeanIc',
      'signAgree',
      'isSignificant',
      'oosSignificant',
      'stable',
      'isN',
      'oosN',
    ],
  },

  /** 因子换手率与排序自相关（factorEvaluation.TurnoverResult） */
  TurnoverResult: {
    type: 'object',
    properties: {
      byQuantile: {
        type: 'object',
        description: '档号 → 该档平均换手率 ∈ [0,1]（本期新进入该档的标的占比）',
        additionalProperties: { type: 'number' },
      },
      rankAutocorrelation: {
        type: 'number',
        description: '因子排序的平均自相关（滞后 lag 个截面）',
      },
      datePairs: { type: 'number', description: '参与计算的日期对数' },
    },
    required: ['byQuantile', 'rankAutocorrelation', 'datePairs'],
  },

  /** 单次调仓记录（PortfolioBacktestResult.rebalances 的元素） */
  RebalanceRecord: {
    type: 'object',
    properties: {
      date: { type: 'string', description: '决策日（t 日收盘计算因子）' },
      fillDate: { type: 'string', description: '建仓成交日（t+1 开盘撮合）' },
      exitDate: { type: 'string', description: '平仓成交日（与下一期建仓同日）' },
      endDate: { type: 'string', description: '期末日期（下一调仓日前一交易日 / 数据末日）' },
      holdings: {
        type: 'array',
        items: { type: 'string' },
        description: '持仓代码（因子值降序）',
      },
      turnover: { type: 'number', description: '换手率 ∈ [0,1]（首期为 1）' },
      grossReturn: { type: 'number', description: '本期组合收益（扣费前，小数）' },
      costDrag: { type: 'number', description: '本期成本拖累（负收益形式）' },
      benchmarkReturn: { type: 'number', description: '本期基准收益（小数）' },
    },
    required: [
      'date',
      'fillDate',
      'exitDate',
      'endDate',
      'holdings',
      'turnover',
      'grossReturn',
      'costDrag',
      'benchmarkReturn',
    ],
  },

  /** 未能参与因子评估的股票及原因（截面 / expression / expression-batch 共用） */
  StockSkip: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      reason: { type: 'string', description: '如「K线不足（12 根）」；中文可直接展示' },
    },
    required: ['code', 'reason'],
  },

  /**
   * 台账留痕回执（截面 / expression 的 ledger，expression-batch 只回 total）。
   * recorded 是本次写入条数，total 是台账现存总量——写盘失败时
   * recordFactorExperiments 返回空数组，故 recorded=0 是「没写进去」
   * 而非「没有实验」，两者必须分开读。
   */
  LedgerReceipt: {
    type: 'object',
    properties: {
      recorded: { type: 'number', description: '本次实际写入的台账条数；batch 端点不返回' },
      total: { type: 'number', description: '台账现存总条数' },
    },
    required: ['total'],
  },

  /** 数据质量报告（quant/types.ts 的 DataQualityReport） */
  DataQualityReport: {
    type: 'object',
    properties: {
      overallScore: { type: 'number', description: '质量评分 0-100' },
      totalRecords: { type: 'number' },
      missingDates: { type: 'array', items: { type: 'string' }, description: '缺失的交易日' },
      outliers: {
        type: 'array',
        description: '离群点',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            field: { type: 'string' },
            value: { type: 'number' },
            expected: { type: 'string', description: '预期区间的人话描述' },
          },
          required: ['date', 'field', 'value', 'expected'],
        },
      },
      duplicates: { type: 'array', items: { type: 'string' }, description: '重复日期' },
      issues: { type: 'array', items: { type: 'string' }, description: '问题描述' },
      suggestions: { type: 'array', items: { type: 'string' }, description: '预处理建议' },
      dataRange: {
        type: 'object',
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          tradingDays: { type: 'number' },
        },
        required: ['start', 'end', 'tradingDays'],
      },
    },
    required: [
      'overallScore',
      'totalRecords',
      'missingDates',
      'outliers',
      'duplicates',
      'issues',
      'suggestions',
      'dataRange',
    ],
  },

  /** 回测审计报告（quant/types.ts 的 AuditReport） */
  AuditReport: {
    type: 'object',
    properties: {
      riskScore: { type: 'number', description: '风险评分 0-100（越高越安全）' },
      futureFunctionRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
      overfittingRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
      survivorshipBias: { type: 'string', enum: ['low', 'medium', 'high'] },
      checks: {
        type: 'array',
        description: '逐项检查',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            passed: { type: 'boolean' },
            detail: { type: 'string' },
            severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
          },
          required: ['name', 'passed', 'detail', 'severity'],
        },
      },
      issues: { type: 'array', items: { type: 'string' } },
      reliability: { type: 'string', description: '可靠性评估文字' },
    },
    required: [
      'riskScore',
      'futureFunctionRisk',
      'overfittingRisk',
      'survivorshipBias',
      'checks',
      'issues',
      'reliability',
    ],
  },

  /** 策略优化报告（quant/types.ts 的 OptimizationReport） */
  OptimizationReport: {
    type: 'object',
    properties: {
      performanceScore: { type: 'number', description: '性能评分 0-100' },
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['parameter', 'risk', 'entry', 'exit', 'position'],
            },
            title: { type: 'string' },
            detail: { type: 'string' },
            impact: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['category', 'title', 'detail', 'impact'],
        },
      },
      parameterSensitivity: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            param: { type: 'string' },
            currentValue: { type: 'number' },
            suggestedRange: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
                optimal: { type: 'number' },
              },
              required: ['min', 'max', 'optimal'],
            },
            sensitivity: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['param', 'currentValue', 'suggestedRange', 'sensitivity'],
        },
      },
      riskMetrics: {
        type: 'object',
        properties: {
          var95: { type: 'number', description: '95% VaR' },
          maxConsecutiveLoss: { type: 'number' },
          avgHoldingDays: { type: 'number' },
        },
        required: ['var95', 'maxConsecutiveLoss', 'avgHoldingDays'],
      },
      iterationDirections: {
        type: 'array',
        items: { type: 'string' },
        description: '迭代优化方向',
      },
    },
    required: [
      'performanceScore',
      'suggestions',
      'parameterSensitivity',
      'riskMetrics',
      'iterationDirections',
    ],
  },

  /** 批量验证的单条结果（FactorExpressionBatchResult.results 的元素） */
  ExpressionBatchItem: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '表达式原文' },
      ok: { type: 'boolean', description: '该条是否评估成功' },
      error: {
        type: 'string',
        description: '失败原因（解析错误或观测不足）；ok=false 时出现',
      },
      stocksIncluded: {
        type: 'array',
        items: { type: 'string' },
        description: 'ok=true 时出现',
      },
      stocksSkipped: {
        type: 'array',
        description: '被跳过的股票；ok=true 时恒有，观测不足失败时也有',
        items: { $ref: '#/components/schemas/StockSkip' },
      },
      horizons: { type: 'array', items: { type: 'number' }, description: 'ok=true 时出现' },
      factor: { $ref: '#/components/schemas/ExpressionFactor' },
      portfolio: {
        oneOf: [{ $ref: '#/components/schemas/PortfolioBacktestResult' }, { type: 'null' }],
        description: '组合回测；ok=true 且请求了 portfolio 时出现',
      },
      ledger: {
        type: 'object',
        description: '本条的台账写入条数（ok=true 时出现）',
        properties: { recorded: { type: 'number' } },
        required: ['recorded'],
      },
    },
    required: ['expression', 'ok'],
  },

  /** 可比公司一行（ComparableAnalysis.peers 的元素） */
  ComparableRow: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      name: {
        type: 'string',
        description: '本股自身 name 为空串（它不来自 peerComparison）',
      },
      pe: { type: 'number', nullable: true },
      pb: { type: 'number', nullable: true },
      roe: { type: 'number', nullable: true },
      marketCap: { type: 'number', nullable: true },
    },
    required: ['code', 'name', 'pe', 'pb', 'roe', 'marketCap'],
  },

  /** 单个指标的基线/实验/差值（BacktestComparison.metrics 的元素） */
  MetricDelta: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        enum: [
          'totalReturn',
          'annualizedReturn',
          'sharpeRatio',
          'sortinoRatio',
          'maxDrawdown',
          'winRate',
          'profitFactor',
        ],
      },
      baseline: { type: 'number' },
      experiment: { type: 'number' },
      delta: {
        type: 'number',
        description: 'experiment − baseline（maxDrawdown 为负=改善）',
      },
      improved: {
        type: 'boolean',
        description: '改善方向是否为「好」（回撤↓好，其余↑好）',
      },
    },
    required: ['name', 'baseline', 'experiment', 'delta', 'improved'],
  },
};
