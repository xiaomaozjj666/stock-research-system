import { errorResponse, jsonBody, jsonOk } from '../shared.js';

export const chatPaths = {
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
};
