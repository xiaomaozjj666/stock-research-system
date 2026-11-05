export const portfolioSchemas = {
  /** 自选股列表（GET/POST/DELETE 三处共用同一形状） */
  WatchlistCodes: {
    type: 'object',
    properties: {
      codes: { type: 'array', items: { type: 'string' }, description: '当前自选股代码列表' },
    },
    required: ['codes'],
  },
  /** 自选股异动预警 */
  WatchlistAlert: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      name: { type: 'string', nullable: true },
      level: { type: 'string', enum: ['strong-bull', 'strong-bear', 'high-impact'] },
      polarity: { type: 'number' },
      weightedImpact: { type: 'number' },
      detail: { type: 'string' },
    },
    required: ['code', 'name', 'level', 'polarity', 'weightedImpact', 'detail'],
  },
  /** 自选股异动监控结果（POST /watchlist/monitor 与 GET /watchlist/alerts 共用） */
  WatchlistMonitorResult: {
    type: 'object',
    properties: {
      generatedAt: {
        type: 'string',
        nullable: true,
        description: '快照时间；从未监控过时为 null（端点仍回 200，不回 404）',
      },
      monitored: { type: 'number', description: '本次监控的标的数' },
      alerts: { type: 'array', items: { $ref: '#/components/schemas/WatchlistAlert' } },
      // 以下两个来自 watchlistService.normalizeAlertsSnapshot：**只在真的发生
      // 单次上限裁剪时才写入**（skipped > 0），无裁剪时响应里没有这两个键。
      requested: {
        type: 'number',
        description: '本轮请求的清单总只数（裁剪前）；仅在发生裁剪时出现',
      },
      skipped: {
        type: 'number',
        description: '因单次上限被跳过、本轮未取数的只数；仅在发生裁剪时出现',
      },
    },
    required: ['generatedAt', 'monitored', 'alerts'],
  },
  /** 模拟盘账户快照（GET /api/paper/portfolio） */
  PaperPortfolio: {
    type: 'object',
    properties: {
      initialCapital: { type: 'number' },
      cash: { type: 'number' },
      currentDate: { type: 'string', nullable: true, description: '当前交易日' },
      positions: { type: 'array', items: { $ref: '#/components/schemas/PaperPosition' } },
      orders: {
        type: 'array',
        description: '最近 50 笔订单',
        items: { $ref: '#/components/schemas/PaperOrder' },
      },
      equity: {
        type: 'array',
        description: '每日净值',
        items: { $ref: '#/components/schemas/PaperEquityPoint' },
      },
    },
    required: ['initialCapital', 'cash', 'currentDate', 'positions', 'orders', 'equity'],
  },
  PaperPosition: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      quantity: { type: 'number', description: '股数（100 整数倍）' },
      avgCost: { type: 'number', description: '摊薄成本（含买入佣金）' },
      buyDate: { type: 'string', description: '最近一次买入日 YYYY-MM-DD（T+1 校验用）' },
    },
    required: ['code', 'quantity', 'avgCost', 'buyDate'],
  },
  PaperOrder: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      code: { type: 'string' },
      side: { type: 'string', enum: ['buy', 'sell'] },
      type: { type: 'string', enum: ['market', 'limit'] },
      price: { type: 'number' },
      quantity: { type: 'number' },
      placedDate: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'filled', 'expired', 'rejected'],
      },
      fillDate: { type: 'string' },
      fillPrice: { type: 'number' },
      filledQuantity: { type: 'number' },
      commission: { type: 'number' },
      stampDuty: { type: 'number', description: '仅卖出产生' },
      rejectReason: { type: 'string' },
    },
    required: ['id', 'code', 'side', 'type', 'quantity', 'placedDate', 'status'],
  },
  PaperEquityPoint: {
    type: 'object',
    properties: {
      date: { type: 'string' },
      value: { type: 'number', description: '现金 + 持仓市值' },
    },
    required: ['date', 'value'],
  },
  /** 模拟盘绩效统计（GET /api/paper/stats） */
  PaperStats: {
    type: 'object',
    properties: {
      initialCapital: { type: 'number' },
      finalEquity: { type: 'number' },
      totalReturnPct: { type: 'number', nullable: true },
      maxDrawdownPct: { type: 'number', nullable: true },
      sharpeRatio: { type: 'number', nullable: true, description: '净值点不足时为 null' },
      totalDays: { type: 'number' },
      dailyReturns: {
        type: 'array',
        items: { type: 'number' },
        description: '逐日收益率（保留窗口内的有界数组，供前端画图）',
      },
    },
    required: [
      'initialCapital',
      'finalEquity',
      'totalReturnPct',
      'maxDrawdownPct',
      'sharpeRatio',
      'totalDays',
      'dailyReturns',
    ],
  },
  /**
   * 自选股批量「含最新消息回测」总报告（POST /api/watchlist/news-backtest）。
   *
   * 字段来源：server/src/services/watchlistBacktest.ts 的 runWatchlistNewsBacktest，
   * 其返回类型 WatchlistBacktestResult = 本组件 & { requested, skipped }——
   * 那两个字段由服务层无条件写入（不是可选），故这里也标为必填。
   */
  WatchlistNewsBacktestReport: {
    type: 'object',
    properties: {
      generatedAt: { type: 'string' },
      count: { type: 'number', description: '参与回测的代码数' },
      withNewsCount: { type: 'number', description: '其中命中最新消息的代码数' },
      requested: {
        type: 'number',
        description: '本轮请求的原始只数（含格式非法被 normalizeAShareCode 丢掉的）',
      },
      skipped: {
        type: 'number',
        description: '因单次上限（本端点 >20 直接 400，此处为服务层默认上限）被跳过的只数',
      },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string', nullable: true, description: '无主数据时为 null' },
            // 服务端 alerts.ts / newsBacktest 的类型是
            // `newsSentiment?: {...} | null` —— **可选且可为 null**
            // （该只取数失败时字段缺省；有新闻但无情绪时显式 null）。
            // 此前契约漏了「可选」，生成的类型非空，消费方按契约写
            // `const ns: NewsSignal | null = row.newsSentiment` 会编译失败。
            newsSentiment: {
              oneOf: [{ $ref: '#/components/schemas/NewsSignal' }, { type: 'null' }],
              description: '无新闻（或该只取数失败）时缺省或为 null',
            },
            strategyList: {
              type: 'array',
              items: { $ref: '#/components/schemas/StrategyRecommendation' },
            },
            bestStrategy: {
              type: 'object',
              description: '按 sharpeRatio 选出的最优策略；strategyList 为空时缺省',
              properties: {
                strategyType: { type: 'string' },
                totalReturn: { type: 'number' },
                sharpeRatio: { type: 'number' },
                maxDrawdown: { type: 'number' },
                winRate: { type: 'number' },
                newsAware: {
                  type: 'object',
                  description: '叠加最新消息后的回测对比（仅有新闻时存在）',
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
              required: ['strategyType', 'totalReturn', 'sharpeRatio', 'maxDrawdown', 'winRate'],
            },
            simulatedKline: { type: 'boolean', description: 'K 线是否含降级的模拟数据' },
            error: { type: 'string', description: '该只失败原因；成功时缺省' },
          },
          required: ['code', 'name', 'strategyList', 'simulatedKline'],
        },
      },
    },
    required: ['generatedAt', 'count', 'withNewsCount', 'results'],
  },
};
