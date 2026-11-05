import { errorResponse, jsonOk } from '../shared.js';

export const intlPaths = {
  '/api/intl/fundamentals': {
    get: {
      tags: ['intl'],
      summary: '港美股财务估值（东财 datacenter RPT 网关）',
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        {
          name: 'market',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['HK', 'US'],
            description: '缺省自动推断；A 股代码会被拒绝',
          },
        },
      ],
      responses: {
        200: jsonOk(
          { description: '财务估值（degraded=true 表示部分数据源降级）' },
          { $ref: '#/components/schemas/IntlFundamentalsResult' },
        ),
        400: errorResponse('缺少代码或 A 股代码'),
        500: errorResponse('数据获取失败'),
      },
    },
  },
  '/api/intl/klines': {
    get: {
      tags: ['intl'],
      summary: '港美股 K 线（默认近 2 年）',
      description: '仅港/美股；A 股代码请走量化/行情既有接口，传入会返回 400 而非误导性数据。',
      parameters: [
        { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
        {
          name: 'market',
          in: 'query',
          required: true,
          schema: { type: 'string', enum: ['HK', 'US'] },
        },
        {
          name: 'startDate',
          in: 'query',
          schema: { type: 'string', description: 'YYYY-MM-DD' },
        },
        { name: 'endDate', in: 'query', schema: { type: 'string', description: 'YYYY-MM-DD' } },
      ],
      responses: {
        200: jsonOk(
          { description: '{ code, market, bars[] }' },
          {
            type: 'object',
            properties: {
              code: { type: 'string', description: '归一后的证券代码' },
              market: { type: 'string', enum: ['HK', 'US'] },
              startDate: {
                type: 'string',
                description: '实际生效的起始日 YYYY-MM-DD（未传则默认近 2 年）',
              },
              endDate: {
                type: 'string',
                description: '实际生效的结束日 YYYY-MM-DD（未传则今天）',
              },
              count: { type: 'number', description: 'klines 条数（= 返回的 K 线根数）' },
              klines: {
                type: 'array',
                description: '日 K 线（升序）；取数失败时为空数组而非报错',
                items: { $ref: '#/components/schemas/IntlKline' },
              },
            },
            required: ['code', 'market', 'startDate', 'endDate', 'count', 'klines'],
          },
        ),
        400: errorResponse('参数非法，或传入 A 股代码'),
        429: errorResponse('触发限流（元数据默认每分钟 30 次）'),
        502: errorResponse('上游 K 线获取失败'),
      },
    },
  },
};
