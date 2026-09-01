/**
 * OpenAPI 3.1 契约（机器可读 API 规范）
 * ----------------------------------------------------------------------------
 * 与 README「API 概览」表格对应的唯一权威来源：服务端经 GET /api/openapi.json
 * 自托管本规范，可供 Swagger UI / 代码生成 / 契约校验工具消费。
 *
 * 维护约定：新增或修改路由时同步更新此处（openapi.routes.test.ts 有结构性校验兜底）。
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
            200: { description: '各股分析结果数组（stocks）' },
            400: errorResponse('股票数量或代码无效'),
            429: errorResponse('触发限流（默认每分钟 3 次）'),
            500: errorResponse('对比分析失败'),
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
                '完整量化报告（strategy/dataQuality/backtest/priceVolumeFactors/audit/optimization/summary/confidence/limitations）',
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
          ],
          responses: {
            200: { description: '审计条目（count/entries）' },
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
          responses: {
            200: { description: '异动预警（alerts）' },
            400: errorResponse('清单为空'),
            429: errorResponse('触发限流'),
            500: errorResponse('监控失败'),
            503: errorResponse('合规熔断触发'),
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
          responses: { 200: { description: 'ok' } },
        },
      },
      '/api/health': {
        get: {
          tags: ['system'],
          summary: '健康检查（外部 API 可达性 + 缓存目录）',
          responses: {
            200: { description: 'status=ok' },
            503: errorResponse('外部数据源不可达或缓存目录异常（降级态）'),
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
    },
  };
}
