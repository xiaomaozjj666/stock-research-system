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
      schema: { $ref: '#/components/schemas/ErrorResponse' },
    },
  },
});

/**
 * horizons（持有期档位）—— 五处端点共用的入参形状。
 *
 * 此前这三处（cross-section / expression / expression-batch）各自内联写了
 * `items: { type: 'string' }`，**与实现相反**：panelService.parseHorizons 收的是
 * 整数数组（`Math.trunc(Number(v))` 后必须 `Number.isInteger`），传字符串档位
 * （"21"）反而会被 Number() 强转通过、而类型生成器会照字面生成 `string[]`，
 * 让调用方以为字符串是合法输入。契约错得比没有契约更糟。
 * 口径与 parseHorizons 逐条对齐：1-504 的整数、最多 8 档、缺省 [21,63]。
 */
const horizonsSchema = {
  type: 'array',
  items: { type: 'integer', minimum: 1, maximum: 504 },
  minItems: 1,
  maxItems: 8,
  description: '持有期档位（交易日）：1-504 的整数，最多 8 档，缺省 [21, 63]；非法即 400',
};

const jsonBody = (schema: unknown, description?: string) => ({
  description,
  required: true,
  content: { 'application/json': { schema } },
});

/**
 * 200 响应快捷写法：`jsonOk(description, refOrSchema)`。
 * 绝大多数 200 响应只需要「一句说明 + 一个（常为 $ref 的）schema」，
 * 逐个手写 content/application/json 包装既啰嗦又容易漏，是此前 62 个
 * 「只有 description 没有 schema」的成因——包装太费事，于是干脆不写。
 */
const jsonOk = (opts: { description: string }, schema: unknown) => ({
  description: opts.description,
  content: { 'application/json': { schema } },
});

/**
 * 自治循环状态字段（services/scheduler.ts 的 AutonomousState，逐条对齐）。
 *
 * 三个自治端点（start / stop / status）都回它，故抽成一份供三处内联拼装：
 *  - start：getState() 的完整快照（required 是全部必填计数）
 *  - status：未在运行时**只回 { running: false }**，故 required 只有 running
 *  - stop：只回 stopped + lastAlerts，不含本组字段
 * 抽出来的原因不是省字数，而是「required 集合在两处不同、字段本身必须一致」——
 * 各写一遍时最容易出的错就是 start 与 status 的 required 悄悄分叉。
 */
const autonomousStateProperties = {
  running: { type: 'boolean', description: '循环是否在运行（连续失败达上限会自动置 false）' },
  intervalMs: {
    type: 'number',
    description: '当前生效的轮询间隔（毫秒，已夹紧到 [30 秒, 24 小时]）',
  },
  lastRunAt: { type: 'string', description: '最近一轮完成时间（ISO）；尚未跑完一轮时缺省' },
  lastAlertCount: { type: 'number', description: '最近一轮检出的异动预警条数' },
  runCount: { type: 'number', description: '已发起的监控轮次（含失败轮次）' },
  errorCount: { type: 'number', description: '失败轮次数' },
  lastError: { type: 'string', description: '最近一次失败原因；无失败时缺省' },
};

/**
 * 覆盖披露字段（routes/autonomous.ts 的 lastCoverage）。
 * 只在真的发生单次上限裁剪（清单 > WATCHLIST_MAX_CODES）时才出现，
 * 无裁剪时响应里**没有这两个字段**——故都不进 required。
 */
const coverageProperties = {
  requested: { type: 'number', description: '本轮请求的清单总只数（裁剪前）' },
  skipped: { type: 'number', description: '因单次上限被跳过、本轮未取数的只数' },
};

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
            200: jsonOk(
              { description: '完整分析报告（stock_pool / research_confidence / data_sources 等）' },
              { $ref: '#/components/schemas/AnalysisResult' },
            ),
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
            200: {
              description:
                'SSE 事件流；最终事件 phase=done 携带完整结果。' +
                '**Content-Type 是 text/event-stream，不是 application/json**——' +
                '响应体是 `data: {事件JSON}\\n\\n` 的帧序列而非一个 JSON 文档，' +
                '故此处 schema 声明为 string（原始帧文本）。' +
                '单个事件 JSON 的形状见 components.schemas.AnalyzeStreamEvent；' +
                '另有以 `:` 开头的注释帧作心跳（utils/sse.ts，不触发客户端 message 事件）。',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    description:
                      'SSE 原始帧文本。每帧形如 `data: {"phase":"...","message":"..."}\\n\\n`，' +
                      '反序列化后即 AnalyzeStreamEvent；心跳帧为 `: ping\\n\\n`。',
                  },
                },
              },
            },
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
            200: jsonOk(
              {
                description:
                  '各股分析结果（stocks）+ 失败清单（failures: [{code, error}]）；' +
                  '单只失败不影响其余股票出结果，failures 为空时与旧契约一致',
              },
              { $ref: '#/components/schemas/CompareResponse' },
            ),
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
          responses: {
            200: jsonOk(
              { description: '股票列表（code/name/industry），异常时返回兜底列表' },
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    name: { type: 'string' },
                    industry: { type: 'string' },
                  },
                  required: ['code', 'name', 'industry'],
                },
              },
            ),
          },
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
            200: jsonOk(
              { description: '候选股票数组（code/name，最多 10 条）' },
              {
                type: 'array',
                description: '候选股票（最多 10 条）；搜索失败时回空数组而非报错',
                items: {
                  type: 'object',
                  properties: { code: { type: 'string' }, name: { type: 'string' } },
                  required: ['code', 'name'],
                },
              },
            ),
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
              strategy: {
                // 既可传策略名（ma_cross / rsi_mean_reversion 等），也可传完整策略对象
                // （由 orchestrator.parseStrategyInput 二选一解析）。用 oneOf 表达，
                // 此前只写 description 不给 type，生成的 TS 里是 unknown。
                oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/StrategyConfig' }],
                description: '策略配置对象或策略名（ma_cross/rsi_mean_reversion 等）',
              },
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
            200: jsonOk(
              {
                description:
                  '完整量化报告（strategy/dataQuality/backtest/priceVolumeFactors[含时间序列预测力 predictability：IC/t/p/显著]/compositeAlpha[多因子按 |t| 置信度加权的方向性组合 alpha、综合方向、显著因子数、方向一致率]/audit/optimization/summary/confidence/limitations）',
              },
              { $ref: '#/components/schemas/QuantReport' },
            ),
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
            200: jsonOk(
              {
                description:
                  '评估报告（periods/byPeriod[ic/quantile/turnover/alphaBeta/longShortCumulative/verdict]/sampleSize/dropped/dropRatio/neutralized）',
              },
              { $ref: '#/components/schemas/FactorEvaluationReport' },
            ),
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
              horizons: horizonsSchema,
            },
            required: ['stockCode'],
          }),
          responses: {
            200: jsonOk(
              {
                description:
                  '组合 alpha 结果（stockCode/market/benchmarkSecid/horizons/compositeAlpha[综合方向·显著因子数·方向一致率]/factorPredictability[逐因子 IC/t/p/显著]/bars/dataRange/benchmarkAvailable）',
              },
              { $ref: '#/components/schemas/CompositeAlphaResult' },
            ),
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
              horizons: horizonsSchema,
            },
            required: ['stockCodes'],
          }),
          responses: {
            200: jsonOk(
              {
                description:
                  '批量结果（requested/succeeded/failed/items[按输入顺序，每项 ok:true 带 result，' +
                  'ok:false 带 error]/startDate/endDate/horizons，另附 run 与 preflight）',
              },
              {
                allOf: [
                  { $ref: '#/components/schemas/CompositeAlphaBatchResult' },
                  {
                    type: 'object',
                    description: '路由额外附加的两个复现/诊断快照',
                    properties: {
                      run: { $ref: '#/components/schemas/RunSnapshot' },
                      preflight: { $ref: '#/components/schemas/Preflight' },
                    },
                    required: ['run', 'preflight'],
                  },
                ],
              },
            ),
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
            200: jsonOk(
              { description: 'baseline / experiment / comparison（DSR/PB 等）/ newsSource' },
              { $ref: '#/components/schemas/BacktestEvaluation' },
            ),
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
          responses: {
            200: jsonOk(
              { description: '账户快照' },
              { $ref: '#/components/schemas/PaperPortfolio' },
            ),
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
            200: jsonOk(
              {
                description:
                  '审计条目：count 为**匹配总数**（不是本页条数，供「共 N 条 / 加载更多」），entries 为本页条目',
              },
              {
                type: 'object',
                properties: {
                  count: {
                    type: 'number',
                    description: '匹配条目总数（不受 limit/offset 影响，分页时也用它算总页数）',
                  },
                  entries: {
                    type: 'array',
                    description: '本页条目；offset 越界时为空数组（据此判断「没有更多」）',
                    items: { $ref: '#/components/schemas/AuditEntry' },
                  },
                },
                required: ['count', 'entries'],
              },
            ),
            400: errorResponse(
              '查询参数非法（时间戳需为 epoch 毫秒，limit/offset 需为 >= 0 的整数；' +
                'category 须为 llm_call/tool_call/trade_signal/data_access/user_query/system 之一，' +
                'riskLevel 须为 info/low/medium/high/critical 之一）',
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
            200: jsonOk(
              { description: '财务估值（degraded=true 表示部分数据源降级）' },
              { $ref: '#/components/schemas/IntlFundamentalsResult' },
            ),
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
                description:
                  '会话历史。role 非法（非 user/assistant）或 content 非字符串**直接 400**；' +
                  '条数/单条/总字符超限则夹紧（最近 N 条、超长截断），不报错',
                items: {
                  type: 'object',
                  properties: {
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string' },
                  },
                  // 两条都是必填：validateChatHistory 对 role/content 缺一即回 400，
                  // 声明成可选会让生成类型允许 `{}`，而那必然被服务端拒绝
                  required: ['role', 'content'],
                },
              },
              stockCode: { type: 'string' },
              sessionId: { type: 'string', description: '会话级记忆 ID' },
            },
            required: ['message'],
          }),
          responses: {
            200: jsonOk(
              { description: '回答（answer/toolsUsed/evidence/debate/verification/degraded 等）' },
              { $ref: '#/components/schemas/ChatAgentResponse' },
            ),
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
            200: {
              description:
                'SSE 事件流；最终事件 phase=done 携带完整回答。' +
                '**Content-Type 是 text/event-stream，不是 application/json**——' +
                '响应体是 `data: {事件JSON}\\n\\n` 的帧序列，故 schema 声明为 string（原始帧文本）。' +
                '单个事件 JSON 的形状见 components.schemas.ChatStreamEvent。',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    description:
                      'SSE 原始帧文本。每帧形如 `data: {"phase":"...","message":"..."}\\n\\n`，' +
                      '反序列化后即 ChatStreamEvent（done 帧的 response 字段是 ChatAgentResponse）。',
                  },
                },
              },
            },
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
          responses: {
            200: jsonOk({ description: 'ok' }, { $ref: '#/components/schemas/OkResult' }),
            400: errorResponse('缺少 sessionId'),
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
            200: jsonOk(
              { description: '最新清单' },
              { $ref: '#/components/schemas/WatchlistCodes' },
            ),
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
            200: jsonOk(
              { description: '最新清单' },
              { $ref: '#/components/schemas/WatchlistCodes' },
            ),
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
            200: jsonOk(
              { description: 'started + 循环状态' },
              {
                type: 'object',
                properties: {
                  started: { type: 'boolean', description: '恒为 true（启动成功才走到这行）' },
                  ...autonomousStateProperties,
                  ...coverageProperties,
                },
                required: [
                  'started',
                  'running',
                  'intervalMs',
                  'lastAlertCount',
                  'runCount',
                  'errorCount',
                ],
              },
            ),
            429: errorResponse('触发限流'),
            500: errorResponse('启动失败'),
          },
        },
      },
      '/api/autonomous/stop': {
        post: {
          tags: ['autonomous'],
          summary: '停止自治监控循环',
          responses: {
            200: jsonOk(
              { description: 'stopped + 最近一次预警' },
              {
                type: 'object',
                properties: {
                  stopped: {
                    type: 'boolean',
                    description: '恒为 true（未在运行也回 true，属幂等停止）',
                  },
                  lastAlerts: {
                    type: 'array',
                    description: '最近一轮检出的预警（进程内缓存，重启即空；从未预警过时为空数组）',
                    items: { $ref: '#/components/schemas/WatchlistAlert' },
                  },
                },
                required: ['stopped', 'lastAlerts'],
              },
            ),
          },
        },
      },
      '/api/autonomous/status': {
        get: {
          tags: ['autonomous'],
          summary: '自治循环状态',
          responses: {
            200: jsonOk(
              {
                description: 'running/intervalMs/runCount/errorCount 等；未运行时 {running:false}',
              },
              {
                type: 'object',
                properties: {
                  ...autonomousStateProperties,
                  ...coverageProperties,
                },
                // 未在运行时路由只回 { running: false }，其余字段全部缺省
                required: ['running'],
              },
            ),
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
            200: jsonOk(
              { description: '入库结果（id/insight/ingested）' },
              {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: '文档 ID（`ingested:<时间戳>`，内存态不落盘）',
                  },
                  title: { type: 'string', description: '回显的标题（已 trim 并截断到 200 字符）' },
                  ingested: {
                    type: 'boolean',
                    description: '恒为 true（失败走 500，不会出现 false）',
                  },
                  insight: { $ref: '#/components/schemas/DocumentInsight' },
                },
                required: ['id', 'title', 'ingested', 'insight'],
              },
            ),
            400: errorResponse('缺少标题或正文'),
            413: errorResponse('请求体超过 8MB 上限'),
            429: errorResponse('触发限流'),
            500: errorResponse('入库失败'),
          },
        },
      },
      '/api/documents': {
        get: {
          tags: ['documents'],
          summary: '已入库文档列表（含预览）',
          responses: {
            200: jsonOk(
              { description: 'count/docs' },
              { $ref: '#/components/schemas/DocumentList' },
            ),
          },
        },
      },
      '/api/models': {
        get: {
          tags: ['system'],
          summary: '多模型注册表与任务路由',
          responses: {
            200: jsonOk(
              { description: 'available/embeddingEnabled/registry/routing' },
              { $ref: '#/components/schemas/ModelRoutingInfo' },
            ),
          },
        },
      },
      '/api/cost': {
        get: {
          tags: ['system'],
          summary: 'LLM 成本报告',
          responses: {
            200: jsonOk(
              { description: 'totalCost/tokens/byModel' },
              { $ref: '#/components/schemas/CostReport' },
            ),
          },
        },
      },
      '/api/cost/reset': {
        post: {
          tags: ['system'],
          summary: '重置 LLM 成本账本',
          responses: {
            200: jsonOk({ description: 'ok' }, { $ref: '#/components/schemas/OkResult' }),
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
            200: jsonOk(
              { description: 'status=ok（缓存目录缺失时 cacheDir.status=missing，仍为 200）' },
              { $ref: '#/components/schemas/HealthReport' },
            ),
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
            200: jsonOk(
              { description: '{ items: HistorySummary[] }' },
              {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    description: '历史摘要（按 createdAt 倒序；不含完整 result）',
                    items: { $ref: '#/components/schemas/HistorySummary' },
                  },
                },
                required: ['items'],
              },
            ),
          },
        },
      },
      '/api/history/{id}': {
        get: {
          tags: ['history'],
          summary: '研究历史详情（含完整分析结果，可恢复研究报告）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: jsonOk(
              { description: 'HistoryItem（含 result）' },
              { $ref: '#/components/schemas/HistoryItem' },
            ),
            404: errorResponse('历史记录不存在'),
          },
        },
        delete: {
          tags: ['history'],
          summary: '删除一条研究历史',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: jsonOk(
              { description: '{ deleted: true }' },
              {
                type: 'object',
                properties: {
                  deleted: {
                    type: 'boolean',
                    description: '恒为 true（不存在时回 404，不会出现 false）',
                  },
                },
                required: ['deleted'],
              },
            ),
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
            200: jsonOk(
              { description: '{ boards: IndustryBoard[], stale?: true, staleAgeMs?: number }' },
              {
                type: 'object',
                properties: {
                  boards: {
                    type: 'array',
                    description: '现行一级行业板块（已滤掉名称以 Ⅱ/Ⅲ 结尾的旧体系子级）',
                    items: { $ref: '#/components/schemas/IndustryBoard' },
                  },
                  stale: {
                    type: 'boolean',
                    enum: [true],
                    description: '上游失败但磁盘有快照时为 true（如实披露这是陈旧快照）',
                  },
                  staleAgeMs: {
                    type: 'number',
                    description: '陈旧快照的年龄（毫秒）；仅 stale 时出现',
                  },
                },
                required: ['boards'],
              },
            ),
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
              horizons: horizonsSchema,
              includeFundamental: { type: 'boolean' },
              includeEvents: { type: 'boolean' },
              includeMargin: { type: 'boolean' },
              portfolio: { type: 'object' },
            },
          }),
          responses: {
            200: jsonOk(
              { description: 'CrossSectionResult（各因子 IC/分层收益 + 可选组合回测）' },
              { $ref: '#/components/schemas/CrossSectionResult' },
            ),
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
          description:
            '统一入口，按 test 分派到 ADF 单位根 / GARCH 族波动率 / Engle-Granger 协整 / ' +
            'ARIMA / Kalman 时变对冲比率。**test 与 code 缺省为空串**（由 analyzeTimeseries ' +
            '内部判定并回 400），故这里不设 required —— 契约描述的是「HTTP 层能收什么形状」，' +
            '「业务上必填什么」由服务层的校验文案承担。',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              test: { type: 'string', description: '分析类型（adf/garch/coint/arima/kalman）' },
              code: stockCodeSchema,
              code2: {
                ...stockCodeSchema,
                description: '配对检验的第二只标的（协整用）',
              },
              startDate: { type: 'string', format: 'date', description: '区间起（YYYY-MM-DD）' },
              endDate: { type: 'string', format: 'date', description: '区间止（YYYY-MM-DD）' },
              options: {
                type: 'object',
                description: '各 test 的专属参数（窗口长度、滞后阶数等），透传给分析器',
                additionalProperties: true,
              },
            },
          }),
          responses: {
            200: jsonOk(
              { description: '时序分析结果' },
              { $ref: '#/components/schemas/TimeseriesAnalyzeResult' },
            ),
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
              horizons: horizonsSchema,
              portfolio: { type: 'object' },
              startDate: { type: 'string', description: 'YYYY-MM-DD' },
              endDate: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['expression'],
          }),
          responses: {
            200: jsonOk(
              { description: '因子评估结果 + 组合回测（若请求 portfolio）+ 台账留痕条数' },
              { $ref: '#/components/schemas/FactorExpressionResult' },
            ),
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
              horizons: horizonsSchema,
            },
            required: ['expressions'],
          }),
          responses: {
            200: jsonOk(
              { description: '{ universe, horizons, requested, evaluated, results[] }' },
              { $ref: '#/components/schemas/FactorExpressionBatchResult' },
            ),
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
            200: jsonOk(
              { description: '该股的研究记忆（结论、争议点、跟踪项）' },
              { $ref: '#/components/schemas/ResearchMemory' },
            ),
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
            200: jsonOk(
              { description: '{ items: ResearchDigest[] }' },
              {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    description: '研究简报（按 createdAt 倒序，上限 60 条）',
                    items: { $ref: '#/components/schemas/ResearchDigest' },
                  },
                },
                required: ['items'],
              },
            ),
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
            200: jsonOk(
              { description: '本次生成的研究简报' },
              { $ref: '#/components/schemas/ResearchDigest' },
            ),
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
            200: jsonOk(
              { description: '公告列表，或 { artCode, content } 单篇全文' },
              {
                description: '带 artCode 时返回单篇全文，否则返回该股的公告列表',
                oneOf: [
                  { $ref: '#/components/schemas/AnnouncementListResult' },
                  {
                    type: 'object',
                    properties: {
                      artCode: { type: 'string', description: '请求的公告 art_code（回显）' },
                      content: {
                        type: 'string',
                        description: '公告正文（纯文本；PDF 公告上游可能返回空串）',
                      },
                    },
                    required: ['artCode', 'content'],
                  },
                ],
              },
            ),
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
            200: jsonOk(
              { description: '估值模型输出（现金流折现 + 敏感性）' },
              { $ref: '#/components/schemas/ValuationModelResult' },
            ),
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
            200: jsonOk(
              { description: '{ ok, checks…, tushare, baostock }' },
              {
                description:
                  '预检本体（ok/checks/degraded/checkedAt）加两个可选增强通道的状态块；' +
                  'tushare / baostock 未配置或失败都如实降级披露，不影响 preflight.ok',
                allOf: [
                  { $ref: '#/components/schemas/Preflight' },
                  {
                    type: 'object',
                    properties: {
                      tushare: {
                        type: 'object',
                        description:
                          'Tushare 增强通道（退市股名单/主表，24h 缓存）。未配置时只有 configured:false',
                        properties: {
                          configured: { type: 'boolean', description: '是否配置了 Tushare token' },
                          total: { type: 'number', description: '主表股票总数；取到时出现' },
                          listed: { type: 'number', description: '上市（L）只数' },
                          delisted: { type: 'number', description: '退市（D）只数' },
                          suspended: { type: 'number', description: '暂停上市（P）只数' },
                          degraded: {
                            type: 'boolean',
                            description: '已配置但取数失败（原因在 detail，不在响应里回传）',
                          },
                        },
                        required: ['configured'],
                      },
                      baostock: {
                        type: 'object',
                        description: 'Baostock sidecar 通道（指数历史成分，Python 子进程）',
                        properties: {
                          available: { type: 'boolean', description: 'sidecar 是否可用' },
                          hs300Count: {
                            type: 'number',
                            description: '最近一次 hs300 成分数；可用时出现',
                          },
                          updateDate: {
                            type: 'string',
                            nullable: true,
                            description: '成分快照的实际调仓日；可用时出现',
                          },
                          python: {
                            type: 'string',
                            description: '解释器路径（PYTHON_BIN 或 python）',
                          },
                          detail: {
                            type: 'string',
                            description: '不可用原因；available=false 时出现',
                          },
                        },
                        required: ['available', 'python'],
                      },
                    },
                    required: ['tushare', 'baostock'],
                  },
                ],
              },
            ),
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
            200: jsonOk(
              { description: '{ items, summary }' },
              {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    description: '台账条目（按 createdAt 倒序，受 source/kept/limit 过滤）',
                    items: { $ref: '#/components/schemas/FactorExperiment' },
                  },
                  summary: {
                    $ref: '#/components/schemas/FactorExperimentSummary',
                    description: '全量台账概览（不受上述过滤影响）',
                  },
                },
                required: ['items', 'summary'],
              },
            ),
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
            200: jsonOk(
              { description: '{ recorded }' },
              {
                type: 'object',
                properties: {
                  recorded: {
                    type: 'number',
                    description:
                      '实际写入的台账条数。**写盘失败时为 0**（台账是研究资产不是数据源，记录失败不阻断主流程）',
                  },
                },
                required: ['recorded'],
              },
            ),
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
            200: jsonOk(
              { description: '{ code, market, bars[] }' },
              {
                type: 'object',
                properties: {
                  code: { type: 'string', description: '归一后的证券代码' },
                  market: { type: 'string', enum: ['HK', 'US'] },
                  startDate: {
                    type: 'string',
                    description: '实际生效的起始日 YYYY-MM-DD（未传则默认近 2 年）',
                  },
                  endDate: {
                    type: 'string',
                    description: '实际生效的结束日 YYYY-MM-DD（未传则今天）',
                  },
                  count: { type: 'number', description: 'klines 条数（= 返回的 K 线根数）' },
                  klines: {
                    type: 'array',
                    description: '日 K 线（升序）；取数失败时为空数组而非报错',
                    items: { $ref: '#/components/schemas/IntlKline' },
                  },
                },
                required: ['code', 'market', 'startDate', 'endDate', 'count', 'klines'],
              },
            ),
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
            200: jsonOk(
              { description: '初筛结果（命中列表 + 各条件通过情况）' },
              { $ref: '#/components/schemas/ScreenerRunResult' },
            ),
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
            200: jsonOk(
              { description: '最近一次初筛的落盘结果' },
              { $ref: '#/components/schemas/ScreenerRunResult' },
            ),
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
              task: {
                type: 'string',
                enum: ['chat', 'analysis', 'debate', 'extract', 'reasoning', 'embedding'],
                description:
                  '任务标签，决定路由到哪类模型。**非法值不报错、也不参与路由**（按默认 chat 处理）——' +
                  '与 temperature/maxTokens 的「夹紧 + 记日志」口径一致：调用方传错标签时' +
                  '仍能拿到结果，只是走了默认模型。合法值与 llm/config.ts 的 LLMTask 单一来源同步。',
              },
              temperature: { type: 'number' },
              maxTokens: { type: 'integer' },
            },
            required: ['messages'],
          }),
          responses: {
            200: jsonOk(
              { description: '集成结果（各模型输出 + 汇总）' },
              { $ref: '#/components/schemas/EnsembleResult' },
            ),
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
            200: jsonOk(
              { description: '{ weights }' },
              {
                type: 'object',
                properties: {
                  weights: {
                    type: 'object',
                    description: '模型 ID → 权重（Laplace 平滑命中率，下限 1/3）',
                    additionalProperties: { type: 'number' },
                  },
                },
                required: ['weights'],
              },
            ),
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
            200: jsonOk(
              { description: '{ ok: true, weights }' },
              {
                type: 'object',
                properties: {
                  ok: { type: 'boolean', description: '恒为 true（记录成功才走到这行）' },
                  weights: {
                    type: 'object',
                    description: '记录后的模型权重快照（同 GET /api/llm/calibration）',
                    additionalProperties: { type: 'number' },
                  },
                },
                required: ['ok', 'weights'],
              },
            ),
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
            200: jsonOk(
              { description: '命中的技能路由结果' },
              { $ref: '#/components/schemas/SkillRoute' },
            ),
            429: errorResponse('触发限流'),
          },
        },
      },
      '/api/improvement/status': {
        get: {
          tags: ['system'],
          summary: '改进闭环状态（harness policy + 台账汇总）',
          responses: {
            200: jsonOk(
              { description: '{ state, ledger }' },
              { $ref: '#/components/schemas/ImprovementStatus' },
            ),
          },
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
            200: jsonOk(
              { description: '本轮改进结果（候选、采纳与否、配对统计护栏）' },
              { $ref: '#/components/schemas/ImprovementRunResult' },
            ),
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
            200: jsonOk(
              { description: '{ items }（limit 上限 200）' },
              {
                type: 'object',
                properties: {
                  limit: { type: 'number', description: '实际生效的条数上限（>200 会被夹到 200）' },
                  items: {
                    type: 'array',
                    description: '改进轮次记录（按 createdAt 倒序）',
                    items: { $ref: '#/components/schemas/ImprovementRecord' },
                  },
                },
                required: ['limit', 'items'],
              },
            ),
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
            200: jsonOk(
              { description: '调度已启动（含下次运行时间）' },
              {
                type: 'object',
                properties: {
                  started: {
                    type: 'boolean',
                    description:
                      '是否真的注册了定时器；env 显式关闭（IMPROVEMENT_INTERVAL_HOURS=0）且未传 intervalHours 时路由回 400，因此 200 下恒为 true',
                  },
                  scheduler: {
                    oneOf: [
                      { $ref: '#/components/schemas/ImprovementLoopState' },
                      { type: 'null' },
                    ],
                    description: '调度状态；started=false 时为 null',
                  },
                },
                required: ['started', 'scheduler'],
              },
            ),
            429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
          },
        },
      },
      '/api/improvement/scheduler/stop': {
        post: {
          tags: ['system'],
          summary: '停止改进闭环的周期调度',
          responses: {
            200: jsonOk(
              { description: '调度已停止' },
              {
                type: 'object',
                properties: {
                  stopped: {
                    type: 'boolean',
                    description: '恒为 true（未在运行也回 true，属幂等停止）',
                  },
                  scheduler: {
                    type: 'null',
                    description: '停止后恒为 null（不假装还有调度器在跑）',
                  },
                },
                required: ['stopped', 'scheduler'],
              },
            ),
            429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
          },
        },
      },
    },
    /**
     * 复用组件。**新增端点时优先引用这里的具名组件**，而不是内联展开：
     * 内联展开让同一形状在几十处各写一遍，改一处漏一处不会有任何测试变红
     * ——这正是本文件此前漏掉 25 条路由的同一个根因。
     *
     * 具名组件同时是类型生成器的锚点：components 里的每个键都会生成一个顶层
     * TS 类型，operation 里 $ref 引用它，因此「契约字段」与「前端类型」由
     * 同一处定义，不可能分叉。
     */
    components: {
      schemas: {
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
        /** 自选股列表（GET/POST/DELETE 三处共用同一形状） */
        WatchlistCodes: {
          type: 'object',
          properties: {
            codes: { type: 'array', items: { type: 'string' }, description: '当前自选股代码列表' },
          },
          required: ['codes'],
        },
        /** 仅确认语义的操作（成本重置 / 清空对话记忆 / 删除历史） */
        OkResult: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        /** 带 count 的列表响应（资料库等） */
        DocumentList: {
          type: 'object',
          properties: {
            count: { type: 'number', description: '文档总数' },
            docs: {
              type: 'array',
              description: '文档摘要列表',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  source: { type: 'string' },
                  preview: { type: 'string', description: '正文预览片段' },
                },
                required: ['id', 'source', 'preview'],
              },
            },
          },
          required: ['count', 'docs'],
        },
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
              required: [
                'profit_quality',
                'growth',
                'valuation',
                'industry_boom',
                'risk_deduction',
              ],
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
                  roe: { type: 'number' },
                  marketCap: { type: 'number' },
                },
                required: ['name', 'code', 'pe', 'pb', 'roe', 'marketCap'],
              },
            },
          },
          required: [
            'currentPrice',
            'pe',
            'pb',
            'ps',
            'marketCap',
            'historicalPE',
            'peerComparison',
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
                    enum: ['fact', 'inference', 'hypothesis'],
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
        ChartConfig: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            config: { type: 'object', additionalProperties: true },
          },
          required: ['type', 'title', 'config'],
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
              enum: [
                'llm_call',
                'tool_call',
                'trade_signal',
                'data_access',
                'user_query',
                'system',
              ],
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
        /** 港美股基础财务估值快照 */
        IntlFundamentals: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            market: { type: 'string', enum: ['HK', 'US'] },
            name: { type: 'string' },
            pe: { type: 'number' },
            pb: { type: 'number' },
            marketCap: { type: 'number', description: '亿元（本币计）' },
            revenue: { type: 'number' },
            netIncome: { type: 'number' },
            totalAssets: { type: 'number' },
            totalLiabilities: { type: 'number' },
            currency: { type: 'string', description: 'HKD / USD' },
            dataSource: { type: 'string' },
          },
          required: [
            'code',
            'market',
            'name',
            'pe',
            'pb',
            'marketCap',
            'revenue',
            'netIncome',
            'totalAssets',
            'totalLiabilities',
            'currency',
            'dataSource',
          ],
        },
        /** 港美股财务估值获取结果（含降级标记） */
        IntlFundamentalsResult: {
          type: 'object',
          properties: {
            // 可空必须**写进 schema**（oneOf + null），不能只在 description 里写「可能为 null」：
            // 后者对类型生成器是不可见的，生成出的类型会是非空 IntlFundamentals，
            // 而服务端真的会在上游不可用时回 null —— 消费方按契约写代码就会崩。
            fundamentals: {
              oneOf: [{ $ref: '#/components/schemas/IntlFundamentals' }, { type: 'null' }],
              description: '上游不可用时为 null（降级场景）',
            },
            degraded: { type: 'boolean', description: '是否为降级结果' },
            source: { type: 'string' },
            fetchedAt: { type: 'string' },
          },
          required: ['fundamentals', 'degraded', 'source', 'fetchedAt'],
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
        /** 行业板块（universe 下拉用） */
        IndustryBoard: {
          type: 'object',
          properties: { code: { type: 'string' }, name: { type: 'string' } },
          required: ['code', 'name'],
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
                        required: [
                          'totalReturn',
                          'sharpeRatio',
                          'maxDrawdown',
                          'winRate',
                          'posture',
                        ],
                      },
                    },
                    required: [
                      'strategyType',
                      'totalReturn',
                      'sharpeRatio',
                      'maxDrawdown',
                      'winRate',
                    ],
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

        /**
         * 港美股日 K 线单点（GET /api/intl/klines 的 klines 元素）。
         * 字段来源：server/src/quant/types.ts 的 OHLCVData——港美股与 A 股
         * 共用同一取数通道（quant/dataProvider.fetchKlineBySecid），故字段同名同义。
         * isSimulated 只在取数降级为模拟数据时出现，故不进 required。
         */
        IntlKline: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            open: { type: 'number' },
            high: { type: 'number' },
            low: { type: 'number' },
            close: { type: 'number' },
            volume: { type: 'number' },
            isSimulated: { type: 'boolean', description: '上游取数失败降级为模拟数据' },
          },
          required: ['date', 'open', 'high', 'low', 'close', 'volume'],
        },

        /**
         * 文档洞察（POST /api/ingest 的 insight 字段）。
         * 字段来源：server/src/services/documentInsights.ts 的 DocumentInsight。
         * confidence/source 是**枚举字符串**而非数字/自由串：LLM 不可用时走词典
         * 兜底（source='heuristic'），两条路径的取值都被 normalize* 收窄在该枚举内。
         */
        DocumentInsight: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '全文摘要（中文）' },
            positives: { type: 'array', items: { type: 'string' }, description: '利好要点' },
            risks: { type: 'array', items: { type: 'string' }, description: '风险要点' },
            catalysts: { type: 'array', items: { type: 'string' }, description: '催化剂要点' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            source: {
              type: 'string',
              enum: ['llm', 'heuristic'],
              description: 'llm=模型抽取；heuristic=词典法兜底（LLM 未配置/失败）',
            },
          },
          required: ['summary', 'positives', 'risks', 'catalysts', 'confidence', 'source'],
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
          required: [
            'totalCost',
            'totalPromptTokens',
            'totalCompletionTokens',
            'callCount',
            'byModel',
          ],
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

        /* ===== 对话（SSE done 事件与 POST /api/chat 复用同一响应体）===== */

        /**
         * 对话回答（POST /api/chat 200 与 GET /api/chat/stream 的 done 事件共用）。
         * 字段来源：server/src/services/chatAgent.ts 的 ChatAgentResponse
         * （前端 client.ts 的同名 interface 是它的投影，字段一致）。
         * debate/riskDebate/plan/verification 四个是**条件性**字段：只在走到
         * 对应路径（辩论 / 风控关键词 / LLM 规划可用 / use_tools 有工具结果）时
         * 才出现，故一律不进 required；degraded 恒在（规则降级时为 true）。
         */
        ChatAgentResponse: {
          type: 'object',
          properties: {
            answer: { type: 'string', description: '回答正文（中文 Markdown）' },
            toolsUsed: {
              type: 'array',
              items: { type: 'string' },
              description: '本次调用的工具名',
            },
            evidence: {
              type: 'array',
              description: 'RAG 检索命中的证据片段（回答的引用出处）',
              items: { $ref: '#/components/schemas/ChatEvidence' },
            },
            debate: {
              type: 'object',
              description: '多空辩论结果；未走辩论路径时缺省',
              properties: {
                bull: { type: 'string' },
                bear: { type: 'string' },
                synthesis: { type: 'string', description: '仲裁后的综合结论' },
              },
              required: ['bull', 'bear', 'synthesis'],
            },
            riskDebate: {
              type: 'object',
              description: '风控三分视角辩论；debate 路径或风控关键词命中时出现',
              properties: {
                aggressive: { type: 'string' },
                neutral: { type: 'string' },
                conservative: { type: 'string' },
                synthesis: { type: 'string' },
              },
              required: ['aggressive', 'neutral', 'conservative', 'synthesis'],
            },
            plan: {
              type: 'object',
              description: '路由规划结果；仅 LLM 可用时出现（降级为规则路径时缺省）',
              properties: {
                action: { type: 'string', enum: ['direct', 'tools', 'debate'] },
                reason: { type: 'string' },
                skill: { $ref: '#/components/schemas/SkillId' },
              },
              required: ['action', 'reason'],
            },
            verification: {
              type: 'object',
              description: '幻觉防护校验结果；仅 use_tools 路径且有工具结果时出现',
              properties: {
                verified: { type: 'boolean', description: 'true=所有关键断言可验证' },
                unverified: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '无法在工具结果/证据里找到对应的断言',
                },
                calculationErrors: {
                  type: 'array',
                  description: '能定位到来源但算术重构后不一致的数值错误',
                  items: { $ref: '#/components/schemas/CalculationError' },
                },
                warning: { type: 'string', description: '给用户的警示文案（无问题时为空串）' },
              },
              required: ['verified', 'unverified', 'calculationErrors', 'warning'],
            },
            degraded: { type: 'boolean', description: 'true = LLM 未配置，走规则降级' },
            model: { type: 'string', description: '产出本回答的模型 ID；降级时缺省' },
          },
          required: ['answer', 'toolsUsed', 'evidence', 'degraded'],
        },

        /** RAG 证据片段（ChatAgentResponse 的 evidence 元素） */
        ChatEvidence: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            source: { type: 'string', description: '来源标识（如 `doc:<标题>`）' },
            text: { type: 'string', description: '命中的原文片段' },
            stockCode: { type: 'string', description: '证据关联的标的；非标的文档时缺省' },
          },
          required: ['id', 'source', 'text'],
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
          required: [
            'claim',
            'reconstructedFormula',
            'recomputedValue',
            'claimedValue',
            'discrepancy',
          ],
        },

        /**
         * 对话流式事件（GET /api/chat/stream 的单帧 JSON）。
         * 字段来源：server/src/services/chatAgent.ts 的 ChatStreamEvent。
         * 声明成「公共字段 + 按 phase 追加」的扁平对象而不是逐 phase 的 oneOf：
         * 消费方（client.ts 的 ChatStreamEvent、EventSource onmessage）本来就按
         * `phase` 判别后读零散字段，oneOf 会让它们多一层收窄才能用。
         * tools（tool_calling）与 response（done）只在该 phase 出现。
         */
        ChatStreamEvent: {
          type: 'object',
          properties: {
            phase: {
              type: 'string',
              enum: [
                'planning',
                'retrieving',
                'tool_calling',
                'debating',
                'risk_debating',
                'verifying',
                'done',
                'error',
              ],
            },
            message: { type: 'string', description: '该阶段的人话进度说明' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: '正在/已调用的工具名；仅 phase=tool_calling 时出现',
            },
            response: {
              $ref: '#/components/schemas/ChatAgentResponse',
              description: '完整回答；仅 phase=done 时出现',
            },
          },
          required: ['phase', 'message'],
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
          required: [
            'minIcSamples',
            'significanceLevel',
            'minMonotonicity',
            'requirePositiveSpread',
          ],
        },

        /**
         * 改进闭环状态（GET /api/improvement/status）。
         * 字段来源：server/src/routes/improvement.ts 的该路由响应字面量。
         * replay 整块刻意暴露「可回放证据够不够」：判据证据是本次改造起才开始
         * 留痕的，刚上线时 available 必然远小于 required——藏起来用户会以为循环
         * 在干活，实际它每次都因证据不足直接返回。scheduler 未启动时为 null
         * （不假装在跑），policyUpdatedAt / lastChange 在判据仍是出厂值时为 null。
         */
        ImprovementStatus: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: ['factor-verdict-policy'] },
            policy: { $ref: '#/components/schemas/HarnessPolicy' },
            policySource: {
              type: 'string',
              enum: ['default', 'stored'],
              description: 'default=仍是出厂判据；stored=已从落盘文件读回',
            },
            policyUpdatedAt: { type: 'string', nullable: true, description: '判据落盘时间' },
            policyRevision: { type: 'number', description: '判据保留次数（每保留一次改动 +1）' },
            lastChange: { type: 'string', nullable: true, description: '上一次改动的摘要' },
            isFactoryPolicy: { type: 'boolean', description: '判据是否仍是出厂值（从未被改动过）' },
            ledger: {
              type: 'object',
              description: '改进台账汇总（quant/improvementLedger.summarizeImprovements）',
              properties: {
                total: { type: 'number' },
                kept: { type: 'number' },
                reverted: { type: 'number' },
                lastAt: { type: 'string', nullable: true, description: '最近一轮时间' },
                lastKeptAt: {
                  type: 'string',
                  nullable: true,
                  description: '最近一次被保留的改动时间',
                },
                triedCandidates: {
                  type: 'number',
                  description: '历史试过的去重候选数（负结果复用的抓手）',
                },
              },
              required: ['total', 'kept', 'reverted', 'lastAt', 'lastKeptAt', 'triedCandidates'],
            },
            replay: {
              type: 'object',
              description: '可回放证据盘点：ready=false 时 run 会直接返回原因、不评估候选',
              properties: {
                available: { type: 'number', description: '带判据证据、可参与回放的记录数' },
                required: { type: 'number', description: '跑一轮所需的最小证据数' },
                validationRequired: { type: 'number', description: '验证集所需的最小条数' },
                validationAvailable: { type: 'number', description: '按同一口径切出的验证集条数' },
                ready: { type: 'boolean', description: '现在跑一轮是否会真的评估候选' },
                note: { type: 'string', description: '口径说明（改造前的历史记录不参与回放）' },
              },
              required: [
                'available',
                'required',
                'validationRequired',
                'validationAvailable',
                'ready',
                'note',
              ],
            },
            decision: {
              type: 'object',
              description: '决策门槛：让调用方知道「显著」是按什么标准判的',
              properties: {
                alpha: { type: 'number', description: '显著性阈值（DECISION_ALPHA）' },
                test: { type: 'string', description: '检验方法（人话说明）' },
              },
              required: ['alpha', 'test'],
            },
            scheduler: {
              oneOf: [{ $ref: '#/components/schemas/ImprovementLoopState' }, { type: 'null' }],
              description: '周期调度状态；未启动为 null',
            },
          },
          required: [
            'target',
            'policy',
            'policySource',
            'policyUpdatedAt',
            'policyRevision',
            'lastChange',
            'isFactoryPolicy',
            'ledger',
            'replay',
            'decision',
            'scheduler',
          ],
        },

        /**
         * 改进一轮的结果（POST /api/improvement/run）。
         * 字段来源：routes/improvement.ts 的响应字面量（取自
         * quant/improvementLoop.runImprovementRound 的 ImprovementRoundResult）。
         * record 在 dryRun 时**恒为 null**（演练不落盘）——这是必填可空，
         * 不是可选：调用方据它判断「有记录 ≠ 已生效」。
         */
        ImprovementRunResult: {
          type: 'object',
          properties: {
            changed: { type: 'boolean', description: '判据是否真的被改动并落盘生效' },
            reason: {
              type: 'string',
              description: '结局说明（中文）；changed=false 时即为未改动的原因',
            },
            evaluated: { type: 'number', description: '本轮真正评估过的候选数' },
            dryRun: { type: 'boolean', description: '本次是否为演练（true=只评估不落盘）' },
            record: {
              oneOf: [{ $ref: '#/components/schemas/ImprovementRecord' }, { type: 'null' }],
              description: '写入台账的记录；dryRun=true 或本轮未产生记录时为 null',
            },
            policy: { $ref: '#/components/schemas/HarnessPolicy' },
            policySource: { type: 'string', enum: ['default', 'stored'] },
            policyRevision: { type: 'number' },
          },
          required: [
            'changed',
            'reason',
            'evaluated',
            'dryRun',
            'record',
            'policy',
            'policySource',
            'policyRevision',
          ],
        },

        /**
         * 改进台账条目（POST /api/improvement/run 的 record、
         * GET /api/improvement/history 的 items 元素）。
         * 字段来源：server/src/quant/improvementLedger.ts 的 ImprovementRecord。
         * significance 是配对 McNemar 精确检验的原始计数（b/c 是可复核的最小
         * 充分统计量，p 值由它算出）——只记「精度从多少升到多少」在样本少时
         * 可能来自完全不同的证据强度，故把计数一并落盘。
         */
        ImprovementRecord: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            createdAt: { type: 'string' },
            target: { type: 'string', enum: ['factor-verdict-policy'] },
            basis: {
              type: 'object',
              description: '本轮用到多少经验、怎么切的训练/验证集',
              properties: {
                evidenceCount: {
                  type: 'number',
                  description: '带完整判据证据、可参与回放的记录数',
                },
                trainCount: { type: 'number', description: '训练集条数（较早的一段）' },
                validationCount: { type: 'number', description: '验证集条数（较新的一段）' },
                split: { type: 'string', description: '切分口径的人可读说明' },
              },
              required: ['evidenceCount', 'trainCount', 'validationCount', 'split'],
            },
            before: {
              $ref: '#/components/schemas/HarnessPolicy',
              description: '改动前的判据（回滚基准）',
            },
            after: {
              $ref: '#/components/schemas/HarnessPolicy',
              description: '本轮胜出的候选判据',
            },
            metric: {
              type: 'object',
              description: '决策指标：验证集上的「采信集样本外稳定占比」（使用者口径）',
              properties: {
                name: { type: 'string', enum: ['oos-precision'] },
                before: { type: 'number' },
                after: { type: 'number' },
                delta: { type: 'number' },
                keptBefore: { type: 'number', description: '改前采信条数（精度须连着样本量读）' },
                keptAfter: { type: 'number', description: '改后采信条数' },
              },
              required: ['name', 'before', 'after', 'delta', 'keptBefore', 'keptAfter'],
            },
            significance: {
              type: 'object',
              description: '配对 McNemar 精确检验的原始计数与判定',
              properties: {
                accuracyBefore: { type: 'number', description: '改前判定准确率' },
                accuracyAfter: { type: 'number', description: '改后判定准确率' },
                afterBetter: { type: 'number', description: '改后对、改前错的条数（McNemar b）' },
                beforeBetter: { type: 'number', description: '改前对、改后错的条数（McNemar c）' },
                pValue: { type: 'number', description: '双侧精确 p 值' },
                alpha: { type: 'number', description: '判定阈值' },
                significant: { type: 'boolean', description: '是否达到显著（决策必要条件之一）' },
              },
              required: [
                'accuracyBefore',
                'accuracyAfter',
                'afterBetter',
                'beforeBetter',
                'pValue',
                'alpha',
                'significant',
              ],
            },
            outcome: { type: 'string', enum: ['kept', 'reverted'] },
            verdict: { type: 'string', description: '中文判定说明，可直接展示给用户' },
            tried: {
              type: 'array',
              description: '本轮试过的全部候选（含被否的），用于避免重复试探',
              items: { $ref: '#/components/schemas/TriedCandidate' },
            },
          },
          required: [
            'id',
            'createdAt',
            'target',
            'basis',
            'before',
            'after',
            'metric',
            'significance',
            'outcome',
            'verdict',
            'tried',
          ],
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

        /**
         * 改进闭环的调度状态（ImprovementStatus.scheduler 与
         * POST /api/improvement/scheduler/start 的 scheduler 字段）。
         * 字段来源：server/src/services/improvementScheduler.ts 的 ImprovementLoopState。
         * lastRunAt / lastReason / lastError 只在跑过轮次（或失败过）后出现。
         */
        ImprovementLoopState: {
          type: 'object',
          properties: {
            running: { type: 'boolean', description: '调度是否在运行' },
            intervalMs: { type: 'number', description: '当前生效的轮询间隔（毫秒）' },
            lastRunAt: { type: 'string', description: '最近一轮结束时间（ISO）；未跑过时缺省' },
            lastReason: { type: 'string', description: '最近一轮的结局说明（中文）' },
            lastChanged: { type: 'boolean', description: '最近一轮是否真的改动了判据' },
            runCount: { type: 'number', description: '已发起的轮次（含失败轮次）' },
            errorCount: { type: 'number', description: '抛异常的轮次数' },
            consecutiveErrors: {
              type: 'number',
              description: '连续失败次数（成功后清零），退避与自动停止的依据',
            },
            stoppedByErrors: {
              type: 'boolean',
              description: '是否因连续失败被自动停止（与用户主动 stop 区分）',
            },
            lastError: { type: 'string', description: '最近一次失败原因' },
          },
          required: [
            'running',
            'intervalMs',
            'lastChanged',
            'runCount',
            'errorCount',
            'consecutiveErrors',
            'stoppedByErrors',
          ],
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
                oneOf: [
                  { $ref: '#/components/schemas/FactorPredictabilityHorizon' },
                  { type: 'null' },
                ],
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
              description:
                'K 线是否来自取数失败后的合成降级；旧版结果可能缺此字段（缺省视为非模拟）',
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
          required: [
            'requested',
            'succeeded',
            'failed',
            'items',
            'startDate',
            'endDate',
            'horizons',
          ],
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
          required: [
            'name',
            'value',
            'direction',
            'category',
            'evidence',
            'aShareAdjusted',
            'available',
          ],
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
      },
    },
  };
}
