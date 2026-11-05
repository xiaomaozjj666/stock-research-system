export const documentsSchemas = {
  /** 带 count 的列表响应（资料库等） */
  DocumentList: {
    type: 'object',
    properties: {
      count: { type: 'number', description: '文档总数' },
      docs: {
        type: 'array',
        description: '文档摘要列表',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            source: { type: 'string' },
            preview: { type: 'string', description: '正文预览片段' },
          },
          required: ['id', 'source', 'preview'],
        },
      },
    },
    required: ['count', 'docs'],
  },

  /**
   * 文档洞察（POST /api/ingest 的 insight 字段）。
   * 字段来源：server/src/services/documentInsights.ts 的 DocumentInsight。
   * confidence/source 是**枚举字符串**而非数字/自由串：LLM 不可用时走词典
   * 兜底（source='heuristic'），两条路径的取值都被 normalize* 收窄在该枚举内。
   */
  DocumentInsight: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '全文摘要（中文）' },
      positives: { type: 'array', items: { type: 'string' }, description: '利好要点' },
      risks: { type: 'array', items: { type: 'string' }, description: '风险要点' },
      catalysts: { type: 'array', items: { type: 'string' }, description: '催化剂要点' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      source: {
        type: 'string',
        enum: ['llm', 'heuristic'],
        description: 'llm=模型抽取；heuristic=词典法兜底（LLM 未配置/失败）',
      },
    },
    required: ['summary', 'positives', 'risks', 'catalysts', 'confidence', 'source'],
  },
};
