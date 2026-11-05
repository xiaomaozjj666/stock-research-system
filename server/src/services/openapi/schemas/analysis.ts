export const analysisSchemas = {
  /**
   * 完整分析结果（POST /api/analyze、SSE done 事件、GET /api/history/{id} 共用）。
   * 字段与 server/src/types.ts 的 AnalysisResult 逐条对齐——**那份是权威**，
   * 此处是它面向消费方的投影。两者不一致时以 types.ts 为准并修这里。
   */
  AnalysisResult: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string', description: '报告生成时间（ISO）' },
      dataAsOf: { type: 'string', description: '行情数据截止日 YYYY-MM-DD' },
      stock_pool: {
        type: 'array',
        description: '个股研判明细（单股分析通常只有 1 项）',
        items: { $ref: '#/components/schemas/StockPoolItem' },
      },
      data_sources: { type: 'array', items: { $ref: '#/components/schemas/DataSource' } },
      research_confidence: { type: 'string', description: '研究置信度（高/中/低）' },
      limitation_explain: { type: 'string', description: '局限性说明' },
    },
    required: ['stock_pool', 'data_sources', 'research_confidence', 'limitation_explain'],
  },
  ExpertOpinion: {
    type: 'object',
    properties: {
      expert: { type: 'string' },
      arguments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            confidence: { type: 'number' },
            type: { type: 'string', enum: ['support', 'oppose'] },
            evidenceType: {
              type: 'string',
              enum: ['fact', 'inference', 'hypothesis', 'assumption'],
              description: '论据性质',
            },
          },
          required: ['text', 'confidence', 'type'],
        },
      },
      overallSentiment: {
        type: 'string',
        enum: ['bullish', 'neutral', 'bearish'],
      },
      confidence: { type: 'number' },
      keyPoints: { type: 'array', items: { type: 'string' } },
    },
    required: ['expert', 'arguments', 'overallSentiment', 'confidence', 'keyPoints'],
  },
  PriceHistoryPoint: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      open: { type: 'number' },
      high: { type: 'number' },
      low: { type: 'number' },
      close: { type: 'number' },
      volume: { type: 'number' },
      isSimulated: { type: 'boolean', description: '取数失败降级为模拟数据' },
    },
    required: ['date', 'open', 'high', 'low', 'close', 'volume'],
  },
  /** 研究历史摘要项（GET /api/history 列表项） */
  HistorySummary: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      stockCode: { type: 'string' },
      stockName: { type: 'string' },
      createdAt: { type: 'string' },
      rating: { type: 'string' },
      totalScore: { type: 'number' },
      industry: { type: 'string' },
      timeline: {
        type: 'array',
        description: '评分/评级时间线（旧数据可能没有该字段）',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            score: { type: 'number' },
            rating: { type: 'string' },
          },
          required: ['date', 'score', 'rating'],
        },
      },
    },
    required: ['id', 'stockCode', 'stockName', 'createdAt', 'rating', 'totalScore'],
  },
  /** 多股对比：支持部分成功（failures 仅在有失败项时出现） */
  CompareResponse: {
    type: 'object',
    properties: {
      stocks: {
        type: 'array',
        description: '成功项，顺序与请求一致',
        items: { $ref: '#/components/schemas/StockPoolItem' },
      },
      failures: {
        type: 'array',
        description:
          '失败项。**全部成功时该字段不出现**（与旧契约逐字兼容），消费方须按 `?? []` 处理',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '请求里的股票代码' },
            error: { type: 'string', description: '可读中文原因（不含堆栈/上游 URL）' },
            errorCode: {
              type: 'string',
              description: '机器可读原因，如 DATA_UNAVAILABLE / LLM_QUEUE_TIMEOUT',
            },
          },
          required: ['code', 'error'],
        },
      },
    },
    required: ['stocks'],
  },

  /* ===== 以下为 2026-10-04 补录的「非量化域」200 响应组件 =====
           此前 64 个 operation 里只有 2 个的 200 带 schema，其余只有一句
           description——而那句 description 早就把字段名写清楚了（`{ deleted: true }`、
           `available/embeddingEnabled/registry/routing`…），却没落成机器可读的形状。
           本组把 handler 与 service 里已经写死的字段落成具名组件：字段全部来自
           server/src/{routes,services,llm,quant} 与 client/src/api/client.ts 的
           实际类型（后者是很好的 ground truth：它按消费方视角声明了同一形状）。 */

  /**
   * 研究历史详情（GET /api/history/{id}）。
   * 字段来源：server/src/services/historyService.ts 的 HistoryItem
   * （= HistorySummary & { result: AnalysisResult }）。用 allOf 复用摘要
   * 组件而不是把六个字段重抄一遍——两处定义漂移过一次就该只留一处。
   */
  HistoryItem: {
    allOf: [
      { $ref: '#/components/schemas/HistorySummary' },
      {
        type: 'object',
        description: '详情比列表多带完整分析结果（可恢复研究报告渲染）',
        properties: {
          result: { $ref: '#/components/schemas/AnalysisResult' },
        },
        required: ['result'],
      },
    ],
  },

  /** 可比公司分析（ValuationModelResult.comparables） */
  ComparableAnalysis: {
    type: 'object',
    properties: {
      peers: {
        type: 'array',
        description: '过滤掉 PE/PB 非正后的有效样本',
        items: { $ref: '#/components/schemas/ComparableRow' },
      },
      sampleSize: { type: 'number' },
      medianPe: { type: 'number', nullable: true, description: '中位数比均值抗离群' },
      medianPb: { type: 'number', nullable: true },
      medianRoe: { type: 'number', nullable: true },
      pePremiumPct: {
        type: 'number',
        nullable: true,
        description: '本股相对同业中位 PE 的折溢价（小数）；样本不足为 null',
      },
      pbPremiumPct: { type: 'number', nullable: true },
      impliedValueByMedianPe: {
        type: 'number',
        nullable: true,
        description: '中位 PE × 本股 EPS 的隐含每股价值；EPS 缺失为 null',
      },
    },
    required: [
      'peers',
      'sampleSize',
      'medianPe',
      'medianPb',
      'medianRoe',
      'pePremiumPct',
      'pbPremiumPct',
      'impliedValueByMedianPe',
    ],
  },
};
