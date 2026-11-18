import { errorResponse, jsonBody, jsonOk } from '../shared.js';

export const researchPaths = {
  '/api/research/deep': {
    post: {
      tags: ['analysis'],
      summary: '多步深度研究（同步）',
      description:
        '开放问题 -> 自动拆解子问题 -> 多轮检索取证（公告 / 新闻 / 内部知识库）-> 交叉验证与冲突裁决 ' +
        '-> 生成带逐条引用的结构化报告。与 POST /api/analyze 的区别：analyze 面向「给定代码跑固定专家流水线」，' +
        '本端点面向「给定开放问题，Agent 自主规划检索」。依赖 LLM，未配置时返回 503。',
      requestBody: jsonBody({
        type: 'object',
        properties: {
          question: { type: 'string', description: '研究问题（4-500 字）' },
          scope: { $ref: '#/components/schemas/ResearchScopeInput' },
          config: { $ref: '#/components/schemas/ResearchConfigInput' },
        },
        required: ['question'],
      }),
      responses: {
        200: jsonOk(
          { description: '完整研究结果（报告 / 计划 / 证据 / 验证 / 事件 / 统计）' },
          { $ref: '#/components/schemas/ResearchRunResult' },
        ),
        400: errorResponse('问题为空/过短/过长，或 scope/config 参数非法'),
        429: errorResponse('已有深度研究任务在运行（并发上限 2），或触发限流'),
        500: errorResponse('研究过程失败（LLM 输出连续不合规、上游数据源异常等）'),
        503: errorResponse('未配置 LLM（深度研究无规则降级路径）'),
      },
    },
  },
  '/api/research/deep/stream': {
    get: {
      tags: ['analysis'],
      summary: '多步深度研究（SSE 流式）',
      description:
        '逐条推送 AgentEvent（run_started / plan_created / retrieval_* / verification_completed / ' +
        'synthesis_* / run_finished），最终 phase=done 事件携带完整研究结果。',
      parameters: [
        {
          name: 'question',
          in: 'query',
          required: true,
          schema: { type: 'string', description: '研究问题（4-500 字）' },
        },
        {
          name: 'scope',
          in: 'query',
          description: 'ResearchScopeInput 的 JSON 字符串（URL 编码）',
          schema: { type: 'string' },
        },
        {
          name: 'config',
          in: 'query',
          description: 'ResearchConfigInput 的 JSON 字符串（URL 编码）',
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description:
            'SSE 事件流：`data: {"phase":"agent_event","event":{...}}\\n\\n` 推送过程，' +
            '`{"phase":"done","result":{...}}` 收尾，`{"phase":"error","message":"..."}` 表示失败。' +
            '**Content-Type 是 text/event-stream，不是 application/json**，故 schema 声明为 string（原始帧文本）。',
          content: {
            'text/event-stream': {
              schema: {
                type: 'string',
                description: 'SSE 原始帧序列',
              },
            },
          },
        },
        400: errorResponse('参数非法'),
        429: errorResponse('并发已达上限或触发限流'),
        503: errorResponse('未配置 LLM'),
      },
    },
  },
  '/api/research/runs': {
    get: {
      tags: ['analysis'],
      summary: '列出历史深度研究（摘要）',
      description:
        '按时间倒序返回最近的研究摘要（不含报告正文）。研究库用于复查结论：' +
        '一次深度研究会跑几十次 LLM 调用，刷新页面不应该让结论消失。',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          description: '返回条数（1-50，默认 20；研究库上限 30 条）',
          schema: { type: 'integer', minimum: 1, maximum: 50 },
        },
      ],
      responses: {
        200: jsonOk(
          { description: '研究摘要列表（新 -> 旧）' },
          { $ref: '#/components/schemas/ResearchRunList' },
        ),
        400: errorResponse('limit 不是 1-50 的整数'),
      },
    },
  },
  '/api/research/runs/{id}': {
    get: {
      tags: ['analysis'],
      summary: '读取单次历史研究的完整结果',
      description: '返回报告、证据、验证、事件轨迹与统计，字段与 POST /api/research/deep 一致。',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', description: '研究记录 id' },
        },
      ],
      responses: {
        200: jsonOk(
          { description: '完整研究记录' },
          { $ref: '#/components/schemas/SavedResearchRun' },
        ),
        404: errorResponse('研究记录不存在'),
      },
    },
    delete: {
      tags: ['analysis'],
      summary: '删除单次历史研究',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', description: '研究记录 id' },
        },
      ],
      responses: {
        200: jsonOk(
          { description: '删除成功' },
          { type: 'object', properties: { ok: { type: 'boolean' } } },
        ),
        404: errorResponse('研究记录不存在'),
        429: errorResponse('写操作限流'),
      },
    },
  },
};
