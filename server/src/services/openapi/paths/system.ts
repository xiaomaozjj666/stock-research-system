import { errorResponse, jsonOk } from '../shared.js';

export const systemPaths = {
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
};
