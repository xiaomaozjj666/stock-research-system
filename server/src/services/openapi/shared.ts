/**
 * OpenAPI 共享构件：版本号、通用 schema 片段与响应包装 helper。
 * 由 scripts/split-openapi.mts 从原单文件 openapi.ts 迁移而来（按域拆分见 paths/ 与 schemas/）。
 */

export const OPENAPI_VERSION = '3.1.0';

export const stockCodeSchema = {
  type: 'string',
  pattern: '^\\d{6}$',
  description: '6 位 A 股股票代码，如 600519',
  examples: ['600519'],
};

export const errorResponse = (description: string) => ({
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

export const horizonsSchema = {
  type: 'array',
  items: { type: 'integer', minimum: 1, maximum: 504 },
  minItems: 1,
  maxItems: 8,
  description: '持有期档位（交易日）：1-504 的整数，最多 8 档，缺省 [21, 63]；非法即 400',
};

export const thesisInputSchema = {
  type: 'object',
  properties: {
    stockCode: stockCodeSchema,
    thesis: { type: 'string', description: '可证伪投资论点（最长 500 字）' },
    rating: { type: 'string', description: '创建时冻结的评级' },
    totalScore: { type: 'number', description: '创建时评分（可选）' },
    metric: { type: 'string', enum: ['close_price', 'return_pct', 'excess_return_pct'] },
    comparator: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte'] },
    threshold: { type: 'number' },
    horizonDays: { type: 'integer', minimum: 1, maximum: 3650 },
    evidenceSource: { type: 'string', enum: ['real_ohlcv'] },
    invalidationAction: { type: 'string', description: '失效后动作（最长 200 字）' },
    benchmarkCode: stockCodeSchema,
    execution: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['buy'] },
        orderType: { type: 'string', enum: ['market', 'limit'] },
        entryPrice: { type: 'number' },
        quantity: { type: 'integer' },
        limitPrice: { type: 'number' },
        commissionRate: { type: 'number' },
        stampDutyRate: { type: 'number' },
      },
      required: ['side', 'orderType', 'entryPrice', 'quantity', 'commissionRate', 'stampDutyRate'],
    },
  },
  required: [
    'stockCode',
    'thesis',
    'rating',
    'metric',
    'comparator',
    'threshold',
    'horizonDays',
    'evidenceSource',
    'invalidationAction',
    'benchmarkCode',
    'execution',
  ],
};

export const jsonBody = (schema: unknown, description?: string) => ({
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

export const jsonOk = (opts: { description: string }, schema: unknown) => ({
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

export const autonomousStateProperties = {
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

export const coverageProperties = {
  requested: { type: 'number', description: '本轮请求的清单总只数（裁剪前）' },
  skipped: { type: 'number', description: '因单次上限被跳过、本轮未取数的只数' },
};
