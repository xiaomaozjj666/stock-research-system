export const chatSchemas = {
  /* ===== 对话（SSE done 事件与 POST /api/chat 复用同一响应体）===== */

  /**
   * 对话回答（POST /api/chat 200 与 GET /api/chat/stream 的 done 事件共用）。
   * 字段来源：server/src/services/chatAgent.ts 的 ChatAgentResponse
   * （前端 client.ts 的同名 interface 是它的投影，字段一致）。
   * debate/riskDebate/plan/verification 四个是**条件性**字段：只在走到
   * 对应路径（辩论 / 风控关键词 / LLM 规划可用 / use_tools 有工具结果）时
   * 才出现，故一律不进 required；degraded 恒在（规则降级时为 true）。
   */
  ChatAgentResponse: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: '回答正文（中文 Markdown）' },
      toolsUsed: {
        type: 'array',
        items: { type: 'string' },
        description: '本次调用的工具名',
      },
      evidence: {
        type: 'array',
        description: 'RAG 检索命中的证据片段（回答的引用出处）',
        items: { $ref: '#/components/schemas/ChatEvidence' },
      },
      debate: {
        type: 'object',
        description: '多空辩论结果；未走辩论路径时缺省',
        properties: {
          bull: { type: 'string' },
          bear: { type: 'string' },
          synthesis: { type: 'string', description: '仲裁后的综合结论' },
        },
        required: ['bull', 'bear', 'synthesis'],
      },
      riskDebate: {
        type: 'object',
        description: '风控三分视角辩论；debate 路径或风控关键词命中时出现',
        properties: {
          aggressive: { type: 'string' },
          neutral: { type: 'string' },
          conservative: { type: 'string' },
          synthesis: { type: 'string' },
        },
        required: ['aggressive', 'neutral', 'conservative', 'synthesis'],
      },
      plan: {
        type: 'object',
        description: '路由规划结果；仅 LLM 可用时出现（降级为规则路径时缺省）',
        properties: {
          action: { type: 'string', enum: ['direct', 'tools', 'debate'] },
          reason: { type: 'string' },
          skill: { $ref: '#/components/schemas/SkillId' },
        },
        required: ['action', 'reason'],
      },
      verification: {
        type: 'object',
        description: '幻觉防护校验结果；仅 use_tools 路径且有工具结果时出现',
        properties: {
          verified: { type: 'boolean', description: 'true=所有关键断言可验证' },
          unverified: {
            type: 'array',
            items: { type: 'string' },
            description: '无法在工具结果/证据里找到对应的断言',
          },
          calculationErrors: {
            type: 'array',
            description: '能定位到来源但算术重构后不一致的数值错误',
            items: { $ref: '#/components/schemas/CalculationError' },
          },
          warning: { type: 'string', description: '给用户的警示文案（无问题时为空串）' },
        },
        required: ['verified', 'unverified', 'calculationErrors', 'warning'],
      },
      degraded: { type: 'boolean', description: 'true = LLM 未配置，走规则降级' },
      model: { type: 'string', description: '产出本回答的模型 ID；降级时缺省' },
    },
    required: ['answer', 'toolsUsed', 'evidence', 'degraded'],
  },

  /** RAG 证据片段（ChatAgentResponse 的 evidence 元素） */
  ChatEvidence: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      source: { type: 'string', description: '来源标识（如 `doc:<标题>`）' },
      text: { type: 'string', description: '命中的原文片段' },
      stockCode: { type: 'string', description: '证据关联的标的；非标的文档时缺省' },
    },
    required: ['id', 'source', 'text'],
  },

  /**
   * 对话流式事件（GET /api/chat/stream 的单帧 JSON）。
   * 字段来源：server/src/services/chatAgent.ts 的 ChatStreamEvent。
   * 声明成「公共字段 + 按 phase 追加」的扁平对象而不是逐 phase 的 oneOf：
   * 消费方（client.ts 的 ChatStreamEvent、EventSource onmessage）本来就按
   * `phase` 判别后读零散字段，oneOf 会让它们多一层收窄才能用。
   * tools（tool_calling）与 response（done）只在该 phase 出现。
   */
  ChatStreamEvent: {
    type: 'object',
    properties: {
      phase: {
        type: 'string',
        enum: [
          'planning',
          'retrieving',
          'tool_calling',
          'debating',
          'risk_debating',
          'verifying',
          'done',
          'error',
        ],
      },
      message: { type: 'string', description: '该阶段的人话进度说明' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '正在/已调用的工具名；仅 phase=tool_calling 时出现',
      },
      response: {
        $ref: '#/components/schemas/ChatAgentResponse',
        description: '完整回答；仅 phase=done 时出现',
      },
    },
    required: ['phase', 'message'],
  },
};
