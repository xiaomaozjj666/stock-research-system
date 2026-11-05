import { errorResponse, jsonOk } from '../shared.js';

export const marketPaths = {
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
      parameters: [{ name: 'keyword', in: 'query', required: true, schema: { type: 'string' } }],
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
};
