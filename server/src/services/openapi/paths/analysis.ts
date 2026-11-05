import { errorResponse, jsonBody, jsonOk, stockCodeSchema } from '../shared.js';

export const analysisPaths = {
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
};
