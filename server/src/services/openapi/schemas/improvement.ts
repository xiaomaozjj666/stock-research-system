export const improvementSchemas = {
  /**
   * 改进闭环状态（GET /api/improvement/status）。
   * 字段来源：server/src/routes/improvement.ts 的该路由响应字面量。
   * replay 整块刻意暴露「可回放证据够不够」：判据证据是本次改造起才开始
   * 留痕的，刚上线时 available 必然远小于 required——藏起来用户会以为循环
   * 在干活，实际它每次都因证据不足直接返回。scheduler 未启动时为 null
   * （不假装在跑），policyUpdatedAt / lastChange 在判据仍是出厂值时为 null。
   */
  ImprovementStatus: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['factor-verdict-policy'] },
      policy: { $ref: '#/components/schemas/HarnessPolicy' },
      policySource: {
        type: 'string',
        enum: ['default', 'stored'],
        description: 'default=仍是出厂判据；stored=已从落盘文件读回',
      },
      policyUpdatedAt: { type: 'string', nullable: true, description: '判据落盘时间' },
      policyRevision: { type: 'number', description: '判据保留次数（每保留一次改动 +1）' },
      lastChange: { type: 'string', nullable: true, description: '上一次改动的摘要' },
      isFactoryPolicy: { type: 'boolean', description: '判据是否仍是出厂值（从未被改动过）' },
      ledger: {
        type: 'object',
        description: '改进台账汇总（quant/improvementLedger.summarizeImprovements）',
        properties: {
          total: { type: 'number' },
          kept: { type: 'number' },
          reverted: { type: 'number' },
          lastAt: { type: 'string', nullable: true, description: '最近一轮时间' },
          lastKeptAt: {
            type: 'string',
            nullable: true,
            description: '最近一次被保留的改动时间',
          },
          triedCandidates: {
            type: 'number',
            description: '历史试过的去重候选数（负结果复用的抓手）',
          },
        },
        required: ['total', 'kept', 'reverted', 'lastAt', 'lastKeptAt', 'triedCandidates'],
      },
      replay: {
        type: 'object',
        description: '可回放证据盘点：ready=false 时 run 会直接返回原因、不评估候选',
        properties: {
          available: { type: 'number', description: '带判据证据、可参与回放的记录数' },
          required: { type: 'number', description: '跑一轮所需的最小证据数' },
          validationRequired: { type: 'number', description: '验证集所需的最小条数' },
          validationAvailable: { type: 'number', description: '按同一口径切出的验证集条数' },
          ready: { type: 'boolean', description: '现在跑一轮是否会真的评估候选' },
          note: { type: 'string', description: '口径说明（改造前的历史记录不参与回放）' },
        },
        required: [
          'available',
          'required',
          'validationRequired',
          'validationAvailable',
          'ready',
          'note',
        ],
      },
      decision: {
        type: 'object',
        description: '决策门槛：让调用方知道「显著」是按什么标准判的',
        properties: {
          alpha: { type: 'number', description: '显著性阈值（DECISION_ALPHA）' },
          test: { type: 'string', description: '检验方法（人话说明）' },
        },
        required: ['alpha', 'test'],
      },
      scheduler: {
        oneOf: [{ $ref: '#/components/schemas/ImprovementLoopState' }, { type: 'null' }],
        description: '周期调度状态；未启动为 null',
      },
    },
    required: [
      'target',
      'policy',
      'policySource',
      'policyUpdatedAt',
      'policyRevision',
      'lastChange',
      'isFactoryPolicy',
      'ledger',
      'replay',
      'decision',
      'scheduler',
    ],
  },

  /**
   * 改进一轮的结果（POST /api/improvement/run）。
   * 字段来源：routes/improvement.ts 的响应字面量（取自
   * quant/improvementLoop.runImprovementRound 的 ImprovementRoundResult）。
   * record 在 dryRun 时**恒为 null**（演练不落盘）——这是必填可空，
   * 不是可选：调用方据它判断「有记录 ≠ 已生效」。
   */
  ImprovementRunResult: {
    type: 'object',
    properties: {
      changed: { type: 'boolean', description: '判据是否真的被改动并落盘生效' },
      reason: {
        type: 'string',
        description: '结局说明（中文）；changed=false 时即为未改动的原因',
      },
      evaluated: { type: 'number', description: '本轮真正评估过的候选数' },
      dryRun: { type: 'boolean', description: '本次是否为演练（true=只评估不落盘）' },
      record: {
        oneOf: [{ $ref: '#/components/schemas/ImprovementRecord' }, { type: 'null' }],
        description: '写入台账的记录；dryRun=true 或本轮未产生记录时为 null',
      },
      policy: { $ref: '#/components/schemas/HarnessPolicy' },
      policySource: { type: 'string', enum: ['default', 'stored'] },
      policyRevision: { type: 'number' },
    },
    required: [
      'changed',
      'reason',
      'evaluated',
      'dryRun',
      'record',
      'policy',
      'policySource',
      'policyRevision',
    ],
  },

  /**
   * 改进台账条目（POST /api/improvement/run 的 record、
   * GET /api/improvement/history 的 items 元素）。
   * 字段来源：server/src/quant/improvementLedger.ts 的 ImprovementRecord。
   * significance 是配对 McNemar 精确检验的原始计数（b/c 是可复核的最小
   * 充分统计量，p 值由它算出）——只记「精度从多少升到多少」在样本少时
   * 可能来自完全不同的证据强度，故把计数一并落盘。
   */
  ImprovementRecord: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'string' },
      target: { type: 'string', enum: ['factor-verdict-policy'] },
      basis: {
        type: 'object',
        description: '本轮用到多少经验、怎么切的训练/验证集',
        properties: {
          evidenceCount: {
            type: 'number',
            description: '带完整判据证据、可参与回放的记录数',
          },
          trainCount: { type: 'number', description: '训练集条数（较早的一段）' },
          validationCount: { type: 'number', description: '验证集条数（较新的一段）' },
          split: { type: 'string', description: '切分口径的人可读说明' },
        },
        required: ['evidenceCount', 'trainCount', 'validationCount', 'split'],
      },
      before: {
        $ref: '#/components/schemas/HarnessPolicy',
        description: '改动前的判据（回滚基准）',
      },
      after: {
        $ref: '#/components/schemas/HarnessPolicy',
        description: '本轮胜出的候选判据',
      },
      metric: {
        type: 'object',
        description: '决策指标：验证集上的「采信集样本外稳定占比」（使用者口径）',
        properties: {
          name: { type: 'string', enum: ['oos-precision'] },
          before: { type: 'number' },
          after: { type: 'number' },
          delta: { type: 'number' },
          keptBefore: { type: 'number', description: '改前采信条数（精度须连着样本量读）' },
          keptAfter: { type: 'number', description: '改后采信条数' },
        },
        required: ['name', 'before', 'after', 'delta', 'keptBefore', 'keptAfter'],
      },
      significance: {
        type: 'object',
        description: '配对 McNemar 精确检验的原始计数与判定',
        properties: {
          accuracyBefore: { type: 'number', description: '改前判定准确率' },
          accuracyAfter: { type: 'number', description: '改后判定准确率' },
          afterBetter: { type: 'number', description: '改后对、改前错的条数（McNemar b）' },
          beforeBetter: { type: 'number', description: '改前对、改后错的条数（McNemar c）' },
          pValue: { type: 'number', description: '双侧精确 p 值' },
          alpha: { type: 'number', description: '判定阈值' },
          significant: { type: 'boolean', description: '是否达到显著（决策必要条件之一）' },
        },
        required: [
          'accuracyBefore',
          'accuracyAfter',
          'afterBetter',
          'beforeBetter',
          'pValue',
          'alpha',
          'significant',
        ],
      },
      outcome: { type: 'string', enum: ['kept', 'reverted'] },
      verdict: { type: 'string', description: '中文判定说明，可直接展示给用户' },
      tried: {
        type: 'array',
        description: '本轮试过的全部候选（含被否的），用于避免重复试探',
        items: { $ref: '#/components/schemas/TriedCandidate' },
      },
    },
    required: [
      'id',
      'createdAt',
      'target',
      'basis',
      'before',
      'after',
      'metric',
      'significance',
      'outcome',
      'verdict',
      'tried',
    ],
  },

  /**
   * 改进闭环的调度状态（ImprovementStatus.scheduler 与
   * POST /api/improvement/scheduler/start 的 scheduler 字段）。
   * 字段来源：server/src/services/improvementScheduler.ts 的 ImprovementLoopState。
   * lastRunAt / lastReason / lastError 只在跑过轮次（或失败过）后出现。
   */
  ImprovementLoopState: {
    type: 'object',
    properties: {
      running: { type: 'boolean', description: '调度是否在运行' },
      intervalMs: { type: 'number', description: '当前生效的轮询间隔（毫秒）' },
      lastRunAt: { type: 'string', description: '最近一轮结束时间（ISO）；未跑过时缺省' },
      lastReason: { type: 'string', description: '最近一轮的结局说明（中文）' },
      lastChanged: { type: 'boolean', description: '最近一轮是否真的改动了判据' },
      runCount: { type: 'number', description: '已发起的轮次（含失败轮次）' },
      errorCount: { type: 'number', description: '抛异常的轮次数' },
      consecutiveErrors: {
        type: 'number',
        description: '连续失败次数（成功后清零），退避与自动停止的依据',
      },
      stoppedByErrors: {
        type: 'boolean',
        description: '是否因连续失败被自动停止（与用户主动 stop 区分）',
      },
      lastError: { type: 'string', description: '最近一次失败原因' },
    },
    required: [
      'running',
      'intervalMs',
      'lastChanged',
      'runCount',
      'errorCount',
      'consecutiveErrors',
      'stoppedByErrors',
    ],
  },
};
