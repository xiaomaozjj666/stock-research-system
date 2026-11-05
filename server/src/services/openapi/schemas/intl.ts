export const intlSchemas = {
  /** 港美股基础财务估值快照 */
  IntlFundamentals: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      market: { type: 'string', enum: ['HK', 'US'] },
      name: { type: 'string' },
      pe: { type: 'number' },
      pb: { type: 'number' },
      marketCap: { type: 'number', description: '亿元（本币计）' },
      revenue: { type: 'number' },
      netIncome: { type: 'number' },
      totalAssets: { type: 'number' },
      totalLiabilities: { type: 'number' },
      currency: { type: 'string', description: 'HKD / USD' },
      dataSource: { type: 'string' },
    },
    required: [
      'code',
      'market',
      'name',
      'pe',
      'pb',
      'marketCap',
      'revenue',
      'netIncome',
      'totalAssets',
      'totalLiabilities',
      'currency',
      'dataSource',
    ],
  },
  /** 港美股财务估值获取结果（含降级标记） */
  IntlFundamentalsResult: {
    type: 'object',
    properties: {
      // 可空必须**写进 schema**（oneOf + null），不能只在 description 里写「可能为 null」：
      // 后者对类型生成器是不可见的，生成出的类型会是非空 IntlFundamentals，
      // 而服务端真的会在上游不可用时回 null —— 消费方按契约写代码就会崩。
      fundamentals: {
        oneOf: [{ $ref: '#/components/schemas/IntlFundamentals' }, { type: 'null' }],
        description: '上游不可用时为 null（降级场景）',
      },
      degraded: { type: 'boolean', description: '是否为降级结果' },
      source: { type: 'string' },
      fetchedAt: { type: 'string' },
    },
    required: ['fundamentals', 'degraded', 'source', 'fetchedAt'],
  },

  /**
   * 港美股日 K 线单点（GET /api/intl/klines 的 klines 元素）。
   * 字段来源：server/src/quant/types.ts 的 OHLCVData——港美股与 A 股
   * 共用同一取数通道（quant/dataProvider.fetchKlineBySecid），故字段同名同义。
   * isSimulated 只在取数降级为模拟数据时出现，故不进 required。
   */
  IntlKline: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      open: { type: 'number' },
      high: { type: 'number' },
      low: { type: 'number' },
      close: { type: 'number' },
      volume: { type: 'number' },
      isSimulated: { type: 'boolean', description: '上游取数失败降级为模拟数据' },
    },
    required: ['date', 'open', 'high', 'low', 'close', 'volume'],
  },
};
