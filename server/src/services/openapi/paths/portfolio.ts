import { errorResponse, jsonBody, jsonOk, stockCodeSchema } from '../shared.js';

export const portfolioPaths = {
  '/api/paper/portfolio': {
    get: {
      tags: ['paper'],
      summary: '模拟盘账户：现金 / 持仓 / 订单 / 每日净值',
      responses: {
        200: jsonOk({ description: '账户快照' }, { $ref: '#/components/schemas/PaperPortfolio' }),
        500: errorResponse('账户读取失败'),
      },
    },
  },
  '/api/paper/order': {
    post: {
      tags: ['paper'],
      summary: '模拟下单（市价/限价，A 股规则撮合）',
      description: 'T+1 / 主板 ±10% 涨跌停拒单 / 整手 100 股 / 佣金万三 + 卖出印花税 0.1%。',
      requestBody: jsonBody({
        type: 'object',
        properties: {
          code: stockCodeSchema,
          side: { type: 'string', enum: ['buy', 'sell'] },
          type: { type: 'string', enum: ['market', 'limit'] },
          price: { type: 'number', description: '限价单必填' },
          quantity: { type: 'number', description: '股数（向下取整到 100 股整数倍）' },
          date: { type: 'string', format: 'date', description: '可选：切换当前交易日' },
        },
        required: ['code', 'side', 'quantity'],
      }),
      responses: {
        200: jsonOk(
          { description: '成交订单' },
          {
            type: 'object',
            properties: {
              order: { $ref: '#/components/schemas/PaperOrder' },
            },
            required: ['order'],
          },
        ),
        400: errorResponse('下单被拒（非法代码/数量/限价等）'),
      },
    },
  },
  '/api/paper/settle': {
    post: {
      tags: ['paper'],
      summary: '日终结算：收盘价撮合挂单 + 记录当日净值',
      requestBody: jsonBody({
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date' },
          closePrices: {
            type: 'object',
            additionalProperties: { type: 'number' },
            description: '代码 → 当日收盘价',
          },
          prevClosePrices: {
            type: 'object',
            additionalProperties: { type: 'number' },
            description: '代码 → 昨收（用于涨跌停判定）',
          },
        },
        required: ['date', 'closePrices'],
      }),
      responses: {
        200: jsonOk(
          { description: '结算后现金与净值历史' },
          {
            type: 'object',
            properties: {
              date: { type: 'string' },
              cash: { type: 'number' },
              latestEquity: {
                oneOf: [{ $ref: '#/components/schemas/PaperEquityPoint' }, { type: 'null' }],
                description: '当日净值点；无新增点时为 undefined（JSON 中缺省）',
              },
              history: {
                type: 'array',
                items: { $ref: '#/components/schemas/PaperEquityPoint' },
              },
            },
            required: ['date', 'cash', 'history'],
          },
        ),
        400: errorResponse('缺少结算日期'),
        500: errorResponse('结算失败'),
      },
    },
  },
  '/api/paper/stats': {
    get: {
      tags: ['paper'],
      summary: '累计收益 / 最大回撤 / 年化夏普',
      responses: {
        200: jsonOk({ description: '绩效统计' }, { $ref: '#/components/schemas/PaperStats' }),
        500: errorResponse('统计失败'),
      },
    },
  },
  '/api/watchlist': {
    get: {
      tags: ['watchlist'],
      summary: '获取自选股清单',
      responses: {
        200: jsonOk(
          { description: '当前自选股代码清单' },
          { $ref: '#/components/schemas/WatchlistCodes' },
        ),
      },
    },
    post: {
      tags: ['watchlist'],
      summary: '添加自选股（去重）',
      requestBody: jsonBody({
        type: 'object',
        properties: { code: stockCodeSchema },
        required: ['code'],
      }),
      responses: {
        200: jsonOk({ description: '最新清单' }, { $ref: '#/components/schemas/WatchlistCodes' }),
        400: errorResponse('代码无效'),
      },
    },
  },
  '/api/watchlist/{code}': {
    delete: {
      tags: ['watchlist'],
      summary: '移除自选股（幂等）',
      parameters: [{ name: 'code', in: 'path', required: true, schema: stockCodeSchema }],
      responses: {
        200: jsonOk({ description: '最新清单' }, { $ref: '#/components/schemas/WatchlistCodes' }),
        400: errorResponse('代码无效'),
      },
    },
  },
  '/api/watchlist/news-backtest': {
    post: {
      tags: ['watchlist'],
      summary: '批量「含最新消息回测」',
      requestBody: jsonBody({
        type: 'object',
        properties: {
          codes: {
            type: 'array',
            items: stockCodeSchema,
            maxItems: 20,
            description: '缺省为全部自选股',
          },
        },
      }),
      responses: {
        200: jsonOk(
          { description: '批量回测报告（results/withNewsCount/generatedAt）' },
          { $ref: '#/components/schemas/WatchlistNewsBacktestReport' },
        ),
        400: errorResponse('清单为空或超过 20 只'),
        429: errorResponse('触发限流（默认每分钟 3 次）'),
        500: errorResponse('批量回测失败'),
        503: errorResponse('合规熔断触发'),
      },
    },
  },
  '/api/watchlist/monitor': {
    post: {
      tags: ['watchlist'],
      summary: '主动监控：批量回测 + 异动预警',
      description:
        '对自选股清单跑批量新闻回测并检出异动。单次处理上限默认 20 只（WATCHLIST_MAX_CODES 可调），' +
        '超出部分被跳过并在响应中如实披露 requested/skipped（不静默截断）；结果落盘，' +
        '可由 GET /api/watchlist/alerts 回看。',
      responses: {
        200: jsonOk(
          { description: '异动预警（alerts；超上限时另有 requested/skipped）' },
          { $ref: '#/components/schemas/WatchlistMonitorResult' },
        ),
        400: errorResponse('清单为空'),
        429: errorResponse('触发限流'),
        500: errorResponse('监控失败'),
        503: errorResponse('合规熔断触发'),
      },
    },
  },
  '/api/watchlist/alerts': {
    get: {
      tags: ['watchlist'],
      summary: '最近一次异动监控快照',
      description:
        '返回最近一次 POST /api/watchlist/monitor 落盘的快照（生成时间 + 覆盖只数 + 预警条目），供自选股页常驻展示；从未监控过时返回 generatedAt=null 的空结构而非 404。',
      responses: {
        200: jsonOk(
          { description: '监控快照 { generatedAt, monitored, alerts }' },
          { $ref: '#/components/schemas/WatchlistMonitorResult' },
        ),
      },
    },
  },
};
