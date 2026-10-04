/**
 * OpenAPI 3.1 契约（机器可读 API 规范）
 * ----------------------------------------------------------------------------
 * API 形状的唯一权威来源：服务端经 GET /api/openapi.json 自托管本规范，
 * 可供 Swagger UI / 代码生成 / 契约校验工具消费。
 *
 * 维护约定：新增或修改路由时同步更新此处。兜底不是靠人肉清单，而是
 * `services/__tests__/openapi.routes.test.ts` 里的「与实际挂载路由一致」——
 * 它从 app 的真实路由表反推，与本文件**双向**比对：新增路由漏写契约会直接失败
 * 并报出该补哪个 paths key。因此这里不需要（也不应该）再维护一份端点清单。
 *
 * 2026-10-04 补录了 25 条此前从未进契约的路由（quant 因子/台账/简报、llm 校准、
 * 改进闭环、intl K 线等）。此前本文件只覆盖 README 表格的 24 条，而 app 实际挂载
 * 64 条，缺口长期存在且无任何测试能发现——补录后由上述双向校验接管。
 */

export const OPENAPI_VERSION = '3.1.0';

const stockCodeSchema = {
  type: 'string',
  pattern: '^\\d{6}$',
  description: '6 位 A 股股票代码，如 600519',
  examples: ['600519'],
};

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['error'],
      },
    },
  },
});

const jsonBody = (schema: unknown, description?: string) => ({
  description,
  required: true,
  content: { 'application/json': { schema } },
});

export function buildOpenApiDocument() {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Stock Research System API',
      version: '1.0.0',
      description:
        '全栈股票研究平台：多专家仲裁、量化回测与受控评估（DSR/CSCV/Walk-Forward）、模拟盘研究闭环、合规审计（金融监管 8 号文）。所有内容仅供学术投研参考，不构成投资建议。',
    },
    servers: [{ url: '/', description: '同源部署（前端与 API 单端口）' }],
    tags: [
      { name: 'analysis', description: '多专家研判' },
      { name: 'quant', description: '量化回测与受控评估' },
      { name: 'paper', description: '模拟盘研究闭环（无实盘资金）' },
      { name: 'watchlist', description: '自选股与异动监控' },
      { name: 'chat', description: '对话式研究助手' },
      { name: 'autonomous', description: '自治监控循环' },
      { name: 'documents', description: '研报/公告 RAG 入库' },
      { name: 'intl', description: '港美股财务估值' },
      { name: 'system', description: '模型路由 / 成本 / 审计 / 健康检查 / 指标' },
    ],
    paths: {
      '/api/analyze': {
        post: {
          tags: ['analysis'],
          summary: '单股多专家研判',
          description: '8 位专家独立研判 + 辩论仲裁 + 量化打分 + 策略回测。耗时约 1-3 分钟。',
          requestBody: jsonBody({
            type: 'object',
            properties: { stockCode: stockCodeSchema },
            required: ['stockCode'],
          }),
          responses: {
            200: {
              description: '完整分析报告（stock_pool / research_confidence / data_sources 等）',
            },
            400: errorResponse('股票代码无效'),
            429: errorResponse('触发限流（默认每分钟 10 次）'),
            500: errorResponse('分析过程出错'),
            503: errorResponse('合规熔断触发（窗口内高风险审计条目超阈值）'),
          },
        },
      },
      '/api/analyze/stream': {
        get: {
          tags: ['analysis'],
          summary: '流式分析（SSE）',
          description:
            '以 text/event-stream 逐阶段推送分析进度（data/experts/arbitration/scoring/strategy/done）。',
          parameters: [
            {
              name: 'stockCode',
              in: 'query',
              required: true,
              schema: stockCodeSchema,
            },
          ],
          responses: {
            200: { description: 'SSE 事件流；最终事件 phase=done 携带完整结果' },
            400: errorResponse('股票代码无效'),
            429: errorResponse('触发限流'),
          },
        },
      },
      '/api/compare': {
        post: {
          tags: ['analysis'],
          summary: '2-3 只股票横向对比',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              stockCodes: {
                type: 'array',
                items: stockCodeSchema,
                minItems: 2,
                maxItems: 3,
              },
            },
            required: ['stockCodes'],
          }),
          responses: {
            200: {
              description:
                '各股分析结果（stocks）+ 失败清单（failures: [{code, error}]）；' +
                '单只失败不影响其余股票出结果，failures 为空时与旧契约一致',
            },
            400: errorResponse('股票数量或代码无效'),
            429: errorResponse('触发限流（默认每分钟 3 次），或 LLM 排队超时（带 Retry-After）'),
            500: errorResponse('对比分析失败（全部股票均失败且响应契约不含失败清单时）'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/stocks': {
        get: {
          tags: ['analysis'],
          summary: '已缓存股票列表',
          responses: { 200: { description: '股票列表（code/name/industry），异常时返回兜底列表' } },
        },
      },
      '/api/stocks/search': {
        get: {
          tags: ['analysis'],
          summary: '股票模糊搜索',
          description: '东方财富 suggest 为主，空结果回退本地全表模糊匹配（支持全称/子串/代码）。',
          parameters: [
            { name: 'keyword', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: '候选股票数组（code/name，最多 10 条）' },
            400: errorResponse('缺少搜索关键词'),
            429: errorResponse('触发限流（默认每分钟 30 次）'),
          },
        },
      },
      '/api/quant/analyze': {
        post: {
          tags: ['quant'],
          summary: '量化研究（回测 + 数据质量 + 审计 + 优化 + 摘要）',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              strategy: { description: '策略配置对象或策略名（ma_cross/rsi_mean_reversion 等）' },
              useNews: { type: 'boolean', description: '是否实时抓取新闻情绪叠加回测' },
              newsItems: {
                type: 'array',
                description: '用户粘贴的新闻条目（优先于实时抓取）',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    summary: { type: 'string' },
                    publishedAt: { type: 'string', format: 'date-time' },
                    polarity: { type: 'number' },
                  },
                },
              },
            },
            required: ['strategy'],
          }),
          responses: {
            200: {
              description:
                '完整量化报告（strategy/dataQuality/backtest/priceVolumeFactors[含时间序列预测力 predictability：IC/t/p/显著]/compositeAlpha[多因子按 |t| 置信度加权的方向性组合 alpha、综合方向、显著因子数、方向一致率]/audit/optimization/summary/confidence/limitations）',
            },
            400: errorResponse('缺少策略配置'),
            422: errorResponse('无法获取 K 线数据'),
            429: errorResponse('触发限流（默认每分钟 5 次）'),
            500: errorResponse('量化分析失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/quant/factor/evaluate': {
        post: {
          tags: ['quant'],
          summary: '单因子评估 tear sheet（IC 显著性 / 分层回测 / 换手率 / alpha-beta）',
          description:
            '输入截面面板（多标的 × 多交易日），方法学对齐 alphalens / qlib。' +
            '返回逐持有期的 IC 均值、IR、t 统计量与双侧 p 值，各分位收益与多空价差、单调性，' +
            '因子换手率与排序自相关，以及因子加权多空组合的年化 alpha / beta；' +
            '并附「是否采信」判定（IC 显著 + 分层单调 + 多空价差为正三者同时成立）。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              observations: {
                type: 'array',
                description:
                  '因子观测面板：{ date(YYYY-MM-DD), symbol?, value, returns: { [持有期]: 收益 }, marketCap?, group?, weight? }',
                items: { type: 'object' },
              },
              options: {
                type: 'object',
                description:
                  '评估参数：quantiles(默认5)、maxLoss(默认0.25)、neutralize、winsorize、periods、lag(默认1)、demeaned、groupAdjust',
              },
            },
            required: ['observations'],
          }),
          responses: {
            200: {
              description:
                '评估报告（periods/byPeriod[ic/quantile/turnover/alphaBeta/longShortCumulative/verdict]/sampleSize/dropped/dropRatio/neutralized）',
            },
            400: errorResponse('observations 缺失或字段不合法'),
            413: errorResponse('observations 数量超过上限（200000）'),
            422: errorResponse('因子数据缺失比例超过 maxLoss'),
            429: errorResponse('触发限流（默认每分钟 5 次）'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/quant/factor/composite': {
        post: {
          tags: ['quant'],
          summary: '多因子加权组合 alpha（单只股票，时间序列 IC 口径）',
          description:
            '拉取单只股票 K 线与市场基准（按市场选沪深300/标普500/恒生），计算各量价因子对' +
            '自身远期收益的时间序列 IC（21/63 交易日），再按 |t| 置信度加权方向校正 IC 合成' +
            '方向性组合 alpha。不跑回测/数据质量/审计/优化，适合批量测算单标的的方向性信号。' +
            '市场基准拉取失败时优雅降级（Beta 类因子不参与加权）。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              stockCode: {
                type: 'string',
                description: '股票代码（A 股6位 / 美股字母 / 港股5位）',
              },
              startDate: { type: 'string', format: 'date', description: '默认近两年' },
              endDate: { type: 'string', format: 'date', description: '默认今天' },
              horizons: {
                type: 'array',
                items: { type: 'number' },
                description: '持有期（交易日），默认 [21, 63]',
              },
            },
            required: ['stockCode'],
          }),
          responses: {
            200: {
              description:
                '组合 alpha 结果（stockCode/market/benchmarkSecid/horizons/compositeAlpha[综合方向·显著因子数·方向一致率]/factorPredictability[逐因子 IC/t/p/显著]/bars/dataRange/benchmarkAvailable）',
            },
            400: errorResponse('缺少股票代码 stockCode，或代码形态非法（含可改写上游 URL 的字符）'),
            422: errorResponse('无法获取 K 线数据'),
            429: errorResponse('触发限流（默认每分钟 5 次），或 LLM 排队超时（带 Retry-After）'),
            500: errorResponse('组合 alpha 计算失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/quant/factor/composite/batch': {
        post: {
          tags: ['quant'],
          summary: '批量多因子加权组合 alpha（多只股票）',
          description:
            '一次请求测算多只股票的方向性组合 alpha，参数与单只端点一致（K 线 + 市场基准 → ' +
            '时间序列 IC → 组合 alpha）。代码按首次出现顺序去重、并发度受限（默认 4、上限 8）；' +
            '单只失败（无 K 线 / 网络异常）只标记该项 ok:false，其余照常返回，结果按输入顺序排列。' +
            '市场基准可用环境变量覆盖：QUANT_BENCHMARK_SECID_A / _US / _HK（如美股改纳指100 ' +
            '`100.NDX`、A 股改中证500 `1.000905`），留空则回落内置默认。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              stockCodes: {
                type: 'array',
                items: { type: 'string' },
                description: '股票代码数组（最多 20 个，自动去重）',
              },
              startDate: { type: 'string', format: 'date', description: '默认近两年' },
              endDate: { type: 'string', format: 'date', description: '默认今天' },
              horizons: {
                type: 'array',
                items: { type: 'number' },
                description: '持有期（交易日），默认 [21, 63]',
              },
            },
            required: ['stockCodes'],
          }),
          responses: {
            200: {
              description:
                '批量结果（requested/succeeded/failed/items[按输入顺序，每项 ok:true 带 result，' +
                'ok:false 带 error]/startDate/endDate/horizons）',
            },
            400: errorResponse('stockCodes 缺失或全部为空'),
            413: errorResponse('stockCodes 数量超过上限（20）'),
            429: errorResponse('触发限流（默认每分钟 5 次）'),
            500: errorResponse('批量组合 alpha 计算失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/backtest/evaluate': {
        post: {
          tags: ['quant'],
          summary: '受控评估：新闻叠加 vs 基线',
          description:
            '配对 t 检验 / Block Bootstrap CI / Deflated Sharpe Ratio，量化新闻信号是否真增 alpha。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              stockCode: stockCodeSchema,
              strategy: { type: 'string', description: '策略名，默认 ma_cross' },
              startDate: { type: 'string', format: 'date', description: '默认近两年' },
              endDate: { type: 'string', format: 'date', description: '默认今天' },
            },
            required: ['stockCode'],
          }),
          responses: {
            200: { description: 'baseline / experiment / comparison（DSR/PB 等）/ newsSource' },
            400: errorResponse('股票代码无效'),
            429: errorResponse('触发限流'),
            500: errorResponse('K 线获取或评估失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/paper/portfolio': {
        get: {
          tags: ['paper'],
          summary: '模拟盘账户：现金 / 持仓 / 订单 / 每日净值',
          responses: { 200: { description: '账户快照' }, 500: errorResponse('账户读取失败') },
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
            200: { description: '成交订单' },
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
            200: { description: '结算后现金与净值历史' },
            400: errorResponse('缺少结算日期'),
            500: errorResponse('结算失败'),
          },
        },
      },
      '/api/paper/stats': {
        get: {
          tags: ['paper'],
          summary: '累计收益 / 最大回撤 / 年化夏普',
          responses: { 200: { description: '绩效统计' }, 500: errorResponse('统计失败') },
        },
      },
      '/api/audit': {
        get: {
          tags: ['system'],
          summary: '合规审计查询（金融监管 8 号文）',
          parameters: [
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'riskLevel', in: 'query', schema: { type: 'string' } },
            {
              name: 'startTime',
              in: 'query',
              schema: { type: 'number', description: '毫秒时间戳' },
            },
            { name: 'endTime', in: 'query', schema: { type: 'number', description: '毫秒时间戳' } },
            { name: 'sessionId', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description: '本页条数上限（>= 0 的整数）；不传则返回全部分页',
            },
            {
              name: 'offset',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description: '起始偏移（>= 0 的整数）；不传则从第一条开始，与 limit 均不传时返回全部',
            },
          ],
          responses: {
            200: {
              description:
                '审计条目：count 为**匹配总数**（不是本页条数，供「共 N 条 / 加载更多」），entries 为本页条目',
            },
            400: errorResponse(
              '查询参数非法（时间戳需为 epoch 毫秒，limit/offset 需为 >= 0 的整数）',
            ),
            500: errorResponse('审计查询失败'),
          },
        },
      },
      '/api/intl/fundamentals': {
        get: {
          tags: ['intl'],
          summary: '港美股财务估值（东财 datacenter RPT 网关）',
          parameters: [
            { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
            {
              name: 'market',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['HK', 'US'],
                description: '缺省自动推断；A 股代码会被拒绝',
              },
            },
          ],
          responses: {
            200: { description: '财务估值（degraded=true 表示部分数据源降级）' },
            400: errorResponse('缺少代码或 A 股代码'),
            500: errorResponse('数据获取失败'),
          },
        },
      },
      '/api/chat': {
        post: {
          tags: ['chat'],
          summary: '自然语言研究助手',
          description: '路由规划 / 工具调用 / 多空辩论 / 证据引用与事实校验。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              message: { type: 'string', maxLength: 2000 },
              history: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string' },
                  },
                },
              },
              stockCode: { type: 'string' },
              sessionId: { type: 'string', description: '会话级记忆 ID' },
            },
            required: ['message'],
          }),
          responses: {
            200: {
              description: '回答（answer/toolsUsed/evidence/debate/verification/degraded 等）',
            },
            400: errorResponse('消息为空或超长'),
            429: errorResponse('触发限流（默认每分钟 10 次）'),
            500: errorResponse('对话处理失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/chat/stream': {
        get: {
          tags: ['chat'],
          summary: '流式对话（SSE）',
          description:
            '逐阶段推送执行进度（planning/retrieving/tool_calling/debating/verifying/done）。',
          parameters: [
            {
              name: 'message',
              in: 'query',
              required: true,
              schema: { type: 'string', maxLength: 2000 },
            },
            { name: 'sessionId', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'SSE 事件流；最终事件 phase=done 携带完整回答' },
            400: errorResponse('消息为空或超长'),
            429: errorResponse('触发限流'),
          },
        },
      },
      '/api/chat/history/clear': {
        post: {
          tags: ['chat'],
          summary: '清空会话持久记忆',
          requestBody: jsonBody({
            type: 'object',
            properties: { sessionId: { type: 'string' } },
            required: ['sessionId'],
          }),
          responses: { 200: { description: 'ok' }, 400: errorResponse('缺少 sessionId') },
        },
      },
      '/api/watchlist': {
        get: {
          tags: ['watchlist'],
          summary: '获取自选股清单',
          responses: { 200: { description: '代码数组（codes）' } },
        },
        post: {
          tags: ['watchlist'],
          summary: '添加自选股（去重）',
          requestBody: jsonBody({
            type: 'object',
            properties: { code: stockCodeSchema },
            required: ['code'],
          }),
          responses: { 200: { description: '最新清单' }, 400: errorResponse('代码无效') },
        },
      },
      '/api/watchlist/{code}': {
        delete: {
          tags: ['watchlist'],
          summary: '移除自选股（幂等）',
          parameters: [{ name: 'code', in: 'path', required: true, schema: stockCodeSchema }],
          responses: { 200: { description: '最新清单' }, 400: errorResponse('代码无效') },
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
            200: { description: '批量回测报告（results/withNewsCount/generatedAt）' },
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
            200: { description: '异动预警（alerts；超上限时另有 requested/skipped）' },
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
            200: { description: '监控快照 { generatedAt, monitored, alerts }' },
          },
        },
      },
      '/api/autonomous/start': {
        post: {
          tags: ['autonomous'],
          summary: '启动自治监控循环',
          description: '连续失败指数退避（封顶 8 倍），连续失败 10 次自动停止。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              intervalMs: {
                type: 'number',
                minimum: 30000,
                maximum: 86400000,
                description: '轮询间隔，夹紧到 [30 秒, 24 小时]，默认 5 分钟',
              },
            },
          }),
          responses: {
            200: { description: 'started + 循环状态' },
            429: errorResponse('触发限流'),
            500: errorResponse('启动失败'),
          },
        },
      },
      '/api/autonomous/stop': {
        post: {
          tags: ['autonomous'],
          summary: '停止自治监控循环',
          responses: { 200: { description: 'stopped + 最近一次预警' } },
        },
      },
      '/api/autonomous/status': {
        get: {
          tags: ['autonomous'],
          summary: '自治循环状态',
          responses: {
            200: {
              description: 'running/intervalMs/runCount/errorCount 等；未运行时 {running:false}',
            },
          },
        },
      },
      '/api/ingest': {
        post: {
          tags: ['documents'],
          summary: '研报/公告入库（文本或 PDF Base64）',
          description: '洞察抽取（利好/风险/催化剂）→ 注入 RAG 检索库。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              title: { type: 'string' },
              text: { type: 'string' },
              pdfBase64: { type: 'string', description: '与 text 二选一' },
            },
            required: ['title'],
          }),
          responses: {
            200: { description: '入库结果（id/insight/ingested）' },
            400: errorResponse('缺少标题或正文'),
            429: errorResponse('触发限流'),
            500: errorResponse('入库失败'),
          },
        },
      },
      '/api/documents': {
        get: {
          tags: ['documents'],
          summary: '已入库文档列表（含预览）',
          responses: { 200: { description: 'count/docs' } },
        },
      },
      '/api/models': {
        get: {
          tags: ['system'],
          summary: '多模型注册表与任务路由',
          responses: { 200: { description: 'available/embeddingEnabled/registry/routing' } },
        },
      },
      '/api/cost': {
        get: {
          tags: ['system'],
          summary: 'LLM 成本报告',
          responses: { 200: { description: 'totalCost/tokens/byModel' } },
        },
      },
      '/api/cost/reset': {
        post: {
          tags: ['system'],
          summary: '重置 LLM 成本账本',
          responses: {
            200: { description: 'ok' },
            429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
          },
        },
      },
      '/api/health': {
        get: {
          tags: ['system'],
          summary: '健康检查（外部 API 可达性 + 缓存目录）',
          description:
            '外呼探测带 60 秒 memo（HEALTH_PROBE_MEMO_MS 可覆盖，0=关闭）且并发合流；' +
            '响应中的 cached/checkedAt 如实标注结论来自缓存还是本次探测。GET 只读，不创建目录。',
          responses: {
            200: { description: 'status=ok（缓存目录缺失时 cacheDir.status=missing，仍为 200）' },
            429: errorResponse('触发限流（健康探针默认每分钟 120 次）'),
            503: errorResponse('外部数据源不可达或缓存目录不可读写（降级态）'),
          },
        },
      },
      '/api/metrics': {
        get: {
          tags: ['system'],
          summary: 'Prometheus 指标（文本格式 0.0.4）',
          description: 'HTTP 请求计数/耗时直方图、进程内存、LLM 成本、熔断器状态。',
          responses: {
            200: {
              description: 'Prometheus 文本格式指标',
              content: { 'text/plain; version=0.0.4': { schema: { type: 'string' } } },
            },
            429: errorResponse('触发限流（与健康探针共享 120 次/分钟配额）'),
          },
        },
      },
      '/api/openapi.json': {
        get: {
          tags: ['system'],
          summary: '本 OpenAPI 规范文档',
          responses: {
            200: {
              description: 'OpenAPI 3.1 文档',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/api/history': {
        get: {
          tags: ['history'],
          summary: '研究历史列表（倒序摘要，不含完整结果）',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50 },
              description: '返回条数上限（1-200）',
            },
          ],
          responses: {
            200: { description: '{ items: HistorySummary[] }' },
          },
        },
      },
      '/api/history/{id}': {
        get: {
          tags: ['history'],
          summary: '研究历史详情（含完整分析结果，可恢复研究报告）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'HistoryItem（含 result）' },
            404: errorResponse('历史记录不存在'),
          },
        },
        delete: {
          tags: ['history'],
          summary: '删除一条研究历史',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: '{ deleted: true }' },
            404: errorResponse('历史记录不存在'),
          },
        },
      },

      /* ===== 以下为 2026-10-04 补录的路由契约 =====
         此前规范只覆盖 README「核心端点」，另有 25 条已挂载路由从未进契约，
         而 openapi.routes.test.ts 只校验一份硬编码的核心清单，因此这类缺口
         不会让任何测试变红。补录后由「路由与契约双向一致」的结构测试接管：
         新增路由而漏写契约会直接失败（见该测试的 allowlist 机制）。 */

      '/api/quant/universe/boards': {
        get: {
          tags: ['quant'],
          summary: '行业板块列表（横截面选股 universe 的可选范围）',
          description:
            '东财新旧两套行业体系并存（银行 / 银行Ⅱ / 国有大型银行Ⅲ），已滤掉名称以 Ⅱ/Ⅲ ' +
            '结尾的旧体系子级，只保留现行一级板块（纯降噪：这些代码本身仍可直接请求）。' +
            '上游失败但磁盘有快照时返回 stale=true 与 staleAgeMs，如实披露这是陈旧快照。',
          responses: {
            200: { description: '{ boards: IndustryBoard[], stale?: true, staleAgeMs?: number }' },
            429: errorResponse('触发限流（元数据默认每分钟 30 次）'),
            502: errorResponse('行业板块列表获取失败'),
          },
        },
      },
      '/api/quant/factor/cross-section': {
        post: {
          tags: ['quant'],
          summary: '因子截面评估（IC / 分层收益 / 多空组合）',
          description:
            '可选 universe（codes 或 board）、topN、horizons；includeFundamental/Events/Margin ' +
            '为按需叠加的因子族，portfolio=true 时为每个因子附带 top-N 等权周期调仓回测。' +
            'indexUniverse 走 Baostock sidecar 取指数历史成分（point-in-time）。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              codes: { type: 'array', items: stockCodeSchema },
              board: { type: 'string' },
              topN: { type: 'integer' },
              horizons: { type: 'array', items: { type: 'string' } },
              includeFundamental: { type: 'boolean' },
              includeEvents: { type: 'boolean' },
              includeMargin: { type: 'boolean' },
              portfolio: { type: 'object' },
            },
          }),
          responses: {
            200: { description: 'CrossSectionResult（各因子 IC/分层收益 + 可选组合回测）' },
            400: errorResponse('参数或取值范围非法'),
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            502: errorResponse('上游取数失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/quant/timeseries/analyze': {
        post: {
          tags: ['quant'],
          summary: '时间序列因子分析（时序 IC / 滚动稳定性）',
          requestBody: jsonBody({ type: 'object' }),
          responses: {
            200: { description: '时序分析结果' },
            400: errorResponse('参数非法（窗口、至少观测数、区间一致性等）'),
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            502: errorResponse('取数不足（数据不足 / 观测不足 / 对齐后样本过少）'),
            503: errorResponse('合规熔断触发'),
            500: errorResponse('时间序列分析失败'),
          },
        },
      },
      '/api/quant/factor/expression': {
        post: {
          tags: ['quant'],
          summary: '自定义因子表达式评估（受限 DSL，不执行模型生成的代码）',
          description:
            'LLM 生成假设或手输表达式 → parseFactorExpression 解析为白名单语法 AST → ' +
            '截面评估器验证 → 台账留痕。关键点：**不 eval 任何模型产出的代码**，' +
            '因此没有沙箱逃逸面。startDate/endDate 未传时沿用 730 天默认窗口。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              expression: { type: 'string', description: '因子表达式（白名单 DSL）' },
              name: { type: 'string' },
              board: { type: 'string' },
              codes: { type: 'array', items: stockCodeSchema },
              topN: { type: 'integer' },
              horizons: { type: 'array', items: { type: 'string' } },
              portfolio: { type: 'object' },
              startDate: { type: 'string', description: 'YYYY-MM-DD' },
              endDate: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['expression'],
          }),
          responses: {
            200: { description: '因子评估结果 + 组合回测（若请求 portfolio）+ 台账留痕条数' },
            400: errorResponse('表达式非法或参数越界（解析错误详情原样回传，不做脱敏）'),
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/quant/factor/expression/batch': {
        post: {
          tags: ['quant'],
          summary: '批量因子假设验证（多表达式一次测算）',
          description: '逐条评估并汇总 ok 计数；results 内每条带 stocksIncluded / stocksSkipped。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              expressions: { type: 'array', items: { type: 'object' } },
              board: { type: 'string' },
              topN: { type: 'integer' },
              horizons: { type: 'array', items: { type: 'string' } },
            },
            required: ['expressions'],
          }),
          responses: {
            200: { description: '{ universe, horizons, requested, evaluated, results[] }' },
            400: errorResponse('参数非法'),
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            500: errorResponse('批量因子假设验证失败'),
          },
        },
      },
      '/api/quant/research-memory/{code}': {
        get: {
          tags: ['quant'],
          summary: '个股研究记忆（历史结论与追踪指标）',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: stockCodeSchema,
              description: '6 位 A 股代码',
            },
          ],
          responses: {
            200: { description: '该股的研究记忆（结论、争议点、跟踪项）' },
            400: errorResponse('非 6 位 A 股代码'),
            429: errorResponse('触发限流'),
            500: errorResponse('研究记忆读取失败'),
          },
        },
      },
      '/api/quant/digests': {
        get: {
          tags: ['quant'],
          summary: '研究简报列表（倒序）',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
          responses: {
            200: { description: '{ items: ResearchDigest[] }' },
            429: errorResponse('触发限流'),
            500: errorResponse('研究简报读取失败'),
          },
        },
      },
      '/api/quant/digests/run': {
        post: {
          tags: ['quant'],
          summary: '手动触发一份研究简报',
          description: '与定时任务（QUANT_DIGEST_INTERVAL_HOURS，默认关闭）共用同一落盘。',
          responses: {
            200: { description: '本次生成的研究简报' },
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            500: errorResponse('研究简报生成失败'),
          },
        },
      },
      '/api/quant/announcements': {
        get: {
          tags: ['quant'],
          summary: '个股公告列表 / 单篇公告全文',
          description: '带 artCode 时返回该篇全文；否则按 6 位 A 股代码返回公告列表。',
          parameters: [
            { name: 'code', in: 'query', schema: stockCodeSchema },
            { name: 'artCode', in: 'query', schema: { type: 'string' } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 10 } },
          ],
          responses: {
            200: { description: '公告列表，或 { artCode, content } 单篇全文' },
            400: errorResponse('未提供 artCode 且 code 不是 6 位 A 股代码'),
            429: errorResponse('触发限流'),
          },
        },
      },
      '/api/quant/valuation/model': {
        post: {
          tags: ['quant'],
          summary: '估值建模（DCF / 相对估值，假设可覆盖默认值）',
          description:
            'assumptions 可覆盖 growthRate1/2、discountRate、explicitYears、baseEps；' +
            '非有限数值的项被忽略并回落默认值（不是报错）。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              code: stockCodeSchema,
              assumptions: {
                type: 'object',
                properties: {
                  growthRate1: { type: 'number' },
                  growthRate2: { type: 'number' },
                  discountRate: { type: 'number' },
                  explicitYears: { type: 'integer' },
                  baseEps: { type: 'number' },
                },
              },
            },
            required: ['code'],
          }),
          responses: {
            200: { description: '估值模型输出（现金流折现 + 敏感性）' },
            400: errorResponse('代码非法或假设违反约束（增长率/折现率/显性年数等）'),
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            502: errorResponse('估值建模失败（数据获取或计算异常）'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/quant/health': {
        get: {
          tags: ['system'],
          summary: '量化侧上游预检（行情源 / LLM / 缓存 / 增强通道）',
          description:
            '动手前先判「行情源通不通 / LLM 配没配 / 缓存有没有」，避免用户干等超时后只拿到' +
            '一句没有行动指引的 502。tushare / baostock 为可选增强通道，未配置或失败都如实降级' +
            '披露，不影响 preflight.ok。',
          responses: {
            200: { description: '{ ok, checks…, tushare, baostock }' },
            429: errorResponse('触发限流'),
            500: errorResponse('上游预检失败'),
          },
        },
      },
      '/api/quant/factor/experiments': {
        get: {
          tags: ['quant'],
          summary: '因子实验台账（列出 + 汇总）',
          parameters: [
            { name: 'source', in: 'query', schema: { type: 'string' } },
            { name: 'kept', in: 'query', schema: { type: 'boolean' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          ],
          responses: {
            200: { description: '{ items, summary }' },
            429: errorResponse('触发限流'),
            500: errorResponse('实验台账读取失败'),
          },
        },
        post: {
          tags: ['quant'],
          summary: '补录因子实验（外部脚本/离线评估的结论也能进台账）',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              entries: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object' } },
            },
            required: ['entries'],
          }),
          responses: {
            200: { description: '{ recorded }' },
            400: errorResponse('entries 缺失、为空或超过 200 条'),
            429: errorResponse('触发限流'),
            500: errorResponse('实验台账写入失败'),
          },
        },
      },
      '/api/intl/klines': {
        get: {
          tags: ['intl'],
          summary: '港美股 K 线（默认近 2 年）',
          description: '仅港/美股；A 股代码请走量化/行情既有接口，传入会返回 400 而非误导性数据。',
          parameters: [
            { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
            {
              name: 'market',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['HK', 'US'] },
            },
            {
              name: 'startDate',
              in: 'query',
              schema: { type: 'string', description: 'YYYY-MM-DD' },
            },
            { name: 'endDate', in: 'query', schema: { type: 'string', description: 'YYYY-MM-DD' } },
          ],
          responses: {
            200: { description: '{ code, market, bars[] }' },
            400: errorResponse('参数非法，或传入 A 股代码'),
            429: errorResponse('触发限流（元数据默认每分钟 30 次）'),
            502: errorResponse('上游 K 线获取失败'),
          },
        },
      },
      '/api/quant/screener/run': {
        post: {
          tags: ['quant'],
          summary: '全市场初筛（长任务，客户端提前断开则级联中止在途取数）',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              maxStocks: { type: 'integer' },
              startDate: { type: 'string', description: 'YYYY-MM-DD' },
              endDate: { type: 'string', description: 'YYYY-MM-DD' },
            },
          }),
          responses: {
            200: { description: '初筛结果（命中列表 + 各条件通过情况）' },
            400: errorResponse('参数非法'),
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            500: errorResponse('全市场初筛失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/quant/screener/latest': {
        get: {
          tags: ['quant'],
          summary: '最近一次初筛结果（无人值守运行后回看）',
          responses: {
            200: { description: '最近一次初筛的落盘结果' },
            404: errorResponse('还没有初筛记录（需先 POST /api/quant/screener/run）'),
            429: errorResponse('触发限流'),
          },
        },
      },
      '/api/llm/ensemble': {
        post: {
          tags: ['system'],
          summary: '多模型集成调用（可指定 models / temperature / maxTokens）',
          description:
            'models 最多 5 个；temperature / maxTokens 越界时**夹紧到上限**并在服务端日志记录' +
            '原值（不报错），因此客户端不会因边界值直接失败。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              messages: { type: 'array', items: { type: 'object' } },
              models: { type: 'array', maxItems: 5, items: { type: 'string' } },
              task: { type: 'string' },
              temperature: { type: 'number' },
              maxTokens: { type: 'integer' },
            },
            required: ['messages'],
          }),
          responses: {
            200: { description: '集成结果（各模型输出 + 汇总）' },
            400: errorResponse('messages 非法，或 models 不是 1-5 个非空字符串'),
            429: errorResponse('触发限流，或 LLM 排队超时（带 Retry-After）'),
            502: errorResponse('多模型集成调用失败'),
            503: errorResponse('合规熔断触发'),
          },
        },
      },
      '/api/llm/calibration': {
        get: {
          tags: ['system'],
          summary: '模型权重（校准结果）',
          responses: {
            200: { description: '{ weights }' },
            429: errorResponse('触发限流'),
          },
        },
        post: {
          tags: ['system'],
          summary: '记录一次模型判断的验证结果（correct = 事后被验证正确）',
          requestBody: jsonBody({
            type: 'object',
            properties: { model: { type: 'string' }, correct: { type: 'boolean' } },
            required: ['model'],
          }),
          responses: {
            200: { description: '{ ok: true, weights }' },
            400: errorResponse('未提供 model'),
            429: errorResponse('触发限流'),
            500: errorResponse('校准记录失败'),
          },
        },
      },
      '/api/llm/skills': {
        get: {
          tags: ['system'],
          summary: '技能路由（给定一句话判定该走哪个专用技能）',
          description: '规则表判定，确定性输出，不调用模型。',
          parameters: [{ name: 'message', in: 'query', schema: { type: 'string' } }],
          responses: {
            200: { description: '命中的技能路由结果' },
            429: errorResponse('触发限流'),
          },
        },
      },
      '/api/improvement/status': {
        get: {
          tags: ['system'],
          summary: '改进闭环状态（harness policy + 台账汇总）',
          responses: { 200: { description: '{ state, ledger }' } },
        },
      },
      '/api/improvement/run': {
        post: {
          tags: ['system'],
          summary: '手动跑一轮改进（dryRun=true 时只评估不落盘）',
          requestBody: jsonBody({
            type: 'object',
            properties: { dryRun: { type: 'boolean' } },
          }),
          responses: {
            200: { description: '本轮改进结果（候选、采纳与否、配对统计护栏）' },
            429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
          },
        },
      },
      '/api/improvement/history': {
        get: {
          tags: ['system'],
          summary: '改进轮次历史（倒序）',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
          responses: {
            200: { description: '{ items }（limit 上限 200）' },
          },
        },
      },
      '/api/improvement/scheduler/start': {
        post: {
          tags: ['system'],
          summary: '启动改进闭环的周期调度（无人值守）',
          description: 'intervalHours 未传时回落 harness policy 的默认间隔。',
          requestBody: jsonBody({
            type: 'object',
            properties: { intervalHours: { type: 'number' } },
          }),
          responses: {
            200: { description: '调度已启动（含下次运行时间）' },
            429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
          },
        },
      },
      '/api/improvement/scheduler/stop': {
        post: {
          tags: ['system'],
          summary: '停止改进闭环的周期调度',
          responses: {
            200: { description: '调度已停止' },
            429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
          },
        },
      },
    },
  };
}
