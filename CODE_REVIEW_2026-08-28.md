# 全量审查与优化报告（2026-08-28）

> 范围：server 应用层 / quant 量化引擎 / llm 层 / client 前端 / 测试与配置（229 个 TS 源文件）
> 基线：lint 通过、单测 923 全绿；四域并行深度审查后修复，回归后 lint / build 通过、单测 924 全绿。

## 一、修复清单（按严重等级）

### 🔴 High（全部修复）

| #   | 位置                            | 问题                                                                                                  | 修复                                                                   |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| H1  | `services/telemetry.ts`         | 每个 HTTP 请求的 root span 永久残留内存 store，长跑必然 OOM                                           | store 加 `maxTraces`（默认 1000）FIFO 容量上限                         |
| H2  | `pages/quant/QuantPage.tsx:191` | `useCallback([])` 空依赖闭包捕获首帧值：粘贴新闻与情绪叠加开关 100% 静默失效                          | 依赖补 `[newsText, useNews]`                                           |
| H3  | `client/src/App.tsx`            | 历史快照切换不重挂载，FollowUpSection 把 A 股票的持久化数据串写进 B 股票的 localStorage（不可逆污染） | report 根节点加 `key={stock_code}`                                     |
| H4  | `llm/client.ts`                 | 四个 LLM API 对 429/5xx 一律立即抛错且被静默降级掩盖                                                  | 统一走 `fetchWithRetry`：指数退避 + 抖动 + Retry-After，仅重试幂等请求 |
| H5  | `llm/mcpClient.ts`              | SSE 初始 fetch 无连接超时：防火墙 DROP 时整条分析管线永久挂死                                         | `AbortSignal.any` + 10s 连接超时；超时后 abort 防僵尸连接              |

### 🟠 Medium（修复 18 项）

**server 应用层**

- `routes/chat.ts` + `services/chatMemory.ts`：sessionId 直作对象键，`__proto__` 触发原型链异常（成功对话变 500）→ 白名单校验；session 数上限 200 防文件刷爆。
- `routes/analysis.ts`、`routes/chat.ts`：SSE 断开不感知，客户端关页面后 1-3 分钟管线白跑 → 新增 `utils/sse.ts`，emit 抛错实现阶段边界协作式取消；SSE 错误原先吞进响应流，补 `logger.error`。
- `services/dataService.ts`：`getData` 无 single-flight（/api/compare 天然并发重复打外部 API）→ in-flight Promise 去重；`getSupportedStocks` 每请求全量读盘 2000 文件 → 60s TTL 缓存。
- `routes/quant.ts`：`/api/backtest/evaluate` 新闻抓取无超时（最坏挂 40s+ 占满限流窗口）→ 与 analyze 一致包 `withTimeout(5s)`。
- `services/analysisPipeline.ts`：MCP `listAllTools` 抛错时 `disconnectAll` 被跳过，SSE 连接悬挂 → 移入 `finally`。
- `routes/market.ts`：`/api/stocks` 错误完全静默 → 补 `logger.warn`。
- `routes/health.ts`：fetch 抛错时 5s 定时器晚释放 → `clearTimeout` 移入 `finally`。

**llm 层**

- `chatWithTools`：响应体读取在 clearTimeout 之后，body stall 永久挂起 → `withTimeout(json, 15s)`；5 轮耗尽把 4000 字符工具原始 JSON 当回答返回 → 取最后 assistant 消息或明确降级文案。
- `embed()`：唯一无超时的 API 函数 → 30s 超时 + 重试。
- `chatStream`：超时是"总时长"，会掐断活跃长流 → 改为每 chunk 重置的空闲超时；abort 携带 reason。
- MCP stdio：子进程死后向已关管道写入触发 EPIPE uncaughtException（可崩进程）→ 挂 stdin error 处理器；exit 不论退出码都 failAll 并置未连接。
- SSE 事件边界只认 `\n\n`，严格 CRLF 服务端永不抵达 → 正则支持 CRLF/LF/CR。
- `rag.ts`：每次查询对全量语料重新嵌入（成本线性膨胀、大语料撞批量上限）→ 向量按 id+指纹缓存 + 64 条/批分批；`ingestedDocs` 无上限 → FIFO 1000。
- `prompts.ts`：`clampInt(null,…,50)` 得 0 而非 fallback → null/undefined/'' 先走 fallback。
- `connectAll` 与 `unregister` 并发时把已断连实例填回工具索引 → 回填前校验注册表。

**quant 引擎**

- `factorAnalytics.ts:299`：对"同一行内不同因子"做 z 标准化（把 PE 和动量互相比），directionalAccuracy/RMSE 完全失真，而 factorOptimizer 恰拿它当权重证据 → 改为每因子跨面板行截面标准化。
- `agents/dataEngineer.ts`：缺失交易日检查不排法定节假日，2 年回测 ~26 个节假日扣 52 分把真实数据打崩（模拟数据反而满分）→ 按跨度每月 1 天容差、仅罚超出部分。
- `costModel.ts`：市场冲击公式 `(成交额/成交量)²` 混用元/手量纲，低流动性个股凭空算出 10% 本金的冲击 → 改为无量纲参与率² × 成交额（有上界）。
- `backtestEngine.ts`：停牌 bar（volume=0）照常按 open 成交 → 停牌不撮合、信号顺延；显式传 `commission: 0` 被 `||` 吞成默认万三 → 改 `??`。
- `factorAnalytics.ts`：全部保留因子 effective=0 时权重全 0，Σ=1 契约破裂 → 显式等权回退；`fwdStd` O(n²) 内层重算均值、每日截面 `filter` O(D×N) → 单遍 Map 分组。
- `walkForward.ts`：双负 Sharpe 得正 OOS 比率误判 stable → 任一侧 ≤0 记 0。
- `agents/strategyOptimizer.ts`：VaR 对正收益分位取绝对值，把盈利报成 VaR → 仅负分位记值。
- `dataProvider.ts`：`parseInt('AAPL')` NaN 使模拟曲线全 NaN → 确定性哈希种子；`getDay()` 本地时区与 `toISOString()` UTC 标签错位 → 统一 UTC。
- `dataProvider.ts`：缓存文件名直接拼未校验的 stockCode，`../../` 可路径穿越 → token 白名单清洗。
- `pipeline.ts`：`runQuantPipeline` 不检查 `isSimulated`（路由层检查了，这条独立路径没查）→ 模拟数据显式声明结论无效。
- `dataProvider`：lmt 按请求跨度估算（2026-08-29 补齐），长区间不再静默截断。
- **newsOverlay 严格时序（2026-08-29 补齐）**：新增 `items` 分段情绪时间线——引擎对每个 bar 只使用发布日 ≤ bar 的新闻、按半衰期 5.8 天指数衰减加权聚合极性（导出纯函数 `newsOverlayPostureAt`），全程无未来信息，彻底消除前视偏差；`NewsSignal.timeline` 由 `aggregateNewsSentiment` 自动产出并全链路（analyze/evaluate/策略列表/chat 工具）透传；无 items 时退化为 since 常数旧口径。配套 8 个测试（衰减/多空混合/未来新闻不影响历史权益曲线）。
- `newsSignal.ts`：BULLISH_WORDS `'利好'` 重复，命中计 2 次扭曲 polarity → 去重。
- `paperTrading.ts`：印花税 0.1% 是 2023-08-28 前旧税率，与 costModel 万 5 自相矛盾 → 统一 0.0005。

**client 前端**

- `api/client.ts`：`analyzeStockStream.cancel()` 不 settle done，`await done` 永久挂起 → 以新导出的 `AnalysisCancelledError` 拒绝；App 加代际号防旧调用收尾清掉新分析状态。
- `chatWithAgentStream` 不传 sessionId：流式主路径会话记忆失效 → 参数透传 URL。
- `components/FinancialSection.tsx`：中间年份缺数据渲染 "NaN%" → `Number.isFinite` 守卫。
- `components/StockSearchInput.tsx`：Enter 同步路径多命中自动选第一个，与设计注释矛盾（用于资金类操作）→ 与异步路径对齐为仅唯一命中直加。
- `hooks/useCountUp.ts`：rAF 无 cleanup，target 变化时双动画并发 setValue 闪烁 → `cancelAnimationFrame`。
- LLM 输出契约信任：ChatPanel/ExpertOpinions/reportExport 多处 `xxx.length` 无空值防御，缺字段即区块报废 → 统一 `(x ?? []).length`。

### 🟡 Low（修复 8 项）

- `utils/sse.ts`（新增）：SSE 头设置/断开感知/安全写统一封装，消除两路由重复。
- `llm/client.ts`：响应缺 `choices` 时补 warn 日志；外部 signal 联动改用 `AbortSignal.any`（消除监听器累积）。
- `mcpClient.ts`：endpoint 等待超时后 abort SSE 并清理定时器（原泄漏僵尸连接 + 30s timer）。
- `rag.ts`：注入文档 FIFO 上限（见上）。
- 回测/模拟盘税率口径对齐（见上）。

## 二、未修复（记录在案）

| 项                                                                        | 原因                                       |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| `trust proxy` 未设置（反代后限流失效）                                    | 部署拓扑相关，需按实际环境显式配置并文档化 |
| audit.log 无轮转、明文存 prompt/response                                  | 需要轮转策略与脱敏规范，属独立工程项       |
| M 级性能项：report 区块 React.memo、EChart stringify 优化、审计日志结构化 | 收益需基准数据支撑，避免本轮引入回归       |
| eslint 对 TS 实际空转（typescript-eslint 未兼容 TS7）                     | 已有说明注释，待 TS7 兼容后接入            |

## 三、测试与验证

- 修复过程更新了 3 个锁定旧行为的测试（costModel/backtestEngine 冲击语义、paperTrading 印花税率、analyzeStream cancel 语义、App mock 补导出），并为新语义补断言（停牌顺延、VaR 非负、cancel 拒绝）。
- 最终回归：`eslint` 0 告警；`vitest` **90 文件 / 924 用例全绿**；`npm run build`（server + client）通过。

_报告结束_

---

## 附：后续演进记录（2026-08-29 ~ 09-03）

审查报告完成后，项目继续演进（部分由作者实施、部分由审查侧跟进），收尾时状态：

### 健壮性与自我校准

- 单专家降级（allSettled + 有限重试 + 结构校验）、分析断点续跑（data/experts/arbitration
  三阶段落盘 + TTL 6h）、决策-结果闭环（评级台账 20 天回填 + 沪深300超额 + 命中率注入仲裁）
- 审查跟进修复：全新分析先清残留断点（杜绝跨代合并错配）；chatMemory 原型链键防护补全
  （`__proto__`/`toString` 等继承键曾致 chat 500）；评级回填定时器（test 守卫 + unref）

### 因子体系扩展

- 量价因子库 11 因子（波动/反转/动量/流动性/Beta/彩票类）+ 单股时序 IC 评估 +
  多因子加权组合 alpha（|t|-加权 effective IC）+ 接入回测作为可交易叠加层
  （与新闻姿态取 min 的 AND 语义）+ 市场基准扩展美股/港股 + 批量测算端点与页面

### 统计严谨性升级（2026-09-03，审查侧实施）

- **重叠修正**：period 日远期收益相邻重叠，iid 假设把 t 高估约 √period 倍（21 日约 4.6 倍）。
  单股 IC 按有效样本量 nEff = max(3, ceil(n/period)) 计算；每日截面 IC 接 Newey-West HAC
  （Bartlett 核，maxLag = period − 1）
- **Holm-Bonferroni 多重检验校正**：每持有期全部因子构成检验族，significant 判据切换到
  校正后 pAdj，家族错误率严格 ≤ 5%——组合 alpha 只纳入真显著因子
- **相关性去重**：|ρ| > 0.7 的回声因子不重复计权（显著因子按 |t| 贪心入选），
  "多因子共识"不再被单因子回声冒充

### 量化研究收尾四项（2026-09-05，审查侧实施）

1. **IC 衰减视图**：单股分析按 [1,5,10,21,63] 交易日网格输出逐持有期预测力，
   前端新增 SVG 衰减曲线（显著因子着色 / 不显著灰线）——「信号衰减到哪一档」
   直接给出自然调仓频率；组合 alpha 仍只在 21/63 结算，语义不变
2. **截面拉宽（行业 universe）**：新增东方财富 clist 板块管道（行业板块列表 +
   成分股按总市值前 N，TTL 内存缓存）；`/factor/cross-section` 支持 board+topN
   （上限 30 只），前端量化页新增「截面因子」模式（板块下拉 / 手输代码）
3. **基本面深度（季度时间序列 + 事件因子）**：F10 全报告期抓取（quarterlyFinancials，
   含公告日）；fundamentalDepth 纯模块做累计→单季差分、单季同比、业绩超预期
   （相对前 4 季均值）、ROE 逐季斜率；截面新增 cs_np_yoy_q / cs_roe_slope 快照因子
   与 ev_earnings_surprise（PEAD 事件窗口）因子族，路由逐持有期附采信判定
4. **路由集成测试**：composite / batch / cross-section / universe boards 全链路
   supertest 覆盖（参数校验 / 状态码语义 / 降级披露 / 三族因子齐备）

实机验证（dev + 真实东财数据）：白酒Ⅲ 6 只截面评估 15 因子全链路出表
（Amihud 在银行板块、1月反转在白酒板块给出「有效」判定）；600519 单股报告
IC 衰减曲线渲染正常；板块代码随数据源体系变化，前端改为加载后自动选中。

### 交互体验批次（2026-09-05 下午，审查侧实施）

全应用实机走查后修复 8 项交互问题：

1. **跨页发起分析无反馈（bug）**：顶部搜索在任意页可用，但加载屏只渲染在深度研究页——
   在模拟盘/量化页点「开始分析」看不到任何反应。现在发起分析自动切回深度研究页
2. **量化页伪进度**：原为 800ms 定时伪造阶段推进 + Math.random 编造各阶段耗时。
   改为真实已耗时计时 + 诚实文案（单请求内连续完成，无法逐阶段上报），完成时
   toast 提示真实总耗时
3. **深度研究加载屏加已耗时**：阶段进度本就来自 SSE 真实事件，补耗时计时让
   「1-3 分钟」可校准（超 60 秒显示「X 分 Y 秒」）
4. **量化三模式切换丢结果**：批量测算/截面评估跑数十秒的结果，切去别的模式看一眼
   即被卸载。改为三模式常驻挂载（hidden 隐藏），截面面板延迟到首次激活才拉板块
5. **批量测算/截面评估 loading 加已耗时**（名称解析 + 逐只拉取最长一两分钟）
6. **模拟盘挂单可见性**：存在挂单时订单流水上方提示「N 笔挂单待成交，市价单日终
   结算时按收盘价撮合」；合规审计等级过滤与徽章中文化（info→提示 … critical→严重）
7. **自选股移除按钮 aria 重复**：名称未加载时读屏读出「移除 600519 600519」，已按
   有无名称分别生成
8. **对比分析空占位可点击**：「＋ 添加第 N 只」从静态 span 改为按钮，点击直接聚焦
   搜索框（删除 PipelineProgress 死组件与其样式）

### 用户新功能审查批次（2026-09-11，审查侧）

用户提交 6 个功能提交（时间序列计量 ADF/GARCH/协整/ARIMA/Kalman、全市场初筛雷达、
形态事件因子族、因子实验室 + 实验台账、多模型集成投票、MCP server 暴露）。
全量审查结论：**整体质量很高**——factorExpression 是手写 tokenizer + 递归下降 +
双重白名单（无 eval/Function，无注入面）；eventProvider 字段口径逐一实测验证；
quantCache 逐条 TTL + 防穿越 + 自愈 prune；Kalman 2×2 更新代数逐项验证正确；
linalg 部分主元消元 + 经典标准误公式；MCP server 为 stdio 薄转发（无网络监听、
无 SSRF 面）。审查发现并修复 4 处：

1. **pat_limit_up 信号恒为 1（方法论缺陷）**：截面 IC 需要横截面变异，常数信号
   使秩全并列、Spearman 分母为 0，该因子 IC 恒 0、纯噪声行。改为实际涨停幅度
   （10cm/20cm 品种天然有截面差异），实测 8 只白酒面板 icDays=293、IC −0.021
2. **preflight 单源探针盲区**：K 线源（push2his）与板块列表源（push2）是两个域名、
   可用性互不绑定；实测出现「K 线通、列表挂」时 board 路径陪跑整轮超时才 502。
   预检新增 upstream_list 独立探针，board 分支改用列表源探针判定，
   实测故障场景下秒级 503 + 可行指引
3. **ADF 信息准则参数计数**：'n'/'c' 各多算 1 个参数（不影响选阶 argmin，
   但诊断展示失真），已修正
4. **协整半衰期 φ ≤ −1 边界**：振荡发散的「伪均值回复」会算出 NaN，归入
   Infinity（无有效均值回复口径）；前端补形态因子中文标签

### 两个设计取舍的最优解（2026-09-11，审查侧实施）

1. **初筛宇宙去偏**：默认从「主表前 500 只（实际退化为沪市主板）」改为
   **全市场**（K 线增量缓存让稳态全扫只剩尾部补齐）；设上限时按代码排序
   **等步长采样**——确定性（同一批代码，缓存永远命中）且跨板块代表。
   实测：主表 5558 只，30 只样本覆盖 9 个代码段；结果新增 universe{total,
   coverage} 与 durationMs 如实披露；路由接线客户端断开中止；MCP 描述同步
2. **LLM 集成投票语义聚类**：分组从「文本精确相同」改为**字符 bigram 重叠
   系数**（|A∩B|/min(|A|,|B|)，对长度差稳健、中英文通用、确定性零依赖）+
   贪心加权聚类——自由文本下同义改写聚为一组（agreement 恢复语义），观点
   相左分得开；结构化输出是相似度=1 的特例，行为不变；similarityThreshold
   可覆盖（>1 退化为逐字相同）

### 科学有效性批次（2026-09-11 深夜，审查侧实施）

针对「与顶尖平台的实质性差距」落地三项 + 一项诚实声明：

1. **基本面因子 PIT 化（前视修正）**：cs_roe / cs_gross_margin / cs_net_profit_growth /
   cs_debt_ratio / cs_np_yoy_q / cs_roe_slope 此前把「今天的年报值」投影回全窗口
   （公告时点前视）。现按季度报告 NOTICE_DATE 门控（buildPitSnapshots）：日期 t
   的取值 = t 时点已公告的最新报告，公告日跳变、其余日子保持；无公告日的报告
   不参与 PIT。表达式 DSL 标量（roe 等）同步 PIT 化（快照常数降为兜底）。
   截面路由不再抓取年报（每股少一次上游调用）。实测 8 只白酒面板 6 因子全出
2. **批量假设验证 runner**：POST /api/quant/factor/expression/batch（≤50 条）——
   universe 解析与取数只做一次（面板共享），逐表达式求值 → 评估 → 台账。
   抽取 resolveUniverse / fetchPanelInputs / assembleExpressionObservations
   三助手，cross-section / expression / batch 三路由去重。实测 2 表达式共享
   面板，「roe」PIT 因子 IC +0.16 / p=0.027 判定有效；MCP 工具同步
3. **台账 FDR 折扣**：summarize 增加 keptExpectedFalse（= Σp 采信集期望假阳性，
   单次 Holm 之外的「全历史试错」维度）与 keptOosShare；因子实验室展示
4. **幸存者偏差声明**：截面响应 universe.survivorshipNote 如实披露「主表为当前
   上市证券，历史截面不含已退市股票」——修复需 PIT 成分股数据源（免费接口无）

组合构建层（信号→头寸→再平衡）是独立子系统，需独立设计周期，本批不含。

### 组合构建层（2026-09-12，审查侧实施）

评估清单上最后一项独立子系统：**因子组合回测引擎**（portfolioBacktest.ts，纯函数）——
从「因子有区分力」到「按因子交易能拿到什么」的最后一环：

- 调仓日按因子值排序持 top-N 等权，holdDays 个交易日后换仓；换手 × costBps
  （默认 30：佣金双边 + 印花税 + 滑点余量）计提成本；基准 = 候选宇宙等权
  （因子中性对照，与截面 IC 语义严格一致，回答「选股是否跑赢不选股」）
- 输出：净值/基准双曲线、总收益、年化、夏普、最大回撤、周期胜率、平均换手
- 诚实边界（docstring 与响应同时披露）：收盘价撮合（T+1 未建模，短周期偏乐观）、
  涨停无法买入未单独建模、候选不足持实际数量、无候选空仓
- 接线：/factor/expression 与 /expression/batch 增可选 portfolio 参数（面板共享，
  逐条回测）；FactorLab 增开关与结果卡；MCP 同步
- 实测（白酒 8 只、roe PIT 因子、21 日调仓）：IC 不显著（p=0.11）但组合相对
  宇宙等权 +4.5pp（−9.9% vs −14.4%）——「板块在跌、选股仍有效」的正分离，
  平均换手 7%（慢因子低换手合理）

评估清单（PIT ✅ / 批量 runner ✅ / FDR ✅ / 幸存者声明 ✅ / 组合层 ✅）至此全部
闭环；「机构级」剩余项（Tick 数据、PIT 成分股源、实盘接口）为数据采购/基础设施
边界，非代码可达。

### 收尾时门禁（2026-09-05 更新）

- 1214 单测（107 文件）、lint（eslint+oxlint）/ prettier / 双端 tsc / build / CI 全绿
