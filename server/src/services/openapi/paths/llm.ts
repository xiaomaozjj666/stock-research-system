import { errorResponse, jsonBody, jsonOk } from '../shared.js';

export const llmPaths = {
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
};
