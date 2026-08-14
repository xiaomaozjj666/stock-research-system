# Changelog

股票研究系统（AI 多专家投研 + 量化回测）变更历史。
按日期倒序；commit 为完整短哈希。详细工程决策与踩坑记录见 `ENGINEERING-NOTES.md`。

## 2026-08-14 — 图表修复、研究助手主题统一、测试全量审查、CI 修复

### 性能与体验极致化（perf / ux）

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
- 历史清理：filter-branch 移除全部历史中的 `.workbuddy`（备份标签验证后删除，强推 origin/main）。

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

- 股票研究系统骨架：多专家 AI 分析（基本面 / 估值 / 行业 / 风险 / 资金流等）+ 量化回测内核（ma_cross 等策略）。
