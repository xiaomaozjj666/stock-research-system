import { errorResponse, horizonsSchema, jsonBody, jsonOk, stockCodeSchema } from '../shared.js';

export const quantPaths = {
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
};
