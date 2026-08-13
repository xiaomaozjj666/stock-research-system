# 工程笔记

本文件沉淀本项目维护与开发过程中已验证的工程事实，供后续改动复用。

## 技术栈

- monorepo（npm workspaces）：`server/`（Express5 + TS7, NodeNext, `.js` 扩展名）+ `client/`（React19 + Vite8 + ECharts6 + plugin-react 6）。
- 测试：Vitest 4 + @vitest/coverage-v8 4（v8 provider），`globals:false`（测试里 `vi`/`expect`/`describe`/`it` 必须显式 import）。

## 质量门禁（应全部为 0 失败）

- `npm run lint`（JS/风格）0。
- `server`: `npx tsc --noEmit` 0。
- `client`: `npm run build` OK。
- `npm run test`（vitest run）：截至 2026-08-11 为 **761 passed / 0 failed**（69 个测试文件）。
- 整体覆盖率 ~80%。

## 依赖升级的硬约束（踩过的坑）

1. **TS 7.0.2 ↔ typescript-eslint 不兼容**：registry 里 typescript-eslint 最高 8.65.1-alpha.19，peer `typescript <6.1.0`，不支持 TS 7。→ ESLint 只覆盖 JS/JSON/风格（`eslint.config.mjs` 忽略 `*.ts/*.tsx`）；TS 静态分析用 `tsc --noEmit`（TS7+strict）。
2. **vite 去重**：root `package.json` 有 `overrides: { "vite": "8.2.0" }`，防止 vitest 把 vite 拉成 6.x 造成 hoist 冲突。改动 overrides 前先想清楚。
3. **react/react-dom 在 root `devDependencies`**：必须 hoist 到 root，否则 echarts-for-react（CJS `require('react')`）构建时 "failed to resolve react"。不要从 root 删掉它们。
4. **ECharts6/React19 类型桥接**：`client/src/components/ChartsSection.tsx` 把 `ReactEChartsCore` cast 为 `ComponentType<{echarts, option: unknown,...}>`。ECharts6 的 `EChartsOption` 过严，option 用 unknown。
5. **安装命令**：`npm install --legacy-peer-deps --dangerously-allow-all-scripts`（legacy-peer-deps 绕过 TS7 peer；allow-all-scripts 放行 esbuild postinstall）。
6. **同伴依赖必须精确 pin**：`@eslint/js` 最新是 **10.0.1**（版本号独立于 eslint）；`@vitejs/plugin-react` **6.0.5**（支持 Vite 8）；`echarts-for-react` **3.0.7**（3.0.6 会拉 react18 嵌套）；`react-markdown` **10.1.0**（peer react>=18）。

## 数据源约束

- 后端拉数只走 `datacenter.eastmoney.com` / `searchapi.eastmoney.com`（Node fetch 正常）。
- `push2.eastmoney.com` 经 Node `fetch` / 子进程 `curl` 失败（TLS reset）。仍被 `stockMaster.loadStockMaster()`（push2 分页全表）与 `dataFetcher.ts`（股票基本信息主源，财务/估值兜底）引用，本环境必然失败，属预期：stockMaster 有磁盘缓存 + 搜索兜底链路，dataFetcher 基本信息回退新浪、财务/估值以 datacenter 为主。
- 港美股财务估值 `quant/intlDataProvider.ts` 已从 push2 换到 `datacenter.eastmoney.com` 的 RPT 网关（免费无 token）：港股 `RPT_HKF10_FN_MAININDICATOR`（+ `RPT_HKF10_INFO_SECURITYINFO` 名称兜底）、美股 `RPT_USF10_INFO_ORGPROFILE`（+ `RPT_USF10_FN_GMAININDICATOR` 补营收/净利），不再"恒降级"；单只失败仍 `degraded=true` 降级不阻断。
- 估值主源用 `RPT_VALUEANALYSIS_DET`：真实 CLOSE_PRICE / PE_TTM / PB_MRQ / TOTAL_MARKET_CAP / BOARD_NAME。push2 对同业股返回过错误量纲数据（如五粮液 PE=257），仅作 fallback。

## 搜索与显示名清洗（长鑫科技案例）

- 长鑫科技（688825.SH）2026-07-27 登陆科创板，品牌「长鑫存储」，上市主体「长鑫科技」。
- `server/src/services/dataService.ts`：`SEARCH_ALIASES`（长鑫存储/长鑫 → 长鑫科技）+ `cleanDisplayName()` 去上市窗口期前缀 C/N（C=次日起 5 交易日，N=首日）+ `DISPLAY_NAME_OVERRIDE`（C长鑫 → 长鑫科技）。
- `stockMaster.fuzzyMatch`：归一化去前缀（C/N/ST/XD/XR/DR/PT）+ 仅留中文，支持精确/包含/公共子串匹配，评分排序取前 10。
- 搜索兜底链路：东方财富 suggest 为主，空结果回退本地全表模糊匹配（支持全称/子串/代码/部分重叠）。

## 量纲约定（真实 bug 教训）

- 全系统财务比率统一为**百分数**（91.5 而非 0.915），由 `dataFetcher.toPercent()` 保证；`toPercent` 只在 `|n|<1` 时 ×100（≥100 已是百分数，避免 105 → 10500%）。
- 财务比率系数按百分数量纲：毛利率稳定性 `*0.3`、盈利应收 `*0.05`、风险应收 `*0.1`（曾误用 `*1.5`/`*0.3`/`*10`，导致子项对绝大多数公司恒为 0）。
- 负债风险按**行业基准**折算（银行 92%/建筑 76%/默认 45%）。
- 五维度全部 `Math.max(0, ...)` 夹紧，避免负分。
- `riskExpert`：负债率>80 / 商誉>50 / 现金流<0.3 任一超阈 → 强制 bearish。

## 测试注意

- vitest.config `globals:false` → 测试里 `vi`/`expect`/`describe`/`it` 必须显式 import。
- client 组件测试必须 `afterEach(cleanup)`（globals=false 无自动清理），否则 DOM 跨用例累积。
- `vitest.config.ts` 的 `resolve.extensions` 必须显式含 `.tsx`，否则解析不了 extensionless `.tsx` 导入。
- `routes.test.ts` 需 `app` 可导入不绑端口：`server/src/index.ts` 把 `app.listen`/优雅关闭包进 `if(process.env.NODE_ENV!=='test')`，vitest.config 设 `env:{NODE_ENV:'test'}`。
- `server/src/quant/**` 被 vitest.config 排除出覆盖率插桩（测试仍跑且断言），覆盖率因此稳定在 ~80%。

## 构建/部署注意

- Vite8/Rolldown 的 `emptyOutDir` 与 Vitest 的 `coverage/.tmp` 清理会因批量删除文件被拦截 → `client/vite.config.ts` 设 `build.emptyOutDir:false`（真实 CI 应自行清理 dist）；coverage 报告仍正常写出。
- server `dist` 构建失败时：rename 旧 dist 后重建即可。
- 端到端/冒烟脚本用 `tsx` 跑完即删，不要留仓库。

## 新闻信号（quant/newsSignal.ts）

- `lexiconPolarity`：词典极性（BULLISH/BEARISH 词表）→ 加权极性 p∈[−1,1]，夹紧防极端。
- `aggregateNewsSentiment`：近期指数衰减加权（λ=0.12，半衰期≈5.8 天）。
- 预测模型：`expectedForwardReturn` 增 `newsComponent = NEWS_GAIN(0.08) × newsZ`；`scenarioProbabilities` 增 `newsTilt` 微调三档概率。
- 策略回测 `newsOverlay`：`newsPosture = clamp(0.5+0.5·polarity,0,1)` 缩放买入仓位；posture=0 直接跳过买入。

## 数学模型层（quant/factorAnalytics.ts 等）

- 工具：`spearmanRankIC`、`informationRatio`、`crossSectionalZScore`、`winsorize`、`compositeZ`、`zToScore`（logistic 映射到 [0,max]）。
- `selectOptimalFactors`（Grinold-Kahn）：剔除 |IC|<0.02 与 |IR|<0.3 的因子；保留因子按 |IR| 分配权重 Σ=1；全无效回退等权。
- 旧 API `walkForwardBacktest`：`oosRatio = avgTestSharpe / avgTrainSharpe`，≥0.5 ⇒ stable（检过拟合）。新 API `runWalkForward` 的过拟合判定阈值见「受控评估」节（OOS 夏普 < 70% × IS 夏普才提示）。
- 单股实时分析无「多股带实现收益的面板」时，最优权重默认走等权先验。

## 模拟盘（quant/paperTrading.ts）

- `PaperAccount` 自建 A 股撮合引擎，构成无实盘资金的研究闭环：策略信号 → 模拟下单 → 日终按收盘价撮合 → 记录每日净值 → 绩效统计。路由：`GET /api/paper/portfolio`、`POST /api/paper/order`、`POST /api/paper/settle`、`GET /api/paper/stats`。
- 撮合规则：市价单按当日收盘价成交；限价单按收盘价触发（买单：收盘 ≤ 限价；卖单：收盘 ≥ 限价）且均按收盘价成交，当日未成交自动过期。
- A 股硬规则：T+1（当日买入次日才可卖，`buyDate` 校验）、涨跌停拒单（主板 ±10%，`limitPct` 可配）、整手约束（数量向下取整到 100 股整数倍）、停牌/无收盘价拒单。
- 费用：佣金默认万三（`commissionRate` 0.0003）、卖出加收印花税 0.1%（`stampDutyRate` 0.001），金额保留 2 位小数。
- 绩效 `computeStats()`：累计收益 / 最大回撤 / 简单年化夏普（日频收益、无风险利率 2.5%、至少 2 个日收益点）。
- 持久化：`server/src/data/paperTrading.json`（`PAPER_TRADING_FILE` env 可重定向），「临时文件 + 原子 rename」写入，无 sqlite 依赖；初始资金取 `PAPER_INITIAL_CAPITAL` env（默认 100,000）。

## 受控评估（DSR / CSCV / Walk-Forward）

- `quant/backtestEvaluator.ts` `compareBacktests`：同一数据/区间上「基线 vs 实验」的受控对比。配对 t 检验（Harvey-Liu-Zhu 2016：|t|>3 强显著 / 2-3 边际 / ≤2 不显著）、非正态诊断（|偏度|>1 或超额峰度>3 时以 Bootstrap 为准）、配对 Block Bootstrap CI（Politis-Romano stationary bootstrap，期望块长 2√n，2000 次，seed=42 确定性）、交易成本敏感性（A 股 0.4% round-trip）。
- DSR 公式要点（Bailey-López de Prado 2014）：`DSR = Φ((SR − SR₀) / σ_SR)`，在 PSR 基础上扣除"试了 N 个策略取最佳"的搜索偏差。`SR₀ = σ_SR · E[max]`，`E[max] = (1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e))`（γ≈0.5772 Euler-Mascheroni）；`σ_SR² = [1 − γ₃·SR + ((超额峰度+2)/4)·SR²] / (T−1)`（Mertens 2002 口径，正态时退化为 Lo(2002)）。DSR∈[0,1]，N 为试过的策略数（`numStrategiesTried`），N 越大越保守；另有 MinTRL（DSR≥0.95 所需最短回测年数）。
- `quant/cscv.ts` `computePbo`：CSCV 组合对称交叉验证（De Prado et al. 2017）算回测过拟合概率 PBO。T 天切 S 块（默认 8、偶数），枚举 C(S, S/2) 个「取半块做 IS、剩半块做 OOS」组合，PBO = "IS 最优策略在 OOS 相对排名 ω<0.5"的组合占比；PBO≈0.5 表示选优近乎运气，≈0 表示选择有效。
- `walkForward.ts` `runWalkForward`（新 API）：滚动/扩张窗口 OOS 评估，语义是「策略是否过拟合」（IS vs OOS），**不是**「信号 vs 基线」——信号对比用 `compareBacktests`。过拟合判定：OOS 平均夏普 < 70% × IS 平均夏普（`isOOSSignificantlyWorse`）且多数窗口 OOS 劣于 IS 才提示；另有 `consistencyScore = 1 − (子期间 Sharpe 标准差 / 均值)` 衡量跨窗口稳定性。

## 环境注意

- 本机有 `http_proxy=http://127.0.0.1:7890` 代理，会干扰 npm/vitest 运行；执行前先 `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY`。
- Git Bash 里 `curl -o /tmp/x.json` 的路径映射不可靠，落盘请用项目内相对路径。

## 已接线模块说明（2026-08-09 复核）

此前标注"完成待接线"的模块现已接入运行管线/服务，均为可选增强或降级安全（try/catch 包裹，失败不阻断主流程）：

- `services/telemetry.ts`（全链路追踪）：`index.ts` 挂 `expressTracerMiddleware()`，为每个 HTTP 请求注入 `X-Trace-Id` root span，`configureTracer({ exportHook })` 将完成的 span 输出到 debug 级日志（`LOG_LEVEL=debug` 可见）；`llm/client.ts` 经 `recordLLMUsage → tracer.recordLLMCall` 记录 LLM span 及成本/token。
- `services/auditLog.ts`（金融监管 8 号文合规审计）：全局 `auditLogger` 配 `filePersistenceHook` 落盘为 `server/src/data/audit.log`（JSON 行追加，IO 失败静默降级）；`analysisPipeline.ts` 在数据访问 / LLM 专家调用 / 交易信号三处埋审计点；`GET /api/audit` 支持 category/riskLevel/startTime/endTime/sessionId 过滤查询。熔断 `checkCircuitBreaker` 已于 2026-08-11 接线为中间件 `circuitBreakerGuard`，挂在 analyze/compare/chat/chat/stream/compare/backtest/evaluate/research 等分析类路由（tripped 时 503 + Retry-After）。
- `llm/knowledgeGraph.ts`、`quant/sectorRotation.ts`、`llm/mcpClient.ts`：作为 `analysisPipeline` 的可选增强接入——知识图谱（步骤 14，当前股票 + 同业可比数据构图）、板块轮动（步骤 15，单行业截面，rank 恒 1 仅作参考）默认启用，失败降级为无字段；MCP（步骤 16）仅当设 `MCP_SERVER_URL` 时启用。
- `quant/intlDataProvider.ts`（港美股财务估值）：数据源已换 `datacenter.eastmoney.com` RPT 网关（见「数据源约束」），接入 `GET /api/intl/fundamentals?code=&market=`。
- `utils/env.ts`（环境变量校验）：已于 2026-08-11 接入 `index.ts` 启动流程（全部 import 之后调用 `loadEnv()`，非法 PORT / CACHE_TTL_HOURS 快速失败）。

## 2026-08-11 审查修复记录

- `services/scheduler.ts`：自治循环增加连续失败指数退避（第 2 次失败起间隔翻倍，封顶 8 倍）+ 连续失败 10 次自动停止（`running=false`），成功后清零恢复基础间隔；测试 `__tests__/scheduler.backoff.test.ts`（fake timers）。
- `index.ts`：`/api/chat/stream` 补 message ≤2000 字校验（与 POST /api/chat 对齐）；`/api/autonomous/start` 的 intervalMs 夹紧到 [30 秒, 24 小时]。
- `services/dataService.ts`：新增 `pruneFileCache()`（删过期/损坏缓存 + 超 `FILE_CACHE_MAX`（默认 2000）按时间戳淘汰最旧），启动清理一次 + 每小时定期；缓存目录可用 `DATA_CACHE_DIR` 重定向（测试隔离）。
- 前端：`ChatPanel` 优先走 SSE 流式对话（`chatWithAgentStream`），失败自动回退非流式；卸载取消在途连接。`index.html` 移除 Google Fonts 外链（首屏阻塞源），补 meta description/theme-color/内联 SVG favicon；字体栈改为系统字体（含 PingFang/雅黑/思源黑体回退）。

## 2026-08-11 第二轮优化记录

- `client/src/api/client.ts`（H-03）：`analyzeStockStream` 增加指数退避重连（首事件到达前最多 3 次，退避 500ms→4s，收到首事件后不再重试）；`chatWithAgentStream` 增加 15s 首包看门狗（超时主动 close）。测试 `client/src/api/__tests__/analyzeStream.test.ts` 覆盖重试成功/耗尽。
- `index.ts`：新增 `circuitBreakerGuard` 中间件（基于 `auditLogger.checkCircuitBreaker()`，tripped 时 503 + Retry-After），挂在分析类路由；测试 `server/src/__tests__/circuitBreaker.routes.test.ts`。
- `services/analysisPipeline.ts`（M-01）：历史 PE 估算魔法数字提取为命名常量。
- 新增 `.nvmrc`（Node 24）与根 `package.json` `engines.node >=24`（L-04）。
- `vitest.config.mts`：新增覆盖率 `json-summary`/`text-summary` 报告器与阈值门禁（lines 68 / statements 66 / functions 60 / branches 54，低于当前实测 lines 70.74%）。quant 模块已确认纳入覆盖率统计（server/quant 源码平均约 88% lines）。
- `npm audit --omit=dev`：0 vulnerabilities（2026-08-11）。

## 2026-08-12 收尾记录

- 格式门禁归零：`npm run format` 统一全部文件为 LF/prettier 风格（142 个存量差异清零），`format:check` 现可直接作为门禁使用；新增 `.gitattributes`（`* text=auto eol=lf`、`*.bat text eol=crlf`）防止 Windows 环境 CRLF 复发。`启动系统.bat` 保持 CRLF 并已验证字节构成。
- npm 安装警告消除：根 `package.json` 的 `allowScripts` 字段与用户级 `.npmrc` 的 `allow-scripts` 在 npm 12 下冲突（package.json 优先、.npmrc 被忽略并告警）。已将等效声明迁移至项目级 `.npmrc`（`allow-scripts=esbuild@0.28.1,esbuild@0.21.5,esbuild@0.25.12`）并移除 package.json 中的 `allowScripts` 字段；用户级全局配置未改动（含 strict-allow-scripts 与安全清单，被其他工具依赖）。
- 收尾后全量回归：lint 0 / format:check 归零 / 768 tests 全绿 / client build OK / 双端 tsc OK。

## 2026-08-12 E2E 与 CI 落地记录

- **生产环境 SPA 同源托管**（`index.ts`）：`NODE_ENV=production` 且 `client/dist` 存在时，Express 直接托管前端静态产物并把非 `/api` 的 GET 回退到 `index.html`——单进程单端口同时服务页面与 API，无 CORS 依赖；开发环境仍走 Vite dev server 双进程模式。
- **CORS 重构**（`index.ts`）：改为 `cors((req, cb))` 函数形式，新增同源放行（`origin.host === req.headers.host`），修复生产环境 SPA 自身 POST 被白名单误拒 403 的问题；原有"生产白名单 / 开发全放行"语义不变，security.routes.test.ts 15 用例全过。
- **E2E 冒烟测试**（Playwright，`e2e/smoke.spec.ts` 7 用例）：真实 Chromium + 生产模式真实服务（端口 3100）；数据文件经 `WATCHLIST_FILE`/`PAPER_TRADING_FILE`/`DATA_CACHE_DIR` 重定向到 `e2e/.tmp`，不污染真实数据。globalSetup 按需构建两端 dist。运行：`npm run test:e2e`（首次需 `npx playwright install chromium`）。新增依赖 `@playwright/test@1.62.1`（与 playwright 库同版本 pin）。
- **CI**（`.github/workflows/ci.yml`）：quality job 补齐 format:check + 覆盖率门禁（`--coverage`）+ 覆盖率产物上传 + concurrency 取消旧运行；新增独立 e2e job（安装 Chromium → playwright test → 失败时上传报告）。Dependabot（`.github/dependabot.yml`）：npm 周度分组更新 + github-actions 月度更新。
- 部署（Docker）：2026-08-12 曾起草 Dockerfile/compose，用户明确暂不需要部署，相关文件已删除；SPA 同源托管与 CORS 同源放行作为通用服务端能力保留。

## 2026-08-13 OpenAPI 契约与 Prometheus 指标落地记录

- **OpenAPI 3.1 契约**（`services/openapi.ts` + `GET /api/openapi.json`）：把 README「API 概览」表格落成机器可读规范（31 个端点，含请求体 schema / 错误响应 / 503 熔断说明）；`openapi.routes.test.ts` 做结构性校验兜底（operation 必有响应、路径模板参数必声明、核心端点全覆盖）。维护约定：新增/修改路由时同步更新 openapi.ts。
- **Prometheus 指标**（`services/metrics.ts` + `GET /api/metrics`，零依赖、不引入 prom-client）：`http_requests_total`（counter）、`http_request_duration_ms`（histogram，11 桶 10ms~30s）、`process_*`（uptime/heap/rss）、`llm_calls/tokens/cost_total`（读 llm/cost 内存账本）、`circuit_breaker_tripped`（实时读 auditLogger.checkCircuitBreaker）。路由标签归一化防基数爆炸（`/api/watchlist/600519` → `/api/watchlist/:code`，未知 → `/api/:other`，静态资源 → `static_assets`）。指标中间件挂在请求日志之后、路由之前。
- 测试：`metrics.test.ts`（9 用例：归一化/计数/直方图/标签转义/重置/中间件）、`metrics.routes.test.ts`（端点集成）、`openapi.routes.test.ts`（5 用例）；E2E 冒烟新增 2 个端点断言（共 9 用例）。
- 全量回归：lint 0 / format:check 归零 / **783 tests 全绿** / E2E 9/9 / client build OK / 双端 tsc OK。

## 2026-08-13 dataProvider 覆盖率补齐记录

- **`quant/dataProvider.ts` 覆盖率 25.4% → 98.3%**：此前仅测了 `marketOf`/`resolveSecid` 三个用例，网络拉数与降级路径完全未覆盖。新增 `__tests__/dataProvider.extra.test.ts`（10 用例）：缓存命中（12h 内不触发网络）/ 缓存失效重拉 / klines 文本解析与写缓存 / 网络失败降级模拟数据（`isSimulated=true`、跳周末、确定性）/ 缺 klines 降级 / `getBenchmarkCurve` 归一化 / 空白 trim 与未知代码回退。用例用专属代码段 `999xxx` + afterEach 清理缓存文件，不污染真实缓存。
- 覆盖率阈值门禁同步收紧：lines 68→70 / statements 66→68 / functions 60→62 / branches 54→55（基线更新为 2026-08-13，793 tests）。
- 全量回归：**793 tests 全绿** / coverage 阈值门禁通过。

## 2026-08-13 审计日志测试竞态修复记录

- **根因**：`auditLog.test.ts` 落盘用例直接读写真实 `server/src/data/audit.log` 并断言精确行数/末行，而其他测试文件（熔断/路由等）在并行 worker 中通过全局 `auditLogger` 往同一文件追加 → 行数断言偶发失败（flaky，约 1/5 轮复现）。
- **修复**：落盘路径改为运行时解析，支持 `AUDIT_LOG_FILE` 环境变量重定向（与 watchlist/paper/cache 同模式）；测试改用 `beforeAll` 设置进程专属临时文件、`afterAll` 清理并还原环境变量。`AUDIT_LOG_FILE` 保留为默认路径的兼容导出。
- **验证**：连续 6 轮全量测试全绿（修复前约 1/5 轮失败），793 tests / 0 failed。
