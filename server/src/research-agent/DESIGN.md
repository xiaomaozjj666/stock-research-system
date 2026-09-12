# 多步研究 Agent 规划层设计（AlphaSense 式四阶段编排）

> 模块位置：`server/src/research-agent/` · 测试：`__tests__/`（vitest，7 个文件 58 项：13 编排 e2e + planner/retriever/verifier/synthesizer/utils/report 单元测试）
> 覆盖率（逻辑模块，不含纯导出/接口文件）：lines 98.1% / functions 97.5% / branches 92.2%；剩余未覆盖分支为 Schema 枚举门禁之后的第二道代码内回退（防御性冗余，正常输入不可达）。
> 状态：已通过 typecheck（TS 7 strict）、Prettier 与全仓 1553 项测试回归；适配器为接口定义，具体渠道接入由调用方注入。

## 1. 设计目标与原则

将"研究问题 -> 结构化研究报告"的过程拆为四个可观测、可审计、可恢复的阶段，编排器负责多轮迭代与异常兜底。

| 原则 | 落点 |
| --- | --- |
| 证据可审计 | 每条证据强制携带 `SourceRef`（来源）+ `AcquisitionPath`（轮次/查询词/适配器/尝试次数/降级链） |
| 可信度与 LLM 解耦 | `credibility = 来源层级基准分 × 时效衰减`，验证阶段再做强度合成，避免"模型自评循环论证" |
| 引用不可幻觉 | 结论编排对 `keyEvidenceIds` 做存在性校验，编造 ID 一律剔除并回退到验证采信集合 |
| 失败不静默 | 检索失败、证据不足、未决冲突全部进入报告 `limitations`，如实声明而非粉饰 |
| 收敛有保证 | 四重终止条件 + 计划版本化，任何输入下有限轮数内产出结果 |

## 2. 总体架构

```
                ┌────────────────────────────────────────────────────────┐
                │                    ResearchOrchestrator                 │
                │   事件总线(AgentEvent) · 统计(RunStats) · 终止门 · replan │
                └────────────────────────────────────────────────────────┘
      ┌──────────────┬──────────────────┬───────────────────┬───────────────┐
      ▼              ▼                  ▼                   ▼               ▼
┌───────────┐  ┌────────────┐   ┌───────────────┐   ┌─────────────┐  ┌──────────┐
│  Stage 1  │  │  Stage 2   │   │   Stage 3     │   │  Stage 4    │  │ Report   │
│  Planner  │->│ Retriever  │-->│  Verifier     │-->│ Synthesizer │->│ Renderer │
│ 问题拆解   │  │ 按计划取证  │   │ 交叉验证/仲裁  │   │ 结论编排     │  │ Markdown │
└───────────┘  └────────────┘   └───────────────┘   └─────────────┘  └──────────┘
      ▲              │                  │                                  
      │   证据不足 hints ←──────────────┘（自动触发补充检索）                  
      └──── replan（计划版本化修订）←──── 检索失败 / 持续证据不足               
```

### 运行状态机

```
INIT ──> PLANNING ──> RETRIEVING ──> VERIFYING ──┬──(P0 达标/无待办/无进展/达上限)──> SYNTHESIZING ──> DONE
             ▲                                   │
             └────── REPLANNING（round ≥ 2 且有暴露问题）←──┘
```

### 多轮循环伪代码

```
for round in 1..maxRounds:
    if round == 1: plan = createPlan(question, scope)           # 阶段一
    newEvidence   = retriever.collect(plan, round)              # 阶段二（含补充检索）
    verifications = verifySubQuestion(仅本轮发起过检索的子问题)    # 阶段三
    gate（按优先级）:
      p0 全部 sufficient        -> 收敛 all_p0_sufficient
      连续 N 轮无新证据          -> 强制收敛 no_progress（硬停止，防 replan 死循环）
      round == maxRounds        -> 降级收敛 max_rounds
      无待办任务                -> 先尝试 replan 复活（调整关键词/换路径并重置预算），
                                   复活失败才终止 no_pending_work
synthesize -> report -> renderMarkdown                          # 阶段四
```

## 3. 核心数据模型

| 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| `ResearchPlan` | `subQuestions[]` `version` `revisions[]` | 可执行检索计划；修订只增改、版本递增、历史留痕 |
| `SubQuestion` | `priority(P0/P1/P2)` `keywords` `expectedSources` `successCriteria` `supplementRoundsUsed` `supplementHints` | P0 为结论必需，是终止条件的一部分；**P0 不可被 replan 丢弃** |
| `Evidence` | `claim` `quote` `source` `path` `credibility` | 事实性陈述 + 原文摘录 + 来源 + 获取路径，全程可回溯 |
| `Verification` | `consistency` `verdict` `confidence` `conflicts[]` `needsSupplement` `supplementHints[]` | 每轮覆盖写入，最新验证为准 |
| `EvidenceConflict` | `dimension(数值/时间/因果/事实/口径)` `resolution` `resolutionReason` | 冲突结构化留痕，未决冲突进报告局限性 |
| `ResearchReport` | `sections[]` `overallConfidence` `methodology` `conflicts[]` `limitations[]` | 结构化报告，经 `renderReportMarkdown` 渲染 |

来源层级表 `SOURCE_TIER`（冲突仲裁与可信度基准）：

| 层级 | 类型 | 基准分 |
| --- | --- | --- |
| T1 | 监管备案 / 公司官方披露 / 金融数据库 / 学术文献 | 0.95 / 0.92 / 0.88 / 0.85 |
| T2 | 内部资料 / 研究机构报告 / 权威媒体 / 行业数据平台 | 0.75 / 0.72 / 0.70 / 0.68 |
| T3 | 行业博客/聚合 | 0.45 |
| T4 | 社交媒体 UGC / 未知来源 | 0.30 / 0.25 |

时效衰减：`decay = max(0.3, 0.5^(ageDays/730))`，缺失日期不惩罚（由层级兜底）。

## 4. 各阶段设计

### 阶段一：规划（planner.ts）

- LLM 将研究问题拆解为 2~N 个子问题（默认 ≤8），每个子问题带关键词（中英文变体）、预期来源类型、成功判据；
- **确定性护栏**：关键词为空回退为子问题文本（计划永远可执行）；非法枚举值归一化；子问题按 P0 -> P2 排序；完全失败时兜底为单子问题计划；
- `revisePlan`：输入上一轮暴露的问题（检索失败/持续证据不足），LLM 输出 add/adjust/drop 动作；护栏：P0 不可 drop、总数上限、无有效变更则不升版本。

### 阶段二：检索（retriever.ts）

- 逐子问题执行：`主适配器尝试 -> 退避重试(maxRetrievalAttempts，每适配器独立预算) -> 降级备用适配器 -> 全败记 failedTask`；
- **调度防饥饿**：子问题按 `supplementRoundsUsed` 升序执行（同序按计划顺序），`maxRetrievalTasksPerRound` 截断时优先照顾最久未获证据者；
- 查询词构造：round 1 用计划关键词；round 2+ 优先消费验证阶段 `supplementHints`（逐轮轮换），无提示时轮换关键词组合；
- 正文抓取走**实际命中的适配器通道**（而非固定主通道），降级后通道能力保持一致；
- 证据抽取：LLM 从文档中提取 `{claim, quote, isRelevant}`，经 Schema 门禁（maxRetries=1）；
- 去重：URL 级 + claim 级（整轮运行内）；
- 可信度：`SOURCE_TIER[type].baseCredibility × recencyDecay(publishedAt)`；来源类型优先用搜索渠道标注，否则按域名启发式推断（gov/sec -> 监管备案，wind/arxiv -> 数据库/学术等）。

### 阶段三：交叉验证（verifier.ts）

- **确定性前置门槛**（不耗 LLM 调用）：证据 < `minEvidencePerSubQuestion`（默认 2）条、或全部来自同一出版方 -> 直接判 `insufficient`；
- LLM 两两比对：识别数值/时间/因果/事实/口径五维冲突，逐条仲裁（比较来源层级、时效、交叉印证），输出 `a_wins/b_wins/both_partially_true/unresolved`；
- 输出校验：`supportingEvidenceIds` 与 `conflicts.evidenceIds` 必须指向真实证据，非法引用剔除/回退；
- **置信度合成**：`confidence = 0.5 × LLM自评 + 0.5 × 证据强度`；证据强度 = 可信度加权均值 × 交叉印证加成（独立出版方 +10%/家，上限 ×1.2）× 未决冲突惩罚（×0.85）；
- **补充检索触发**：`needsSupplement = insufficient ∨ 存在未决冲突 ∨ confidence < 阈值(0.65)`；提示 = 确定性规则（未使用的预期来源类型、冲突维度建议）+ LLM 建议，写入 `subQuestion.supplementHints` 供下一轮检索消费——**无论 consistency 是否为 insufficient，needsSupplement 都会被编排器消费**（未决冲突同样触发补充检索）；

### 阶段四：结论编排（synthesizer.ts）

- 每个分节对应一个子问题：结论 + 置信度（高 ≥0.75 / 中 ≥0.5 / 低）+ 引用 + 冲突说明；blocked/insufficient 如实标注；
- **引用完整性**：`keyEvidenceIds` 过滤出真实存在且属于该子问题的证据，编造 ID 剔除后回退到验证采信集合；
- 总体置信度：P0 权重 1 / P1 0.5 / P2 0.25 加权平均；
- `limitations` 由确定性规则生成：证据不足 / 受阻 / 检索失败任务 / 未决冲突逐条列出；全部达标时才声明"无重大局限"。

## 5. 异常处理矩阵

| 异常 | 检测点 | 处理策略 |
| --- | --- | --- |
| 检索工具报错/超时 | Retriever | 指数退避重试（`retryBackoffMs × attempt`，每适配器独立预算）-> 降级备用适配器 -> 记 `failedTask`；全过程写入事件流 |
| 来源不可达（fetch 失败） | Retriever | 仅跳过该条命中，不计任务失败；URL 去重避免反复抓取 |
| 证据不足 | Verifier | 确定性门槛（数量/来源独立性）+ LLM 复核双通道；needsSupplement（含未决冲突、低置信度）统一触发补充检索；超 `maxSupplementRoundsPerSubQuestion`（默认 2）判 blocked |
| 来源冲突 | Verifier | 层级仲裁（T1 优先）+ 时效 + 交叉印证；无法仲裁标 unresolved，进报告"数据与口径差异"与局限性，并触发针对性补充检索 |
| LLM 输出不合规 | 各阶段 | `completeJson`：宽松解析（剥围栏）+ Schema 校验 + 错误反馈重试（默认 2 次）；仍失败抛 `LLMOutputError`，run() 发出 `run_error` 事件后向上传播 |
| 计划假设失效 / 任务受阻 | Orchestrator | 终止门处先尝试 replan 复活：add（查重 + 上限）/ adjust（重置补充预算）/ drop（P0 保护），版本递增留痕；复活失败才 `no_pending_work` 终止 |
| 子问题饥饿 | Retriever | 按 `supplementRoundsUsed` 升序调度，预算截断时最久未获证据者优先 |
| 无限循环风险 | Orchestrator | 终止门：P0 达标 / 连续 N 轮无新证据（硬停止）/ 轮次上限 / replan 复活失败，四重保证收敛 |

## 6. 可观测性

- **事件流**：16 种 `AgentEventType`（`plan_created` / `retrieval_fallback` / `verification_completed` / `supplement_triggered` / `run_finished` 等），seq 单调递增，`onEvent` 旁路可直接驱动 UI 进度展示；
- **中间执行状态**：子问题状态机（pending -> retrieving -> sufficient/insufficient/blocked）实时落在 `plan.subQuestions` 上；
- **统计**：`RunStats`（轮次、任务成败数、降级次数、证据数、冲突数、计划版本、终止原因）。

## 7. 接口与扩展点

```ts
const agent = new ResearchOrchestrator({
  llm: myLlmAdapter,            // LLMAdapter: complete(req) => string
  adapters: [primary, backup],  // SearchAdapter: search() + fetch()，首为主通道其余降级
  config: { maxRounds: 3 },     // ResearchConfig 覆盖默认值
  onEvent: (e) => ui.push(e),   // 事件旁路
});
const result = await agent.run('研究问题', { region: '中国', industry: '消费电子' });
result.report            // 结构化报告
result.reportMarkdown    // Markdown 渲染
result.events / result.stats / result.plan / result.evidence / result.verifications
```

接入真实渠道时：实现 `SearchAdapter` 对接搜索/数据库/内部知识库（`sourceType` 标注越准，可信度模型越有效）；实现 `LLMAdapter` 桥接 OpenAI 兼容客户端（如 `server/src/llm/client.ts`）。

## 8. 目录结构

```
server/src/research-agent/
├── types.ts          # 领域模型、来源层级表、默认配置
├── utils.ts          # ID/宽松 JSON 解析/极简 Schema 校验/时效衰减
├── llm.ts            # LLMAdapter + completeJson 结构化输出门禁
├── search.ts         # SearchAdapter 接口
├── planner.ts        # 阶段一：拆解 + replan 修订
├── retriever.ts      # 阶段二：取证 + 降级 + 去重 + 可信度
├── verifier.ts       # 阶段三：一致性比对 + 仲裁 + 补充触发
├── synthesizer.ts    # 阶段四：结论编排 + 引用完整性
├── report.ts         # Markdown 渲染（纯函数）
├── orchestrator.ts   # 编排器：多轮循环/终止门/replan/事件
├── index.ts          # 公共 API
└── __tests__/researchAgent.test.ts   # 9 个端到端用例（FakeLLM/FakeSearch）
```

## 9. 边界与后续演进

- **不内置真实检索/模型渠道**：规划层只依赖接口；渠道实现与鉴权属接入层职责；
- 演进方向：① 事件流接入 WebSocket 推送前端进度面板；② 冲突仲裁引入数值型确定性比对（抽取数字+单位后再比对）；③ `AcquisitionPath` 扩展快照 ID 支持证据内容漂移检测；④ 子问题 DAG 依赖（当前仅 derivedFrom 弱关联）；⑤ 与 `llm/researchMemory.ts` 打通，把历史分析结论作为规划先验。
