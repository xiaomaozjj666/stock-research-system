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

## 2026-08-14 全量测试质量审查与修复记录

- **审查范围**：74 个测试文件 / 793 用例（services 28 / quant 17 / llm 9 / 路由级 8 / utils 3 / data 1 / client 8），4 路并行审查 + 源码逐项交叉验证。基线：793 tests 全绿 / 36.61s。
- **🔴 Critical 修复（2）**：
  1. `quant/agentEval.test.ts` — fixture 用错字段名（`strategyType` 而非 `type`），引擎落 `default→hold` 分支零交易，两用例恒通过测错东西；修复字段 + 连续日期 + 强化断言（tradeCount>0、avgSharpe≠0）。
  2. `quant/newsSignal.test.ts` — 末尾两条用例未 mock fetch，直连真实东财端点（网络 + 非确定）；修复为 mock 公告端点 + 新增"fetch 全失败→[]/none"用例。
- **🟠 High 修复（6）**：
  1. `services/experts.test.ts` — unlockExpert 用例用硬编码年份（2029 必破的定时炸弹）→ 动态相对年份；14 处只 stub `DEEPSEEK_API_KEY`（宿主有 OPENAI_API_KEY 会走真实 LLM 网络）→ describe 级双 key stub。
  2. `services/documentInsights.test.ts` — 同 OPENAI_API_KEY 残留问题 → beforeEach 双 key 清空。
  3. `services/stockMaster.ts` + `stockMaster.load.test.ts` — 缓存路径硬编码（测试读写删除真实 `server/src/data/stockMaster.json`）→ 源码支持 `MASTER_CACHE` env 重定向；测试改用临时文件 + `vi.resetModules()` 动态 import（消除内存缓存跨用例顺序依赖）。
  4. `quant/dataProvider.ts` + `dataProvider.extra.test.ts` — 缓存目录硬编码（写真实 quant/cache + afterEach rmSync 残留污染）→ 源码支持 `DATA_CACHE_DIR` env（与 services/dataService 对齐）；测试重定向到 mkdtemp 临时目录，弃用 rmSync 清理；缓存命中用例的 fetch spy 补 mock 实现（防缓存 bug 时真发网络）。
  5. `quant/factorOptimizer.test.ts` — `Math.random()` 未 seed（概率性 flake）+ else 分支恒真（空转通过）→ mulberry32 固定 seed + 强断言。
  6. `services/analysisPipeline.test.ts` — mock 状态跨用例/跨 describe 泄漏（依赖声明序）→ describe 级 beforeEach 重置默认值。
- **🟡 精选修复（路由/集成侧）**：
  - `security.routes.test.ts` + `metrics.routes.test.ts` — `GET /api/health` 触发真实外网请求（10+1 次，离线 CI 撞 vitest 默认 5s 超时）→ 文件级 `vi.stubGlobal('fetch')` 隔离。
  - `circuitBreaker.routes.test.ts` + `index.ts` — 503 缺 `Retry-After` 头（ENGINEERING-NOTES 承诺不实）→ 实现补 `Retry-After: windowMs/1000` + 测试断言。
  - `chat.routes.test.ts` — chatAgent mock 缺 `runStream`（流式路径零覆盖）→ 补 mock + SSE happy path 用例（断言 done 事件 + message 透传）。
  - `features.routes.test.ts` — `LLM_EMBED_MODEL` env 无 finally 还原 + 首用例依赖宿主环境干净 → beforeEach 清 4 个嵌入 env + try/finally；`/api/documents` 弱断言 `count>0` → 精确断言 `doc:d2` 入库。
  - `routes.paper.test.ts` — `_paperAccount` 模块级单例导致 `cash===initialCapital` 断言依赖用例声明序（shuffle 必挂）→ 放宽为状态合法断言。
  - `watchlistNewsBacktest.e2e.test.ts` — stockMaster mock 缺 `fuzzyMatch`（未来链路触达即 TypeError）→ 补全 mock 形状。
  - `alerts.test.ts` — 用例名不符 + `toBeTruthy` 泛泛断言 → 改名 + 精确计数断言。
  - `telemetry.test.ts` / `env.test.ts` — `process.stdout.write` spy 的 `mockRestore()` 不在 finally（断言失败残留吞 stdout）→ try/finally。
- **🟡 精选修复（utils/llm/quant 侧）**：
  - `utils/concurrency.ts` — `limit=NaN` 时 `Math.max(1,Math.floor(NaN))`=NaN → `Array.from({length:NaN})` 抛 RangeError（真实崩溃点）→ `Number.isFinite` 钳制 + NaN 用例；并发上限弱断言 `<=3` → 精确 `toBe(3)`。
  - `utils/http.test.ts` — vi.mock 工厂引用外层 let（TDZ 脆弱）→ `vi.hoisted`；恒真断言 `mockedExecFile.not.toHaveBeenCalled()` 删除。
  - `llm/tools.ts` + `tools.test.ts` — `run_backtest` 不校验 6 位代码（与 run_analysis/evaluate_backtest 不一致）→ 源码补齐校验；补 `compare_stocks` 全覆盖（合法 2 只并行 / 数量非 2-3 拒绝 / deps 未配置）。
  - `llm/config.test.ts` — env 只 delete 不恢复（污染宿主环境）→ beforeEach 快照 + afterEach 恢复。
  - `quant/newsSignalLlm.test.ts` — env 不还原 + "null 或数组"宽断言（数组分支死代码）→ stubEnv 托管还原 + 收紧 `toBeNull()`。
  - `quant/backtestEvaluator.test.ts` — "t 阈值分级"条件断言（合成数据 t≈34 恒走 strong，marginal 分支从未被测）→ 交替噪声构造 t≈2.5，强断言 `significant_marginal` + caveat。
  - `client/src/api/__tests__/client.test.ts` — 删多余 `@vitest-environment node`（默认即 node）。
  - `services/peerService.test.ts` — mock 无 beforeEach 重置（乱序/重跑时"优先代码反查"用例误失败）→ 恢复默认实现；`services/openapi.routes.test.ts` 硬编码 '3.1.0' → 引 `OPENAPI_VERSION` 常量；`services/dataService.getData.test.ts` 删原样返回 actual 的死代码 vi.mock；`services/dataService.test.ts` 别名改写断言从 fetch mock 内部移到测试体（失败定位清晰）。
- **测试基础设施**：
  - 新增 `server/src/test/setup.ts`（挂入 vitest setupFiles）：全局把 `AUDIT_LOG_FILE`/`CHAT_HISTORY_FILE` 重定向到 per-worker 临时目录（此前路由级测试每次写入真实 `server/src/data/audit.log` 713KB）；`setLogLevel('error')` 静音结构化日志（HTTP request/warn 刷屏），依赖日志输出的用例（env/telemetry）显式恢复级别。
  - `services/chatMemory.ts` — `CHAT_HISTORY_FILE` env 惰性重定向（与 audit/watchlist/paper 同模式）；`chatMemory.test.ts` 自管理临时文件。
  - `e2e/smoke.spec.ts` — "六个 Tab"用例此前只测 4 个 → 补默认页深度研究 + 对比分析，覆盖全部 6 个 tab。
  - 测试总时长 36.61s → ~11s（日志静音 + 网络 stub 后并行更充分）。
- **遗留项（未修，记录在案）**：
  - `backtestEvaluator.test.ts` "Bootstrap CI 跨 0 但 t 显著"条件断言——强偏态差异序列构造困难，分支仍未被真实触发（条件断言已存在，不会误报）。
  - `quant/agents.test.ts` dataEngineer 无 A 股法定节假日用例（春节/国庆会误报"缺失交易日"，产品级缺陷待交易日历）。
  - `pdfExtract.test.ts` `if (installed) return` 静默跳过（装 pdfjs-dist 后错误路径测试无声失效）。
  - `mcpClient.test.ts` 连接失败用例依赖真实 spawn/网络（127.0.0.1:1），慢网环境可能卡 30s。
  - `predictionModel.test.ts` 区间对称包络容差 25% 过松；`factors.test.ts` 硬编码因子数（21）新增因子即破。
  - 测试隔离底线约定：**所有运行时数据文件（watchlist/paper/cache/audit/chatHistory/masterCache）均已支持 env 重定向**，新增落盘服务必须沿用此模式，禁止测试写默认路径。

## 2026-08-14 图表渲染修复与研究助手主题统一记录

- **图表崩溃根因**：`echarts-for-react@3.0.7` 被 npm 标记 "published in error"（已废弃；3.0.6 才是 latest 正式版）。其 esm/ 产物用 extensionless 导入（非规范 ESM），生产构建（Rolldown）下 default 互操作把模块对象交给组件，React 报 `Element type is invalid: ... but got: object`（ChartsSection 渲染崩溃）。vite-node 下 default 是 function（正常），因此 dev 正常、生产必炸。
- **修复**：自研轻量封装 `client/src/components/EChart.tsx`（echarts.init + setOption(notMerge) + ResizeObserver 自适应 + 卸载 dispose），替换 ChartsSection 与 NewsPostureHeatBar 中的 echarts-for-react；**删除 echarts-for-react 依赖**（bundler 体积 -7.4KB gzip）。新增 EChart.test.tsx（4 用例，mock lib/echarts + ResizeObserver stub）。
- **研究助手主题**：ChatPanel/ResearchEnhance 的样式（index.css 2428 起）历史上是**亮色硬编码**（白底证据卡、`#f1f5f9` 浅灰气泡、`#e2e8f0` badge、`--color-primary/--bg-surface/--border-color` 不存在的变量 + 浅色 fallback），在深色界面里形成"亮色孤岛"。已整体重写接入深色变量体系（`--bg-card/--bg-secondary/--accent/语义色 dim`；A 股红涨绿跌语义保留：看多红、看空绿）。注意：**CSS 注释里不能出现 `*/` 序列**（lightningcss minify 会提前终止注释导致构建失败）。
- **交互完善**（ChatPanel）：Enter 发送 / Shift+Enter 换行（替代 Ctrl+Enter）；空输入禁用发送按钮；"清空"按钮（仅清前端显示，服务端会话记忆保留）；助手消息 hover 显示"复制"按钮（clipboard API + 已复制反馈）。ChatPanel.test.tsx 增至 6 用例。
- **验证**：807 tests 全绿（+7 新用例）/ client build OK（新产物无 echarts-for-react/size-sensor）/ E2E 9/9 / 双端 tsc / lint / format:check 全过。

## 2026-08-14 研究历史记录功能落地记录

- **后端**：`services/historyService.ts`——分析结果落盘 `server/src/data/history.json`（`HISTORY_FILE` env 可重定向，与 watchlist/paper/audit 同模式）；**同股票代码去重更新**（id 保留、createdAt 刷新，每只股票仅一条最新记录）；容量上限 `MAX_HISTORY_ITEMS=100`（超出按 createdAt 倒序淘汰最旧）；"临时文件 + 原子 rename"写入；损坏文件/写盘失败静默降级。列表接口瘦身（不含完整 result），详情接口返回 `result` 供前端恢复研究报告渲染。
- **自动入库**：`/api/analyze` 与 `/api/analyze/stream` 成功路径均调用 `persistAnalysisHistory()`（从 `result.stock_pool[0]` 提取摘要；任何失败静默，不阻断分析响应）。
- **路由**：`GET /api/history?limit=`（列表倒序）、`GET /api/history/:id`（详情含 result）、`DELETE /api/history/:id`；OpenAPI 契约同步补齐（`/api/history` + `/api/history/{id}`）。
- **前端**：新增「历史」tab（第 7 个，懒加载 `pages/history/HistoryPage.tsx`）——列表（名称/代码/行业/评级徽章/评分/时间）、「查看」拉取详情并恢复完整研究报告（切回深度研究页渲染）、「删除」即时移除；评级徽章用语义色（优先跟踪=绿 / 持续观察=蓝 / 谨慎观望=黄 / 建议规避=红）。
- **测试**：`historyService.test.ts`（8 用例：增删查/去重/容量淘汰/损坏容错/写失败/limit 钳制）+ `history.routes.test.ts`（5 用例 CRUD 路由）+ `HistoryPage.test.tsx`（3 用例列表/查看回调/删除）；e2e「全部 Tab」用例补历史页。
- **验证**：823 tests 全绿（+16 新用例）/ client build OK / E2E 9/9 / 双端 tsc / lint / format:check 全过。

## 2026-08-18 界面去模板感与记忆反思闭环记录

### 1. 全页面 AI 味诊断方法论

- 真实浏览器（生产模式 `NODE_ENV=production` 单端口托管）逐 tab 截图 → 视觉模型逐张审查。**视觉审查比结构审查更能发现 AI 味**（布局失衡、占位符堆砌、术语堆砌文案），但需注意视觉端点限流（429）时降级用 accessibility snapshot + innerText 结构审查。
- 诊断出的共性问题模式：① 空态占位符重复（"待添加"×3）→ 序号化 + 状态驱动文案；② 术语堆砌（"万三对称"、"日K收盘撮合 + A股规则(T+1/涨跌停/整手/费用)"）→ 用户导向改写；③ 功能罗列式副标题（"支持路由规划、工具调用…"）→ 场景示例式；④ 装饰图标无信息量 → 配合有信息量的文案。
- **改动前先 grep 测试引用**：空态/按钮文案被 E2E（smoke.spec.ts 引用"暂无自选股，先在上方添加。"）与组件测试引用，须同步更新。

### 2. 记忆反思闭环（借鉴 TradingAgents）

- TradingAgents（99.1K star）核心模式之一：决策 → 结算 → **反思 → 回注**（同 ticker 决策 + 已实现 alpha + LLM 教训注入下次）。营销与真金标注：**记忆反思闭环 = 真金**（唯一能随时间变强的机制）。
- 落地轻量版：`historyService.getPreviousAnalysis(stockCode)`（保存前调用返回"上一次分析"摘要，因同代码去重更新，保存后该条即被覆盖）→ 路由 `persistAnalysisHistory` 计算 `vs_previous {previous_date, previous_rating, previous_score, score_delta, rating_changed}` 附加到 `stock_pool[0]` → `ReportHeader` 展示（▲ 红升 / ▼ 绿降 / ＝ 平，A 股红涨绿跌配色与风险归因一致）。
- **语义陷阱**：对比必须在 `saveHistoryEntry` **之前**读取旧记录（保存会覆盖同代码条目）；`createdAt` 用单调时钟，日期展示取 `slice(0,10)`。
- TradingAgents 其余建议（对抗式多空辩论升级、数据防幻觉套件、结构化输出统一封装、checkpoint 断点续跑）已评估：**回测 look-ahead 过滤已由 T+1 信号延迟覆盖**，其余记录为后续路径。

## 2026-08-18 量化层升级记录（Analyzer 模式 + 风险归因 + 可插拔成本模型）

对标 backtrader（22.9k⭐）/ qlib（47.7k⭐）/ gs-quant（12k⭐）三个高 star 量化引擎，落地三项高价值优化：

### 1. 绩效分析器（借鉴 backtrader Analyzer 模式）

- backtrader 核心范式：**引擎只广播事件，统计是可插拔分析器集合**（Analyzer 有生命周期钩子 start/stop/next + 结果容器 get_analysis + 注册实例化，可嵌套组合）。
- 落地：`server/src/quant/analyzers.ts` —— `AnalyzerContext {equityCurve, trades, tradingDaysPerYear?}`，`PerformanceAnalyzer {name, compute(ctx): number}`，`computePerformance(ctx, analyzers = defaultAnalyzers)`。引擎侧 `backtestEngine.ts` 删除 87-161 行硬编码统计，改为调用 `computePerformance` 后 round 2 位，**返回字段逐字不变**（行为等价重构，无回归风险）。
- 常量：`TRANSACTION_COST_RATE = 0.001`（双边万 5 佣金 + 万 5 印花税近似）、`RISK_FREE_RATE = 0.025`。
- 扩展方式：传入自定义分析器数组即可新增统计（测试里演示了 Calmar），无需改引擎。

### 2. 风险归因（借鉴 gs-quant RiskModel，轻量版）

- gs-quant RiskModel 接口：`getExposures / getFactorCovariance / getSpecificRisk / getTotalRisk / attributePortfolio`（风格+行业因子暴露，协方差 ×252 年化，特异残差）。
- 落地为**无协方差矩阵的经验常量版**（数据约束下最优解）：
  - `styleFactorExposures(input, crossSection?)`：5 风格因子（规模=ln市值、价值=-PE、动量=近 6 月涨幅、盈利=ROE、杠杆=负债率）对截面（缺省 `DEFAULT_BENCHMARK` 经验基准 mean/std）z 分数标准化；缺数据因子记 0（中性），pe≤0 容错。
  - `decomposeRisk(exposures, specificVol, factorVols = [12,18,22,14,10])`：`systematicVol = sqrt(Σ (z_i · fv_i)²)`，`totalVol = sqrt(sys² + spec²)`，`explainedRatio = sys²/total²`——经验因子波动率（A 股风格因子年化波动近似）。
  - `analysisPipeline` 在结果组装处附加 `riskAttribution`（特异风险基线 `SPECIFIC_RISK_BASELINE = 25`），前端 RiskSection 渲染 5 因子条形图（正暴露红、负暴露绿，A 股语境红涨绿跌）+ 分解文本。
- **注意**：当前为经验常量版，未实现协方差矩阵（数据不足）。后续若接入因子收益率序列（如 qlib Alpha158 因子库），可升级为真实 `getFactorCovariance` + 年化 252 路径。

### 3. 可插拔交易成本模型（backtrader CommInfo / qlib Exchange / gs-quant backtests 三方印证）

- 三份研究报告交叉一致结论：成本与撮合解耦、费率可带方向（**印花税只收卖出单边**）、支持最低费用兜底与冲击成本。
- 落地：`server/src/quant/costModel.ts` —— `CostModel {openRate, closeRate, minCost, slippage, impactCost?}` + 纯函数 `buyCost/sellProceeds`（fee = max(成交额×费率, minCost)）+ `marketImpactCost`。
  - `DEFAULT_COST_MODEL`：佣金万 3 双边对称、无最低费用、无冲击（**保持历史行为**；引擎未显式传模型时按 strategy.commission/slippage 构造对称模型，输出逐字等价，测试有显式等价断言）。
  - `A_SHARE_COST_MODEL`：佣金万 2.5 双边 + **印花税万 5 仅卖出**（closeRate = 0.00075）+ 最低佣金 5 元 + **二次方市场冲击系数 0.1**（qlib Exchange 推荐值）；`strategy.costModel = 'a_share'` 一键启用。
  - **二次方市场冲击**（qlib Exchange：`adj_cost_ratio = impact_cost × (trade_val/total_vol)²`）：`marketImpactCost = impactCost × (成交额/当日成交量)²`，逐笔计入 commission 字段；系数缺省/≤0 或成交量无效返回 0。
  - 引擎签名 `runBacktest(data, strategy, costModelOverride?)` 向后兼容（第三参数可选），所有既有调用方零改动。
- 前端量化页「成本模型」下拉（自定义佣金 / A 股真实费率），选 A 股时提交 `costModel:'a_share'` 且佣金率输入禁用。
- **测试行情构造教训**：均线交叉要产生「金叉买入 + 死叉卖出」，数据必须是「走平 → 上涨 → 回落」（flat 段让 MA5==MA20，随后上涨突破触发金叉）；纯单调上涨只有金叉无死叉（测试首版因此 `sells.length===0` 失败）。市场冲击在测试行情（volume=100 万）下影响 ~0.1 元/笔、round 后不可见 → 用低成交量行情（2 万）放大差异断言。

### 4. T+1 信号延迟成交（backtrader Market 单 / qlib shift=1 语义）

- 三报告一致结论：**信号 T 日生成、T+1 日成交**（backtrader Market 单用下一根 bar 开盘价；qlib `shift=1` 取前一 bar 信号）。原引擎「收盘决策 + 同收盘价即时成交」虽无信息泄漏（收盘价当日已知），但现实中收盘后才可下单、只能次日成交——口径不可实现。
- 落地：`backtestEngine` 主循环引入 `pending: 'buy' | 'sell' | null`：T 日收盘用 `bar.close` 算信号（MA 前缀和不变），T+1 日 **`bar.open`**（× (1±滑点)）成交；数据末 bar 生成的信号丢弃（无下一根）。
- 权益记录在信号日（含未成交 pending），成交发生在次一 bar——与真实世界「持仓从成交日起算」一致。
- 测试：买入/卖出均断言「成交日 = 信号日 + 1、成交价 = 次一 bar open × (1±滑点)」；构造「仅末 bar 金叉」行情验证 tradeCount=0。测试内复制 5 行 SMA 计算用于定位信号日（引擎内部 maAt 不可见）。

### 5. 每日截面 IC 序列（qlib calc_ic / ICIR 口径）

- qlib 把「IC」定义为**按日截面计算**：`calc_ic(pred, label)` 每日 Pearson/Spearman → IC 序列 → `ICIR = IC.mean()/IC.std()`。原 `validateFactorModel` 把面板全部样本混入一个秩相关——**跨期秩混合**会把日内同序的强因子 IC 拉低（测试演示：日内 IC=+1 的因子在跨期混合口径下仅 ~0.7）。
- 落地：`FactorPanelRow.date?`（要求每行都有才启用）→ 按日期分组，组内 ≥2 样本算当日 Spearman IC → `icSeries` 多截面路径自动走 `selectOptimalFactors` 的 |IR| 加权（即 ICIR 加权）；`perFactor.icir` 字段（多截面时）。
- 无 `date` 保持全样本单 IC 兼容；`FactorPanelRow` 目前无生产调用方（仅测试/优化器），此改造为将来接入真实多股票面板数据（如东财 RPT 面板）铺路。

### 6. backtrader 完整报告其余可借鉴项（后续路径，已评估未实施）

backtrader 主循环事实：Cerebro 只做组装与广播，**撮合真相在 Broker**（订单 9 态状态机 + `OrderExecutionBit` 部分成交累加 + `clone()` 快照通知），策略/分析器只消费快照；佣金/滑点/成交量约束（Filler）/撮合时序（coo/coc）全部可注入；事件/向量双模式共用一套 Line+游标代码。

- **订单状态机 + 执行位**（paperTrading 增强）：`OrderStatus 9 态 + ExecutionBit[] 部分成交 + clone() 快照通知`，撮合只 push bit + 迁移状态，通知由 broker 统一出队——为挂单（limit/stop）预留。
- **Broker 接口 + A 股规则插槽（一次实现、回测/模拟盘双复用）**：`FillRule（整手/成交量）/ MatchGate（涨跌停拒单）/ Slippage / CommissionScheme(带方向)` 组合注入；paperTrading 现有 A 股撮合（T+1/涨跌停/整手/佣金印花税）可抽成 `cnRules` 包与 backtestEngine 共用。**当前成本模型参数化（costModel.ts）已覆盖 CommissionScheme 方向性部分**；撮合接口统一属结构性重构，留待撮合扩展需求出现时再做。
- **Line 统一抽象 + 游标**（`sma.get(0)/get(-1)`，事件/向量双模式共用）：当前回测与模拟盘无共享策略代码需求，暂不引入。
- **组装式引擎 + 参数寻优**：单函数 → `BacktestEngine` 类（add* 声明式 + optStrategy 笛卡尔积并行）；现有 factorOptimizer 已承担参数扫描职责，暂不重构。

### 7. 精度与测试口径教训

- 引擎对 analyzer 输出 round 2 位 → 一致性测试断言须同口径（`round(stats.X) === r.X`），不能直接比原始 double。
- `totalVol` 与 components 各自 round 后累计误差可达 0.01 → 高暴露系统占比断言用容差 `<= 0.02`。
- 交易记录 `price` 保留 2 位，费用按未舍入价计算 → 反推费用断言用 `toBeCloseTo(..., 1)`。
- TS 严格模式：`??` 表达式不收窄原变量（`TS18048`），可选嵌套字段先提局部变量再判 `!== undefined`。
- 验证：889 tests（+38 新增）/ E2E 9/9 / 双端 tsc / lint / format:check / build 全过；真实浏览器验证 600519 风险归因区渲染 0 pageerror。

## 2026-08-14 性能与体验极致化记录

- **前端首屏 -65%**（~295KB → ~107KB gzip）：
  - `ChartsSection` 改为 `React.lazy`（分析结果出现才加载）——echarts 运行时不再进首屏 modulepreload；
  - **`WatchlistPage` 是最后一个静态 import 的页面**（→ NewsPostureHeatBar → EChart → echarts），同样懒加载后 echarts-vendor（195.57KB gzip）彻底移出首屏，成为按需 chunk；
  - 图表区加轻量 fallback（`.charts-suspense`，替代全屏 LoadingScreen）。
- **EChart 重绘防抖**：App 的滚动监听高频 setState → 父组件重渲染会重建 option 对象 → 原 `[option]` 引用比较反复触发全量 `setOption`。改为 **JSON 内容级比较**（option 为纯数据，序列化微秒级），滚动/无关重渲染不再重绘图表；内容变化仍增量更新。新增用例验证"同内容不重复 setOption"。
- **后端管线并行化**：`getData`（行情/财务/估值）与 `extractNewsSignal`（新闻情绪）原本串行——两者都只依赖股票代码，改为 `Promise.all` 并行，省一个网络往返（新闻限时 3s 不阻塞）。8 位专家本已并行（`analysisPipeline` 内 Promise.all）。
- **移动端 tab 溢出修复**：7 个 tab 在窄屏横向滚动（`overflow-x: auto` + 隐藏滚动条 + tab 不收缩）。
- **历史快照提示条**：回看历史时研究页顶部显示"正在查看历史快照（非实时分析）"提示（`viewingHistory` 状态，新分析开始即清除），避免用户误以为历史数据是实时结果。
- **构建产物清理**：`client/vite.config.ts` 的 `build.emptyOutDir` 恢复为 `true`（沙箱安全删除守卫已不在，恢复 Vite 默认清理，dist 不再堆积旧产物）。
- **验证**：825 tests 全绿 / client build OK（首屏无 echarts modulepreload）/ E2E 9/9 / 双端 tsc / lint / format:check 全过。
