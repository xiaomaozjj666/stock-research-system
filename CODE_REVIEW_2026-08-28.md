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
