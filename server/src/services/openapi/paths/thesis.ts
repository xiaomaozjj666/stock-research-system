import { errorResponse, jsonBody, jsonOk, stockCodeSchema, thesisInputSchema } from '../shared.js';

export const thesisPaths = {
  '/api/theses': {
    post: {
      tags: ['analysis'],
      summary: '创建可证伪投资论点预注册',
      description: '创建时冻结论点、证伪条件、期限、基准与成交规则；不提供修改口径的接口。',
      requestBody: jsonBody(thesisInputSchema),
      responses: {
        201: jsonOk(
          { description: '已创建的 active 预注册记录' },
          {
            type: 'object',
            properties: { thesis: { $ref: '#/components/schemas/ThesisRecord' } },
            required: ['thesis'],
          },
        ),
        400: errorResponse('预注册参数无效'),
        500: errorResponse('预注册创建失败'),
      },
    },
    get: {
      tags: ['analysis'],
      summary: '查询可证伪投资论点预注册',
      parameters: [{ name: 'stockCode', in: 'query', schema: stockCodeSchema }],
      responses: {
        200: jsonOk(
          { description: '预注册记录（可按股票代码过滤）' },
          {
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/ThesisRecord' } },
            },
            required: ['items'],
          },
        ),
        400: errorResponse('股票代码无效'),
      },
    },
  },
  '/api/theses/{id}/evaluate': {
    post: {
      tags: ['analysis'],
      summary: '按冻结口径评估预注册实验',
      description: '到期前保持 active；到期后仅用真实且已完成的 K 线判定 invalidated/expired。',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: jsonOk(
          { description: '评估后的预注册记录（终态重复评估幂等）' },
          {
            type: 'object',
            properties: { thesis: { $ref: '#/components/schemas/ThesisRecord' } },
            required: ['thesis'],
          },
        ),
        404: errorResponse('预注册实验不存在'),
        500: errorResponse('预注册评估失败'),
      },
    },
  },
};
