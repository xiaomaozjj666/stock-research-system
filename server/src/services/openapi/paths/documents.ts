import { errorResponse, jsonBody, jsonOk } from '../shared.js';

export const documentsPaths = {
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
        200: jsonOk({ description: 'count/docs' }, { $ref: '#/components/schemas/DocumentList' }),
      },
    },
  },
};
