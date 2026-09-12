# Changelog

股票研究系统（多专家投研 + 量化回测）变更历史。
按日期倒序；commit 为完整短哈希。详细工程决策与踩坑记录见 `ENGINEERING-NOTES.md`。

## 2026-09-12 — 数据面扩容 + 组合回测 T+1 撮合（本批）

- **两融因子族**（`quant/marginProvider.ts`）：东财 datacenter `RPTA_WEB_RZRQ_GGMX` 逐股日度两融序列（字段口径实测：DATE/RZYE/RZJME/RZYEZB，RZYEZB=融资余额占总市值比）。新因子 `mg_balance_chg20`（融资余额 20 日变化率，杠杆资金动量）与 `mg_balance_pct`（占比，杠杆拥挤度）。**PIT + T+1 披露延迟**：交易所两融数据 T 日交易 T+1 盘前披露，t 日因子值强制只用严格早于 t 的行；截面路由 `includeMargin` 开关（默认开），失败降级为缺席不拖垮其余因子。
- **组合回测 T+1 撮合**（`portfolioBacktest.ts`）：t 日收盘决策 → t+1 开盘建仓 → t+1+holdDays 开盘平仓（与下一期建仓同日，实盘节奏）。同时消除同 bar 决策-成交前视与 A 股 T+1 卖出约束两处乐观偏差；基准同口径；成交日缺开盘价（停牌）的持仓剔除出分母。最少数据要求由 2×holdDays 放宽为 holdDays+2。涨跌停仍不建模（按板块阈值误判创业板 20% 涨跌幅的代价更大，如实告知）。
- **机构一致预期快照**（`quant/consensusProvider.ts`）：东财 `RPT_WEB_RESPREDICT`（覆盖机构数/评级分布/逐年度 EPS A-E/目标价区间，实测字段）+ `RPT_MUTUAL_HOLDSTOCKNORTH_STA` 北向季度持股（2024-08 起停止逐日披露）。接入深度分析管线：8 位专家 LLM 语境追加一致预期块；结果页新增「机构一致预期」卡片。**方法论纪律：快照无历史序列，只进语境与展示，严禁当回测因子（把今天的预期投影回历史即前视）**。
- 客户端：截面页两融开关与「两融」类型标签（补齐此前缺失的「形态」标签）、撮合口径文案更新、ConsensusCard 组件。
- 测试 +14（marginProvider 6 / consensusProvider 5 / builder 两融接线 2 / 回测 T+1 撮合口径）。

## 2026-09-12 — 组合构建层：因子组合回测引擎（1f5b377）

- `quant/portfolioBacktest.ts` 纯函数：调仓日按因子值持 top-N 等权、holdDays 换仓、换手×costBps（默认30bps）计提成本，基准为候选宇宙等权（因子中性对照）。输出净值/基准双曲线、总收益/年化/夏普/回撤/胜率/换手。
- 接线：`/factor/expression`、`/expression/batch`、`/factor/cross-section` 增可选 `portfolio` 参数；FactorLab 净值双曲线图 + 组合摘要；截面页因子组合回测表；MCP 同步。
- 诚实口径：收盘价撮合（T+1 未建模）、涨停不建模、候选不足持实际数量、无候选空仓。
- 实测：白酒8只 roe PIT 因子 21 日调仓 top-3，组合 −9.9% vs 宇宙等权 −14.4%（正分离 +4.5pp），平均换手 7%。

## 2026-09-11 — 科学有效性批次（3c69fbe）

- **基本面因子 PIT 化**：6 个基本面/季度因子按季度报告 NOTICE_DATE 门控（`buildPitSnapshots`），消除「今天的年报值投影回全窗口」的公告时点前视；表达式 DSL 标量（roe 等）同步 PIT 化；截面路由不再抓年报。
- **批量假设验证 runner**：`POST /api/quant/factor/expression/batch`（≤50 条共享面板）+ 三路由公共助手（resolveUniverse/fetchPanelInputs/assembleExpressionObservations）+ MCP 工具。
- **台账 FDR 折扣**：`keptExpectedFalse`（Σp，全历史试错维度的期望假阳性）与 `keptOosShare`，FactorLab 展示。
- **幸存者偏差声明**：截面响应 `universe.survivorshipNote`。

## 2026-09-11 — 两个设计取舍落最优解（2a71f36）

- **初筛宇宙**：默认扫全市场（增量 K 线缓存），设上限时按代码排序等步长跨市场采样（替代主表前 N 的沪市主板偏置）；结果披露 universe/coverage/durationMs；路由接客户端断开中止。
- **LLM 集成投票**：文本精确分组 → 字符 bigram 重叠系数 + 贪心加权聚类（自由文本同义改写聚为一组，agreement 恢复语义）；similarityThreshold 可覆盖。

## 2026-09-11 — 新功能审查批次（7ad9b31）

- `pat_limit_up` 信号由常数 1 改为实际涨停幅度（常数信号截面秩全并列，IC 恒 0）。
- preflight 增板块列表源独立探针（push2 与 push2his 是两个域名，K 线通≠列表通）。
- ADF 信息准则参数计数修正、协整半衰期 φ≤−1 归入 Infinity、形态因子中文标签。

## 2026-09-05 — 交互体验批次（ecffb41）

- 跨页发起分析自动切回深度研究页（修复其他页点「开始分析」无反馈）。
- 量化页伪进度（定时伪造阶段 + 随机编造耗时）改真实已耗时计时；深度研究加载屏补耗时。
- 量化三模式常驻挂载（切换不再丢结果）；批量/截面 loading 显耗时；模拟盘挂单提示与审计等级中文化；自选股移除按钮 aria 修正；对比页空占位可点聚焦。

## 2026-09-05 — 量化研究收尾四项（8efe89a）

- IC 衰减视图（[1,5,10,21,63] 网格 + SVG 衰减曲线，组合 alpha 仍只在 21/63 结算）。
- 截面拉宽：东财行业板块 universe 管道（`/universe/boards` + board/topN）与量化页「截面因子」模式。
- 基本面深度：季度财报时间序列（quarterlyFinancials）+ 单季差分/同比/超预期/ROE 斜率（fundamentalDepth）+ PEAD 事件因子接入截面。
- 路由集成测试（composite/batch/cross-section/boards）与新模块单测。

## 2026-09-09 — 新增时间序列计量模块（ADF / GARCH / 协整 / ARIMA / Kalman）

- `server/src/quant/timeseries/`：五个独立模块，纯函数、零第三方依赖、确定性可复现。
  - `adf.ts`：Augmented Dickey-Fuller 单位根检验，Schwert 滞后上限 + AIC/BIC 定阶，三种设定（n/c/ct），p 值为渐近临界值锚点插值（文档注明近似口径）。
  - `garch.ts`：GARCH(1,1) 与 EGARCH(1,1) 高斯 QML，Nelder-Mead 多起点两阶段估计，含条件方差序列、一步前瞻预测与年化波动率；EGARCH 捕捉杠杆效应。
  - `cointegration.ts`：Engle-Granger 两步法（残差 ADF 用 EG 双变量临界值 -3.90/-3.34/-3.04），OU 近似价差半衰期 + z-score 偏离度。
  - `arima.ts`：ARIMA(p,d,0) 条件最小二乘，AIC/BIC 定阶，Ljung-Box 残差白噪声诊断（Wilson-Hilferty 近似）；不含 MA(q>0) 项（日频金融序列 AR 主干为主，见模块说明）。
  - `kalman.ts`：局部水平信号提取 + 时变对冲比率（状态 [α,β] 随机游走），期末 β 与静态 OLS 对照、近期漂移度量。
- 接线：`POST /api/quant/timeseries/analyze`（`test=adf/garch/coint/arima/kalman-beta`，默认拉近 3 年日频，上限 10 年）+ MCP `quant_timeseries_analyze`。
- 测试：新增 34 个确定性合成数据用例（单位根判别、GARCH 参数恢复、协整识别与半衰期、AR 定阶与 Ljung-Box、滤波优于静态回归），全套 1399 通过。
- 已知边界：p 值均为渐近近似（精确推断对照 MacKinnon 表）；MA(q>0) 与多步预测未覆盖。

## 2026-09-09 — 移除飞书 Webhook 推送（回归站内）

- 移除 `services/notify.ts`（飞书 Webhook 推送）及其全部接线：自选股异动预警不再外推、全市场初筛 `run` 端点去掉 `notify` 选项与 `pushed`/`pushReason` 字段、MCP `quant_screener_run` 去掉 `notify` 入参、README/CHANGELOG 对应文案清理。
- 保留项不变：全市场初筛雷达、技术形态事件因子族（`pat_*`）、RPS 分位、http 指数退避加抖动——Sequoia-X 借鉴里「推送到 IM」这一项按用户要求不做。

## 2026-09-09 — Sequoia-X 借鉴：全市场初筛雷达 + 形态事件因子族

### 选股雷达（feat）

- **全市场初筛**（`quant/screener.ts`）：按股票主表扫全市场（默认上限 500 只，`QUANT_SCREENER_MAX` 可调，12 并发 + 磁盘缓存增量），形态触发（海龟突破 / 均线上穿放量 / 涨停，近 5 个交易日触发才算当期）+ RPS（250 日收益严格高于宇宙中 ≥87% 的股票，排名口径防并列退化）初筛，结果落盘 `screenerLatest.json`（env 可重定向）。端点 `POST /api/quant/screener/run`、`GET /api/quant/screener/latest`。
- **技术形态事件族**（`quant/patternEvents.ts`）：形态触发日 = 事件日，走与分红/回购/解禁同一套 `buildEventObservations` → 截面 IC / 分层单调 / OOS 检验——民间"胜率约 50%"从此变成可测量的统计。截面评估在 `includeEvents` 下自动产出 `pat_*` 因子（type: `pattern`，零额外网络调用）。

### 健壮性（fix）

- `fetchJson` 重试退避改为**指数退避 + 随机抖动**（借鉴 Sequoia-X"随机休眠 + 躺平重试"）：避免同时失败的重试齐发，对上游更像独立客户端。

### 明确不做

- baostock / SQLite 换源：TS 生态无官方客户端（需 Python sidecar），且本项目已有 4 层数据回退 + 磁盘缓存 + 陈旧兜底（真实故障演练中 codes 路径照常出结果）。东财彻底封禁或强制注册时再重启该议题。

## 2026-09-09 — 研究基础设施升级：因子实验台账 / 上游预检 / 受限 DSL 因子实验室 / MCP 暴露

### 因子研究闭环（feat）

- **因子实验台账**（`quant/factorLedger.ts`）：因子 × 持有期留痕（来源 / IC / p / 样本外 / 是否采信），批量单次写盘，容量 500 淘汰，`FACTOR_LEDGER_FILE` 可重定向；截面评估自动留痕。端点 `GET/POST /api/quant/factor/experiments`。
- **受限 DSL 因子表达式**（`quant/factorExpression.ts`）：标识符与函数白名单 + 长度/节点数/窗口三重上限，**不执行模型生成的代码**（无沙箱逃逸面）；端点 `POST /api/quant/factor/expression` 走「表达式 → 截面观测 → 既有评估器 → 台账」闭环。
- **因子实验室面板**（前端 `FactorLabPanel`）：表达式假设验证结果（IC / p / OOS / 是否采信）与台账回看直接可在截面因子页使用。
- **运行快照**：截面 / 批量 / 表达式响应携带 `run`（参数 + 数据区间 + 运行时版本），研究报告可复盘。

### 可靠性（fix）

- **上游预检**（`quant/preflight.ts`）：行情源 / LLM / 缓存三项检查（探针 60s 记忆），源不可达且无缓存时截面与批量测算**立刻 503 并说明原因**——此前是逐个股票等满超时才 502。端点 `GET /api/quant/health`。

### Agent 能力（feat）

- **多模型集成投票与校准**（`llm/ensemble.ts`）：并行多模型加权共识 + 一致度；校准权重为 Laplace 平滑命中率（下限 1/3），无标签不更新、不编造准确率。**默认单模型（关闭）**，`LLM_ENSEMBLE_SIZE>1` 或显式传 models 才启用；端点 `POST /api/llm/ensemble`、`GET/POST /api/llm/calibration`。
- **技能路由**（`llm/skillRouter.ts`）：确定性规则表判定细分技能并附回归基准；`AgentPlan` 增加可选 `skill` 标签（不改变执行路径）。
- **研究记忆**（`llm/researchMemory.ts`）：同股票历史结论 + 已验证因子作为研究先验；端点 `GET /api/quant/research-memory/:code`。
- **MCP server**（`mcp/server.ts`，`npm run mcp:serve`）：stdio JSON-RPC 薄适配器，5 个工具暴露给 Cursor / Claude Code / Cline。

### 长任务取消与健壮性（feat/fix，2026-09-06 起）

- 客户端断开**级联取消服务端取数**：`fetchJson` / `mapWithConcurrency` / K 线与事件链路穿透 AbortSignal；K 线拉取区分「外部中止」与「真失败」（中止不再降级模拟数据）。
- 量化页三个长任务（单股研究 / 批量测算 / 截面评估）与对比分析、自选股回测 / 监控、对话回退均可中途取消；修复对话流式取消后 Promise 不 settle 导致 loading 卡死。
- 截面板块下拉过滤旧体系子级（名称后缀 Ⅱ/Ⅲ），默认板块按名称优先级选（白酒/银行）；板块中文名由前端解析，截面路由不再多发一次板块列表请求。

## 2026-08-21 — UI 文案统一口径 + README 全页面截图补全

### 用户可见文案清理（ux）

- 清理用户可见文案的旧表述：meta 描述、浏览器标签、加载屏（"智能专家研判"/"智能深度分析"）、导出报告脚注、SSE 进度（"8 位专家"）、OpenAPI 描述（"多专家仲裁/研判"）——统一为"多专家"中性表述。
- 工程文档同步统一口径：CHANGELOG/ENGINEERING-NOTES 的"模板感诊断"章节；CODE_REVIEW_REPORT 的"模型层"表述。
- 修复模拟盘空账户显示瑕疵（"当前交易日：，可用现金" → currentDate 为空时显示"未设置"）。

### README 界面展示补全（docs）

- 界面展示由 2 页 4 图扩为 **5 页 10 图**：新增对比分析、自选股、模拟盘、研究助手、研究历史 5 页真实浏览器截图（数据态：自选股 2 只、模拟盘已下单并结算、助手含降级应答、历史含记录），截图经视觉审查确认**无任何旧字样残留**。
- 快速开始补安装参数说明（--legacy-peer-deps 与 --dangerously-allow-all-scripts 的用途与安全性说明）。

### 验证

- **923 tests 全绿** / E2E 9/9 / 双端 tsc / lint / format:check / 双端 build 全过；截图测试产生的本地数据（dist/data 自选股/模拟盘）已清理。

## 2026-08-18 — 记忆闭环测试补齐 + 导出报告含历史对比

### 验证与优化（qa / feat）

- **vs_previous 计算逻辑抽为可测试纯函数** `computeVsPrevious`（historyService，路由持久化前调用），补齐此前仅在路由内部函数中、无直接单测的缺口；新增 3 个测试用例（无上次记录 / 评分增量 + 评级变化 / 持平标记）。
- **导出报告补「较上次分析」**：Markdown 导出在头部追加历史对比行（▲ +7 分 / ▼ -18 分 + 评级演化），记忆闭环信息随报告导出；新增 2 个测试用例。
- 确认 look-ahead 过滤覆盖全部回测数据入口（analysisPipeline / quant 路由 / llm tools / watchlistBacktest / quant pipeline 均经 fetchOHLCVData）。

### 验证

- **923 tests 全绿**（+5）/ E2E 9/9 / 双端 tsc / lint / format:check / 双端 build 全过。

## 2026-08-18 — 回测 look-ahead 过滤（TradingAgents 数据防幻觉工程借鉴）

### K 线数据截止校验（fix）

- `fetchOHLCVData` 返回前对数据做 **[startDate, endDate] 二次过滤**（新增纯函数 `filterOHLCVByRange`）：剔除 endDate 之后的未来行（回测混入未来数据会让 Sharpe/回撤失真）与 startDate 之前的越界行；API 路径、缓存命中路径均生效，越界剔除记录 warning 日志。
- 对应 TradingAgents `stockstats_utils` 的 look-ahead 过滤（其 v0.3.1 修复重点）；与既有 T+1 信号延迟（成交层防前视）构成双层防线。
- 新增 5 个测试用例：范围内保留 / 剔除未来行 / 剔除越界行 / 日期格式兼容 / 空输入。

### 验证

- **918 tests 全绿**（+5）/ E2E 9/9 / 双端 tsc / lint / format:check / 双端 build 全过。

## 2026-08-18 — 界面去模板感 + 记忆反思闭环 + 图文 README（TradingAgents 借鉴）

### 全页面模板感诊断与优化（ux）

- 7 页真实浏览器截图 + 视觉审查诊断（深度研究/量化/对比/自选股/模拟盘/研究助手/历史），修复：
  - **对比页**：重复"待添加"占位符 → 序号化「＋ 添加第 N 只」；主按钮按状态驱动文案（不足 2 只提示/满 2 只可发起）；副标题改引导式
  - **量化页**：空态文案补流程说明 + 能力提示；checkbox 改「启用最新消息情绪叠加」；成本模型下拉文案通俗化
  - **自选股**：说明文案精简；空态改「还没有关注的股票」引导式（标题/提示双层）
  - **模拟盘**：顶部说明改用户导向（真实 A 股规则 + 无实盘资金提示）
  - **研究助手**：副标题改场景示例式；输入框 placeholder 语境化
  - **历史页**：说明文案修正（明确指向深度研究页恢复报告）
- E2E 自选股空态断言同步更新。

### 记忆反思闭环（借鉴 TradingAgents）（feat）

- 分析完成保存历史前读取该股票上一次分析，把**「较上次分析」**（vs_previous：评分变化 + 评级变化 + 上次日期）附加到结果；报告头部显示 ▲ 红（上升）/ ▼ 绿（下降）/ ＝ 标签与「评级 A → B」演化——让每次分析对照历史观点，观点演化可见。
- `historyService.getPreviousAnalysis`（保存前调用 = 上一次分析语义）+ 路由持久化接入 + 双端类型 + 前端 `ReportHeader` 展示。
- 新增 6 个测试用例（getPreviousAnalysis 无记录/摘要/记忆闭环语义；ReportHeader 上升/下降/持平/不渲染）。

### 图文并茂 README（docs）

- README 重构：核心特性补风险归因/成本模型/T+1/记忆闭环；新增「量化内核」章节（六项设计 × 借鉴来源对照表）；补历史 API、CI 门禁说明；测试数字校准至 913。

### 验证

- **913 tests 全绿** / E2E 9/9 / 双端 tsc / lint / format:check / 双端 build 全过。

## 2026-08-18 — 量化层升级：Analyzer 模式 + 风险归因 + 可插拔成本模型（借鉴 backtrader / gs-quant / qlib）

### T+1 信号延迟成交（借鉴 backtrader Market 单 / qlib shift=1）（fix）

- 回测引擎成交改为 **T+1 语义**：信号在 T 日收盘后生成 → **T+1 日开盘价成交**（`bar.open × (1±滑点)`）——收盘价仅用于决策，成交价取自次一 bar 开盘，消除「收盘决策 + 同收盘价即时成交」这一现实中不可实现的口径；数据末 bar 生成的信号与真实世界一致地丢弃。
- 新增 3 个测试用例：买入/卖出均延迟一 bar 且以开盘价成交、末 bar 信号不成交（构造「仅末 bar 金叉」行情验证）。

### 每日截面 IC 序列（借鉴 qlib calc_ic / ICIR 口径）（feat）

- `validateFactorModel` 支持按日分组计算**每日截面 Spearman IC 序列**（`FactorPanelRow.date`，要求每行都有）：避免把不同日期的样本混入同一个秩相关（跨期秩混合会扭曲 IC）；多截面路径自动按 **ICIR（= mean/std，qlib 口径）** 加权。
- 无 `date` 时保持向后兼容（全样本单 IC）；报告 `perFactor` 新增 `icir` 字段（多截面时）。
- 新增 4 个测试用例：每日 IC 序列聚合、ICIR 计算与单截面缺省、跨期混合 vs 按日口径差异、单样本日跳过。

### 绩效分析器（Analyzer 模式，借鉴 backtrader）（refactor）

- 新增 `server/src/quant/analyzers.ts`：绩效统计从回测引擎内联硬编码重构为**可插拔纯函数分析器集合**（`PerformanceAnalyzer {name, compute(ctx)}` + `AnalyzerContext {equityCurve, trades}`），`computePerformance()` 支持自定义分析器注入——与 backtrader Analyzer 三件套（生命周期钩子 / 结果容器 / 注册实例化）同构的轻量版。
- 默认集合：总收益 / 年化收益 / Sharpe / Sortino / 最大回撤 / 胜率 / 盈亏比 / 交易次数；回测引擎输出与旧逻辑逐字等价（行为不变，含手续费与无风险利率常量 `TRANSACTION_COST_RATE=0.001` / `RISK_FREE_RATE=0.025`）。
- 新增 5 个测试用例：引擎与分析器输出一致性、默认集合字段、自定义 Calmar 分析器、空曲线安全、总收益归一化。

### 风险归因（RiskModel 轻量版，借鉴 gs-quant）（feat）

- 新增 `server/src/quant/riskAttribution.ts`：风格因子暴露（规模/价值/动量/盈利/杠杆，z 分数标准化）+ 系统/特异风险分解（经验因子波动率常量，无协方差矩阵的轻量 RiskModel）——对应 gs-quant `getExposures / getSpecificRisk / getTotalRisk` 的最小可用子集。
- 分析管线（`analysisPipeline`）为每只股票附加 `riskAttribution` 字段（因子暴露 + 分解：系统波动 / 特异波动 / 总波动 / 因子解释占比），前端 `RiskSection` 新增"风险归因（风格因子暴露）"区：5 因子条形图（红=正向暴露、绿=负向暴露）+ 分解文本。
- 新增 9 个测试用例（缺失输入、正/负向暴露、截面标准化、pe≤0 容错、零暴露全特异、高暴露系统占比、负特异容错、全链路）+ 前端 RiskSection 归因渲染用例；E2E 真实浏览器验证 600519 分析渲染归因区（0 pageerror）。

### 可插拔交易成本模型（借鉴 backtrader CommInfo / qlib Exchange / gs-quant backtests）（feat）

- 新增 `server/src/quant/costModel.ts`：`CostModel {openRate, closeRate, minCost, slippage, impactCost?}` 接口 + 纯函数 `buyCost/sellProceeds`（费用 = max(成交额×费率, 最低费用)）+ `marketImpactCost`（**二次方市场冲击**：`impactCost × (成交额/当日成交量)²`，qlib Exchange 公式）。
- **A 股真实费率模型** `A_SHARE_COST_MODEL`：佣金万 2.5 双边 + **印花税万 5 仅卖出单边**（2023-08-28 起）+ 单笔最低佣金 5 元 + 市场冲击系数 0.1（qlib 推荐值）——对应 backtrader CommInfoBase 方向性佣金与 qlib Exchange 不对称费率/冲击成本设计。
- 引擎 `runBacktest(data, strategy, costModel?)`：未传时按 commission/slippage 构造对称模型（**历史行为逐字等价**）；`strategy.costModel='a_share'` 启用 A 股真实费率；也可注入任意自定义模型。
- 前端量化页成本模型下拉：「自定义佣金（默认万三对称）」/「A 股真实费率（佣金万2.5 + 印花税卖出万5 + 最低5元）」。
- 新增 17 个测试用例（costModel 纯函数 11 + 引擎路径 6：历史行为等价、a_share 费率、印花税单边致收益更低、零成本模型、minCost 兜底、市场冲击经引擎生效）。

### 验证

- **889 tests 全绿**（+38 新增）/ E2E 9/9 / 双端 tsc / lint / format:check / 双端 build 全过；风险归因经真实浏览器 E2E 验证（600519，0 pageerror）。

## 2026-08-14 — 图表修复、研究助手主题统一、测试全量审查、CI 修复

### 报告导出 / Toast / 异动预警（feat）

- **报告 Markdown 导出**：报告头"导出报告"按钮，前端生成结构化 Markdown（核心摘要/五维评分/专家观点/争议/风险/情景/策略/跟踪指标）并下载
- **全局 Toast**：ToastProvider + useToast（success/info/error，2.5s 自动消失），接入导出/监控反馈
- **自选股异动预警**：复用后端 `POST /api/watchlist/monitor` + detectAlerts，"监控异动"按钮展示强烈看多/看空/高影响预警列表

### 体验端系统性优化（ux）

- 回到顶部浮动按钮（滚动 >600px 出现，平滑回顶）；document.title 随分析/历史更新（"贵州茅台(600519) 研究报告 - 投研系统"）
- 懒加载页切换轻量占位（全屏 LoadingScreen 只保留给分析中）；报告打印样式（@media print 隐藏交互元素、卡片不拆页）
- 研究助手：输入框单行垂直居中 + 自动增高；快捷提问与全站标签风格统一；发送按钮状态可辨
- 左侧导航高亮改视口中心线判定 + 浮点容差 + 到底兜底（矮区块不再跳过/卡滞）
- 后续跟踪指标闭环：关注置顶 + 自定义指标 + localStorage 按股票持久化

### 自主全面测试与修复（qa）

- 四轮真实浏览器自测（桌面/移动端、完整分析、图表、历史、量化回测、对比分析、研究助手、SPA 深链接、console 错误全程捕获）发现并修复：
  - **移动端 navbar 负 margin 横向溢出**（body 出现横向滚动条）→ 媒体查询覆盖
  - **e2e webServer 缺 HISTORY_FILE 重定向**（E2E 分析会写真实历史数据）→ 补隔离
  - **历史删除无确认**（误删风险）→ 二次确认交互（3 秒自动复位），测试同步更新
- 验证：826 tests / E2E 9/9（smoke）+ 自测 2+3+2 用例全过 / 首屏无 echarts 采样确认

### 性能与体验优化（perf / ux）

- **前端首屏 -65%**（~295KB → ~107KB gzip）：`ChartsSection` 与 `WatchlistPage` 懒加载，echarts 运行时（195.57KB gzip）彻底移出首屏按需加载；图表区轻量 fallback。
- **EChart 重绘防抖**：option 内容级比较（JSON），滚动等无关重渲染不再反复全量重绘图表。
- **后端管线并行化**：数据获取与新闻情绪并行（省一个网络往返）；8 专家本就并行。
- **移动端 tab 横向滚动**（7 tab 不溢出）；回看历史时显示"历史快照"提示条；构建 dist 自动清理。

### 研究历史记录功能（feat）

- 每次股票分析完成自动保存（同代码去重，容量上限 100 条），前端新增「历史」tab：列表（股票/评级/评分/时间）、一键恢复完整研究报告回看、删除。
- 后端 `services/historyService.ts` + `GET/DELETE /api/history` 路由（分析完成自动入库）+ OpenAPI 契约；新增 16 个测试用例。

### 图表渲染崩溃修复（fix）

- 根因：`echarts-for-react@3.0.7` 被 npm 标记 "published in error"（已废弃），其 ESM 产物非规范（extensionless 导入），生产构建（Rolldown）下 default 互操作得到模块对象，React 报 `Element type is invalid: got object`（图表区渲染崩溃；dev 正常、生产必炸）。
- 自研轻量封装 `client/src/components/EChart.tsx`（init / setOption / ResizeObserver 自适应 / 卸载 dispose）替换 `ChartsSection` 与 `NewsPostureHeatBar` 中的用法；**删除 echarts-for-react 依赖**（产物 -7.4KB gzip）。新增 EChart 组件测试 4 用例。

### 研究助手主题与交互（feat）

- ChatPanel / ResearchEnhance 样式整体重写：历史遗留的**亮色硬编码**（白底证据卡、浅灰气泡、亮色 badge）统一接入深色 CSS 变量体系（`--bg-card`/`--accent`/语义色 dim），A 股红涨绿跌语义保留。
- 交互：Enter 发送 / Shift+Enter 换行；空输入禁用发送；"清空"对话按钮（服务端记忆保留）；消息 hover 复制按钮（clipboard + 已复制反馈）。ChatPanel 测试增至 6 用例。

### 全量测试质量审查与修复（test）

- 74 个测试文件 / 793 用例四路并行审查（含源码交叉验证），修复 2 Critical + 6 High + 20+ Medium。
- 🔴：`agentEval` fixture 字段错误（测错东西恒通过）、`newsSignal` 直连真实东财端点。
- 🟠：experts 年份定时炸弹（2029 必破）、OPENAI_API_KEY 残留真实 LLM 网络、stockMaster/dataProvider 测试写删生产缓存、factorOptimizer 未 seed 随机、analysisPipeline mock 泄漏。
- 顺带修源码缺陷：熔断 503 补 `Retry-After` 头、`concurrency` NaN limit 崩溃、`run_backtest` 补 6 位代码校验、`chatMemory`/`stockMaster`/`dataProvider` 三处硬编码数据路径支持 env 重定向。
- 基础设施：新增 `server/src/test/setup.ts`（全局数据文件隔离 + 日志静音）；测试时长 36.6s → 8.6s。

### CI 与依赖（ci / chore）

- **修复 CI E2E 失败**：Playwright webServer 作为插件在 globalSetup 之前启动，`global-setup.ts` 的自动构建从未生效 → e2e job 显式 `npm run build`。
- 合并 4 个 dependabot PR：`actions/checkout`、`setup-node`、`upload-artifact` v4 → v7（消除 Node 20 弃用警告）；npm devDependencies 补丁升级（jest-dom 7.0.1、tsx 4.23.12）。

验证：**807 tests 全绿** / E2E 9/9 / 双端 tsc / lint / format:check / CI 双 job 全绿。

## 2026-08-13 — OpenAPI 契约、Prometheus 指标、E2E 与 CI 落地

- **OpenAPI 3.1 契约**：`services/openapi.ts` + `GET /api/openapi.json`（31 个端点，含请求体 schema / 错误响应 / 503 熔断说明）；`openapi.routes.test.ts` 结构性校验。
- **Prometheus 指标**：`services/metrics.ts` + `GET /api/metrics`（零依赖）：`http_requests_total` / `http_request_duration_ms` / `process_*` / `llm_calls/tokens/cost_total` / `circuit_breaker_tripped`；路由标签归一化防基数爆炸。
- **熔断中间件** `circuitBreakerGuard` 挂分析类路由（503 + Retry-After）。
- **E2E 冒烟**（Playwright，`e2e/smoke.spec.ts` 9 用例）：真实 Chromium + 生产模式真实服务；数据文件重定向 `e2e/.tmp`；globalSetup 按需构建两端。
- **GitHub CI**（`ci.yml`）：quality job（lint / format / tsc / build / 793 tests / 覆盖率门禁 + 产物上传）+ e2e job；Dependabot 自动升级。
- **dataProvider 覆盖率 25% → 98%**：新增 `dataProvider.extra.test.ts`（10 用例）；覆盖率阈值收紧（lines 70 / statements 68 / functions 62 / branches 55）。
- **审计日志竞态修复**：`AUDIT_LOG_FILE` env 重定向，消除并行 worker 写同一文件的 flaky。
- SPA 生产同源托管 + CORS 同源放行（`index.ts`）。

## 2026-08-09 — 收尾完善

- GitHub CI / README / 工程笔记更新；模拟盘、审计、港美股路由测试；前端模拟盘页面。
- 格式门禁归零（142 个存量差异清零，`.gitattributes` 防 CRLF 复发）。

## 2026-08-08 — 功能与工程大版本

- **模拟盘研究闭环**（`quant/paperTrading.ts`）：自建 A 股撮合引擎（T+1 / 涨跌停拒单 / 整手 / 佣金印花税 / 日终撮合 / 绩效统计），路由 `GET /api/paper/*`；JSON 原子持久化。
- **港美股数据源**：换东财 RPT 网关（`quant/intlDataProvider.ts`，免费无 token），不再恒降级。
- **受控评估**：DSR（Bailey-López de Prado）/ CSCV-PBO / Walk-Forward 过拟合判定修复与测试。
- **结构化日志**：自研 JSON logger（零依赖），40+ 处替换；`LOG_LEVEL` 控制。
- **Agent 增强集**：流式 Chat Agent（planner / 幻觉防护 / 风控辩论）、LLM 工具 / 知识图谱 / MCP、量化 walk-forward / 回测评估 / 板块轮动、合规审计（8 号文）与链路追踪（telemetry）、3 个新专家。
- **dataService 内存 LRU** 缓存；quant 纳入覆盖率统计；stockMaster 覆盖率 52% → 94%。
- 依赖升级（vite/eslint/tsx）；`nanoid` 高危传递漏洞修复；vitest 配置改 `.mts`。

## 2026-08-05 / 08-03 — 中期优化

- 依赖升级（tsx / express-rate-limit / globals / user-event）。
- Agent 增强 + 前端对接 + **零依赖一键启动**（`启动系统.bat`）。
- 全栈重构：LLM RAG 工具、量化因子/walk-forward、覆盖率清理、UI 组件（`4cd525a`）；精简 JSDoc。

## 2026-08-02 — 前端大改版（8b9c7f9）

- SSE 流式分析进度 + 退避重连；自选股 / 对比视图；键盘导航股票选择器；按需引入 echarts；路由级懒加载 + manualChunks 拆分。
- API 客户端重构（统一错误归一化 / 流式接口）。

## 2026-07-29 — 初始版本（71fa430）

- 股票研究系统骨架：多专家分析（基本面 / 估值 / 行业 / 风险 / 资金流等）+ 量化回测内核（ma_cross 等策略）。
