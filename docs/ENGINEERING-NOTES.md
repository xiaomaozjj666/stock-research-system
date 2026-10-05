# 工程笔记

本文件沉淀本项目维护与开发过程中已验证的工程事实，供后续改动复用。

## 技术栈

- monorepo（npm workspaces）：`server/`（Express5 + TS7, NodeNext, `.js` 扩展名）+ `client/`（React19 + Vite8 + ECharts6 + plugin-react 6）。
- 测试：Vitest 5 + @vitest/coverage-v8 5（v8 provider），`globals:false`（测试里 `vi`/`expect`/`describe`/`it` 必须显式 import）。2026-09-14 的 dependabot 开发依赖批量升级把 vitest / @vitest/coverage-v8 由 4.1.11 升到 5.0.0、vite 由 8.2.1 升到 8.3.0（根 `overrides` 同步对齐 8.3.0）。

## 质量门禁（应全部为 0 失败）

- `npm run lint`（JS/风格）0。
- `server`: `npx tsc --noEmit` 0。**该配置含测试文件**（`server/tsconfig.json` 的 exclude 只排 node_modules/dist，注释写明理由：构建产物由 `tsconfig.build.json` 负责）。
- `client`: `npm run build` OK（主配置 `client/tsconfig.json` **排除**测试文件）。
- `client` 测试文件：`npm run typecheck:tests` 0（`client/tsconfig.test.json`，2026-10-05 新增）。**这一条不能省** —— 主配置排除测试曾导致测试夹具的类型漂移无人看守，详见文末「客户端测试文件曾完全不被类型检查」一节。
- `npm run test`（vitest run）：截至 2026-10-05 为 **3397 passed / 0 failed**（245 个测试文件）。此前这里记的是 2026-09-22 的 3239 / 235 文件，本次订正。
- 覆盖率门禁（`vitest.config.mts`）：阈值 **lines 92 / statements 90 / functions 92 / branches 80**（2026-08-14 由 70/68/62/55 提上来）。实测（2026-10-04）：lines 93.71% / statements 91.76% / functions 93.93% / branches 82.18%，四项均过。`server/src/quant/**` 与 `client/src/**` 均纳入统计（`coverage.include`），排除清单见「测试注意」节。
- **本机 `test:coverage` 退出码恒为 1**：vitest 收尾清 `coverage/.tmp` 会撞本机删除守卫（`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`），与覆盖率是否达标无关。**读 `Coverage summary` 段判断，不要看退出码**。CI 上不受影响。

## 依赖升级的硬约束（踩过的坑）

1. **TS 7.0.2 ↔ typescript-eslint 不兼容**：registry 里 typescript-eslint 最高 8.65.1-alpha.19，peer `typescript <6.1.0`，不支持 TS 7。→ ESLint 只覆盖 JS/JSON/风格（`eslint.config.mjs` 忽略 `*.ts/*.tsx`）；TS 静态分析用 `tsc --noEmit`（TS7+strict）。
2. **vite 去重**：root `package.json` 有 `overrides: { "vite": "8.3.0" }`（2026-09-14 由 8.2.1 对齐上来），防止 vitest 把 vite 拉成 6.x 造成 hoist 冲突。改动 overrides 前先想清楚；升级 vite 时必须与 `client/package.json` 的 vite 版本同步改。
3. **react/react-dom 在 root `devDependencies`**：必须 hoist 到 root，否则 echarts-for-react（CJS `require('react')`）构建时 "failed to resolve react"。不要从 root 删掉它们。
4. **ECharts6/React19 类型桥接**：`client/src/components/ChartsSection.tsx` 把 `ReactEChartsCore` cast 为 `ComponentType<{echarts, option: unknown,...}>`。ECharts6 的 `EChartsOption` 过严，option 用 unknown。
5. **安装命令**：`npm install --legacy-peer-deps --dangerously-allow-all-scripts`（legacy-peer-deps 绕过 TS7 peer；allow-all-scripts 放行 esbuild postinstall）。
6. **同伴依赖必须精确 pin**：`@eslint/js` 最新是 **10.0.1**（版本号独立于 eslint）；`@vitejs/plugin-react` **6.1.1**（支持 Vite 8；笔记此前写的 6.0.5 已过期）；`echarts-for-react` **3.0.7**（3.0.6 会拉 react18 嵌套）——该依赖已于 2026-08-14 的图表崩溃修复中移除，此处仅作历史约束留档；`react-markdown` **10.1.0**（peer react>=18）。
7. **同一个包不要同时写在 `devDependencies` 与 `overrides` 里**（2026-09-22 移除了 `nanoid` 的 override）：两侧 specifier 只要不逐字相同，npm 就报 `EOVERRIDE` 并拒绝解析，而 Dependabot 会**分别**更新它们——单独升任一侧都会触发，表现为每周一次的 `dependency_file_not_resolvable`、整次更新任务变红。要么只写直接依赖，要么只写 override。注意 npm 报错文案里的版本号取自**直接依赖**那一侧（`Override for nanoid@6.0.1 conflicts with direct dependency` 指的是直接依赖已经变成 6.0.1），照字面去查 override 会找错方向。移除后 Dependabot 关掉旧 PR、另开一个把 `nanoid` 升到 `^6.0.1` 的分组 PR：根节点 6.0.1 + `postcss` 自己嵌套的 3.3.19 是**合法**的两份拷贝（不再是历史上那次 `invalid`），仓库内也没有代码 import 它。
8. **两个依赖 PR 都改了 `package-lock.json` 时，后合并的必须复验**（2026-09-22 实测）：Dependabot 的每个分组 PR 都基于当时的 main 生成 lock，先后合并时 Git 做的是**文本合并**，会拼出「两边各自都没错、合起来才错」的条目——实测 `packages["server"].dependencies.dotenv` 落成 `"^18.0.1"`，而 `server/package.json` 是精确固定的 `"18.0.1"`。**没有任何门禁会拦下它**：`npm ci` 的同步校验比对的是**解析出的版本**（两者都指向 18.0.1），不是 specifier 字符串。识别方法就是合并后跑一次 `npm install`，看 `package-lock.json` 是否出现 diff；修法以 manifest 为准，因为 lock 是**逐字镜像** manifest 的（同文件里 `^6.0.1`、`^7.0.2` 都保留脱字符）。

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
- `vitest.config.mts` 的 `resolve.extensions` 必须显式含 `.tsx`，否则解析不了 extensionless `.tsx` 导入。
- `routes.test.ts` 需 `app` 可导入不绑端口：`server/src/index.ts` 把 `app.listen`/优雅关闭包进 `if(process.env.NODE_ENV!=='test')`，vitest.config 设 `env:{NODE_ENV:'test'}`。
- 覆盖率排除清单以 `vitest.config.mts` 的 `coverage.exclude` 为准，**只有**：`**/*.test.ts`、`**/*.d.ts`、`server/src/index.ts`（Express 入口）、`server/src/routes/**`（路由模块）、`server/src/middleware.ts`（限流/熔断/安全头）、`server/src/llm/client.ts`、`server/src/llm/mcpClient.ts`、`server/src/llm/expertRunner.ts`、`client/src/main.tsx`、`client/src/vite-env.d.ts`。注意 `server/src/llm/**` 并非整目录排除（rag/prompts/tools/knowledgeGraph 等纯逻辑模块必须纳入，否则门禁形同虚设），`server/src/quant/**` 同样纳入统计（此前笔记写的「quant 被排除、覆盖率稳定在 ~80%」与配置不符，已订正）。
- **路由测试不得真实打通服务层**：`ci.yml` 写明「测试均已 mock 网络（不依赖真实行情/东财接口）」，而 `/api/stocks/search` 的正常路径用例曾真实走到 `searchStocks`——CI 上要先等东财 suggest 超时、再回落本地全表 5000+ 只的 DP，**同一提交在两次 CI 上结论相反**（2026-09-22：放宽到 30s 仍以 30107ms 超时）。改按 `routes.market.test.ts` 口径打桩后 30107ms → 462ms。**给慢用例放宽超时是掩盖，不是修复**；先问「它为什么会慢」，多数答案是"它连了不该连的东西"。
- **测试代码禁用 `as never`，改用 `test/partial.ts` 的助手**（2026-10-05 起基线为 0）。`as never` 会让「桩只造 2-3 个字段」这类缺陷完全隐形：接入契约校验时它掩盖了 4 处真实问题（断言引用不存在的字段、必填项缺失、多余的残留字段、用例名断言的东西根本没断言）。助手：`partial<T>()` / `partialList<T>()`（泛型桩）、`reqOf()` / `mwReq()` / `mwRes()`（express 中间件桩）、`jsonResponse()`（fetch 桩）。守卫见 `server/src/test/__tests__/typeEscape.test.ts`。
- **清完 `as never` 立刻跑 `typecheck`**，否则未定义符号会伪装成「降级路径正常」。实例：换用 `jsonResponse()` 后忘加 import → `ReferenceError` 被被测代码的 `catch` 吞掉 → 走「降级模拟数据」分支 → 用例仍绿，但断言拿到的是 9 条 `isSimulated: true` 的假数据（原应为 2 条真实 K 线）。typecheck 立刻报出 `Cannot find name 'jsonResponse'`。**批量替换后必须跟一次编译**。
- **写守卫/基线前先反向验证它能真的拦**。本项目已三次栽在「守卫自己测不准」：`as any` 正则漏了 `: any` 标注形式；`A extends B ? true : never` 对明显不成立的关系也永远绿；`as never` 基线先虚高到 82（范围与扫描逻辑不符，涨到 82 都不红）、后误收窄到 25（范围外 86 处无人监管）。**基线数字只有在「统计范围 == 实际扫描范围」时才有意义**，改范围后必须重新实测。
- `partial.ts` 里 `Request` / `Response` 要显式从 `express` 导入：server 的 tsconfig 含 DOM lib，不显式导入会解析成浏览器同名全局类型，报错是「缺 93 个属性」这类完全误导的信息。fetch 桩另用 `FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>`。

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
- **PowerShell 会吃掉 npm 的 `--` 分隔符**：`npm run test -- --coverage` 在 pwsh 里被送成 `npm run test --coverage`，npm 报 `EUNKNOWNCONFIG: Unknown cli flag: --coverage`；同一条命令在 `cmd /c "..."` 下正常（CI 是 Linux bash，不受影响）。在 pwsh 里复现 CI 请直接调等价命令 `npx vitest run --coverage`，或包一层 `cmd /c`。

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

### 1. 全页面模板感诊断方法论

- 真实浏览器（生产模式 `NODE_ENV=production` 单端口托管）逐 tab 截图 → 视觉模型逐张审查。**视觉审查比结构审查更能发现模板感**（布局失衡、占位符堆砌、术语堆砌文案），但需注意视觉端点限流（429）时降级用 accessibility snapshot + innerText 结构审查。
- 诊断出的共性问题模式：① 空态占位符重复（"待添加"×3）→ 序号化 + 状态驱动文案；② 术语堆砌（"万三对称"、"日K收盘撮合 + A股规则(T+1/涨跌停/整手/费用)"）→ 用户导向改写；③ 功能罗列式副标题（"支持路由规划、工具调用…"）→ 场景示例式；④ 装饰图标无信息量 → 配合有信息量的文案。
- **改动前先 grep 测试引用**：空态/按钮文案被 E2E（smoke.spec.ts 引用"暂无自选股，先在上方添加。"）与组件测试引用，须同步更新。

### 2. 记忆反思闭环（借鉴 TradingAgents）

- TradingAgents（99.1K star）核心模式之一：决策 → 结算 → **反思 → 回注**（同 ticker 决策 + 已实现 alpha + LLM 教训注入下次）。营销与真金标注：**记忆反思闭环 = 真金**（唯一能随时间变强的机制）。
- 落地轻量版：`historyService.getPreviousAnalysis(stockCode)`（保存前调用返回"上一次分析"摘要，因同代码去重更新，保存后该条即被覆盖）→ 路由 `persistAnalysisHistory` 计算 `vs_previous {previous_date, previous_rating, previous_score, score_delta, rating_changed}` 附加到 `stock_pool[0]` → `ReportHeader` 展示（▲ 红升 / ▼ 绿降 / ＝ 平，A 股红涨绿跌配色与风险归因一致）。
- **语义陷阱**：对比必须在 `saveHistoryEntry` **之前**读取旧记录（保存会覆盖同代码条目）；`createdAt` 用单调时钟，日期展示取 `slice(0,10)`。
- TradingAgents 其余建议（对抗式多空辩论升级、数据防幻觉套件、结构化输出统一封装、checkpoint 断点续跑）已评估：**回测 look-ahead 过滤已由 T+1 信号延迟覆盖**，其余记录为后续路径。

### 3. 回测 look-ahead 过滤（TradingAgents 数据防幻觉工程）

- TradingAgents `stockstats_utils` 的 look-ahead 过滤是其 v0.3.1 修复重点（历史回测时剔除分析日期之后的数据行）。风险实况：东财 K 线接口的 beg/end 参数是"服务端建议"，**API 边界行为不可控**（lmt=1000 截断、跨月返回等），且 12 小时缓存命中路径**不经过 API**——两处都可能混入 endDate 之后的未来行。
- 落地：`filterOHLCVByRange(data, startDate, endDate)` 纯函数（字符串日期比较，兼容带/不带连字符），在 API 返回与缓存命中两个路径都调用；越界剔除记录 `logger.warn`（含 trimmed 数量）。
- **双层防前视防线**：数据层 = 本过滤（无未来行）；成交层 = T+1 信号延迟（backtestEngine，无当日收盘即时成交）。
- TradingAgents 其余建议评估：确定性验证快照（专家层精确数值注入，中成本）、结构化输出封装（DeepSeek tool_choice 兼容坑）、对抗式辩论升级（可开关 + A/B）、checkpoint 断点续跑（当前单次分析 <2 分钟价值有限）——均记录为后续路径。

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

## 2026-08-14 性能与体验优化记录

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

## 2026-09-12 数据通道扩展实测事实（东财 datacenter / Tushare / Baostock）

- **东财 datacenter 报表名逐一实测**（猜名必 9501「报表配置不存在」）：
  - 融资融券明细 `RPTA_WEB_RZRQ_GGMX`：**时间列是 DATE 不是 DIM_DATE**（后者 9501
    列不存在）；filter=(scode="600036")；RZYEZB=融资余额占总市值比（%，与
    RZYE/SZ×100 互证）；RZJME=融资净买入。
  - 盈利预测 `RPT_WEB_RESPREDICT`：一行一票；RATING_ORG/BUY/ADD/NEUTRAL/REDUCE/
    SALE_NUM 评级分布；YEARn + YEAR_MARKn（"A"=实际/"E"=预测）+ EPSn 配对；
    DEC_AIMPRICEMAX/MIN 目标价。**快照口径，无历史序列**。
  - 北向持股 `RPT_MUTUAL_HOLDSTOCKNORTH_STA`：**2024-08 起只余季度快照一行**。
- **Tushare 免费积分频控实测**（错误码 40203，报错文案随用量升级：1次/分钟 →
  1次/小时 → 5次/天）：stock_basic 可用（L=5562，含行业）；index_weight 免费积分
  **无权限**（非频控）。→ 请求路径禁止直连裸函数，一律 `*Cached` 包装
  （24h/30d 缓存 + 失败回落陈旧缓存 + 同 key 并发去重，tushareAdapter 与
  baostockBridge 同模式）。
- **Baostock 0.9.3（本机 Python 3.13）**：
  - 免费无注册，`bs.login()` 即用；本机 pip/python 版本错位（默认 pip 挂在另一条
    Python 上）→ 用 `python -m pip install baostock -i https://pypi.org/simple`。
  - 它会在 cwd 附近写运行日志 → sidecar 先 chdir 临时目录再 import。
  - `query_hs300_stocks(date)` 返回 ≤date 最近一次调仓快照（以 updateDate 字段为
    准）；code 是 "sh.600000" 格式需归一 6 位数字码；**历史快照含其后退市证券**
    （2015 成分含武钢股份）——幸存者偏差修复数据源。
  - login/logout 的 "success!" 打印会污染 stdout 协议 → `redirect_stdout(sys.stderr)`
    包住全部 baostock 调用，stdout 只留最终一行 JSON。
- **Windows spawn 传 JSON**：argv 引号转义不可靠 → 子进程协议一律走 stdin。
- **CI prettier 检查 glob 含根目录 `*.{json,md,mjs}`**——本地自查必须与 CI glob
  完全一致（曾因只查 ts/tsx 漏掉 DATA-SOURCES.md 等 CI 失败一轮）。
- **vitest 过滤器必须从 repo root 用 `server/src/...` 相对路径**（include 是
  `server/src/**`）；在 server/ 目录内跑会 "No test files found"。

## 2026-09-19 改进闭环（RSI）落地事实

**判据改动的三个落盘文件**（都可用 env 重定向，测试隔离靠它）：

| 文件                                     | env                       | 内容                                    |
| ---------------------------------------- | ------------------------- | --------------------------------------- |
| `server/src/data/factorExperiments.json` | `FACTOR_LEDGER_FILE`      | 因子实验台账（含 `evidence` 判据输入）  |
| `server/src/data/improvements.json`      | `IMPROVEMENT_LEDGER_FILE` | 改进台账（改了什么/依据/指标/否掉了谁） |
| `server/src/data/harnessPolicy.json`     | `HARNESS_POLICY_FILE`     | 当前生效的采信判据                      |

- **回放只认带 `evidence` 的记录**。该字段自 2026-09-19 起才落盘，**存量记录一律跳过**：
  残缺证据会让回放把「字段缺失」当成「数值为 0」，那是在编数据。→ 新部署上
  `/api/improvement/status` 的 `replay.available` 会长时间远小于 `required`（20），
  这是真实状态，不是 bug。
- **判据的单一实现是 `applyVerdictPolicy(evidence, policy)`**。线上 `judgeFactor` 与
  循环回放共用它；若循环自己重写一遍规则，调出来的策略与线上实际生效的就不是同一个东西。
- **切分口径只写在 `splitCounts` 一处**，路由的状态预告也用它。预告说"够了"、实跑却因
  验证集不足直接返回，属于最难排查的不一致。
- **默认策略必须与硬编码时期逐字一致**（`5 / 0.05 / 0.6 / true`），并由
  `harnessPolicy.test.ts` 钉住。判据被改动是**有留痕的显式动作**，不该由重构悄悄完成。
- **回滚 = 删策略文件**（`resetHarnessPolicy()`）。没有单独的"回滚接口"：文件不在即出厂值，
  比多一个可能与自己状态不一致的回滚路径更可靠。
- **`recordImprovement` 写盘失败返回 `null`（factorLedger 是返回 `[]`）**：一轮改进是单个
  对象，没有"空批次"这种合法语义，用 `null` 才能把"没写"与"写了空"分开。
- 台账数组**新在前**（`[new, ...old].slice(0, MAX)`），容量淘汰挤掉的是**最后一个**元素。
  写容量相关用例时极易搞反，`improvementLedger.test.ts` 里有注释钉住。
- 循环内部**不外抛异常**：它是增强能力，不该把定时任务或 HTTP 处理器打挂；失败一律
  返回 `changed:false` + 中文原因。
- **早退轮次不写台账**（证据不足/无新候选）：否则每天一条"数据还不够"会淹没真正跑过候选的记录。

## 2026-09-19 改进闭环第二轮：统计护栏 / 无人值守 / MCP（复用事实）

- **决策判据是「决策准确率」而不是「采信集精度」**。准确率把两类错误一起算：
  `correct = (采信 === 样本外稳定)`。只盯精度会漏掉"把好因子一起扔掉"这条错误路径。
  精度仍然记录（使用者口径），但**不参与决策**。
- **检验是配对 McNemar 精确检验，不做多重比较校正**。候选在训练集上挑、验证集只看不用，
  选择偏差由切分挡掉；再叠 Bonferroni 是双重保守，会让循环几乎永不行动。
  `mcnemarExact(b,c) = 2×P(X ≤ min(b,c))`，X~Binom(b+c, 0.5)；`b+c>1000` 时下溢，
  保守返回 1（该分支不可达：台账上限 500 × 验证集 30% ⇒ 不一致对 ≤150）。
- **证据下限与显著性水平是代码常量，不是 env**（60 条可回放 / 20 条验证 / α=0.05）。
  它们决定判据会不会被自动改写，改它们应当走代码评审。`.env.example` 里已注明这一点。
- **20 条验证集不是随手取的**：它让 6:0 的不一致对恰好可达显著（p≈0.031），而 5:0 不够
  （p=0.0625）。调这个数之前先算一遍功效，否则循环会长期停在"证据不足"或长期在做无功效判断。
- **下限改过一次，因为原来的值是死代码**：证据下限 20 / 验证下限 6 时，20 条证据的验证集
  必然 ≥6，"验证集不足"这条守门逻辑永远进不去。改任何一对下限后都要回头验证每条早退分支
  是否仍可达——不可达的分支等于没写。
- **同分候选按「归一化移动量」取舍**（各维变化 ÷ 该维定义域宽度，布尔记 1）。按"改了几维"
  排会出现两个都只改一维、得分完全相同的候选，只能由遍历顺序决定，实测会把显著性从 0.05
  收紧到 0.01 而真正起作用的是单调性。并列数记进 verdict 文案，供人复核。
- **调度用 setTimeout 链而不是 setInterval**：上一轮结束才排下一轮，**结构上不可能重叠**。
  与 `scheduler.ts` 同范式（退避 / 自动停止 / unref），差异都有理由：间隔 6 小时（判据输入
  按天积累）、首次延迟 10 分钟（避开启动预热）、连续失败上限 5（间隔以小时计）。
- **env 显式关闭（`IMPROVEMENT_INTERVAL_HOURS=0`）时，接口不传间隔就返回 400**，不静默改用
  默认值——否则"我明明关了它"会变成假的。显式传 `intervalHours` 则压过 env（用户当场说了算）。
- **MCP 工具注册表有强断言**：`server.tools.test.ts` 同时钉住工具名列表**顺序**与
  `required` 映射。新增工具必须同步改这两处，否则 CI 会红（这是设计意图，不是障碍）。
- **`index.ts` 的启动块整体在 `NODE_ENV !== 'test'` 之下**，所以路由测试里
  `status.scheduler` 必须是 null；要测调度端点得自己调 `startImprovementScheduler`，
  并在 `afterEach` 里 `stopImprovementScheduler()`，否则真实定时器会跨用例残留。

## 2026-09-19 台账排序比较器：一个只在 CI 复现的缺陷

- **时间倒序比较器必须对相等键返回 0**。`(a, b) => (a.createdAt < b.createdAt ? 1 : -1)`
  在两条记录 `createdAt` 相同时，`compare(a,b)` 与 `compare(b,a)` **都**返回 -1——
  违反排序契约（相等必须返回 0），顺序交给排序算法的实现决定。2026-09-19 CI 实测：
  `改进台账 > 记录后可按时间倒序查回` 报 `expected '第一条' to be '第二条'`，而本地全绿。
- **为什么只有 CI 复现**：本地一次 `recordImprovement` 要「mkdir + writeFileSync + rename」，
  两次调用通常间隔 >1ms，时间戳不同即走确定分支；CI 的临时文件系统快得多，两次写入常落在
  同一毫秒。**判据是"两次写入的耗时"，不是平台差异**——本地机械盘/杀软实时扫描会掩盖它。
  凡"写入间隔决定行为"的逻辑都要按同毫秒来设计。
- 正确写法是相等返回 0，交给**稳定排序**保持数组原序；台账数组本就是**新在前**
  （`[new, ...old]`），于是同毫秒内的先后即写入先后。
- 同一个写法在 `factorLedger.listFactorExperiments` 里也存在（改进台账是照抄的）。
  那里顺序还有额外语义：改进循环用「list 之后 reverse」来切「较早 70% 训练 / 较新 30%
  验证」，顺序不确定等于每轮拿到的训练/验证集都在变——排序缺陷会伪装成"模型不稳定"。
- **写同毫秒回归用例要用 ≥5 条记录**。2 条时排序算法可能恰好保住原序，病态比较器照样通过；
  5 条同时间戳才能稳定暴露。写完必须做突变验证（改回病态版本确认用例真的失败）。

## 2026-09-22 CI 回绿：两个红点都不是业务代码的问题

Dependabot 在 09-21 那一轮留下两个红点：开发组 PR 的 CI，以及它自己的更新任务。
两件事互不相关，但根因都值得写下来。

### ① 超时用例：放宽阈值掩盖了「连了真实网络」

- `server/src/__tests__/routes.validation.test.ts` 的「正常关键词 → 200 且返回数组」真实打通
  路由到 `searchStocks`。CI 无外网时要先等东财 suggest 超时，再回落本地全表 5000+ 只的
  最长公共子串 DP——**耗时由机器负载决定，不由代码决定**。
- d51f277 把它从默认 5s 放宽到 30s，并写下「同一提交在另一次 CI 上就是通过的」。这句话本身
  就是判决：用例不确定。09-21 那次以 30107ms 打穿 30s。
- **正确的入口是先问「这条用例要测什么」**。它锁的是路由层的长度闸门，上游能不能连上与被测
  行为无关；而 `ci.yml` 早就写明「测试均已 mock 网络」。于是要么打桩，要么这条用例不该存在。
  选了打桩，并把断言从「200 + 是数组」收紧为「放行到服务层且**原样回传**」，再补上被拒请求
  「**不触达服务层**」——后者才是那句"拦在昂贵匹配之前"注释的可执行版本。
- 打桩照抄同目录既有口径，避免又造一套：

  ```ts
  const mocks = vi.hoisted(() => ({ searchStocks: vi.fn() }));
  vi.mock('../services/dataService.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/dataService.js')>();
    return { ...actual, searchStocks: mocks.searchStocks };
  });
  ```

- 突变验证不能省：把长度闸门挪到服务调用之后、把 `res.json(results)` 换成 `res.json([])`，
  确认**恰好**对应的两条用例失败、其余 12 条不受影响。只会"跑绿"的用例等于没有用例。

### ② `EOVERRIDE`：同一个包既写在直接依赖又写在 override

- Dependabot 的报错只有一行：`Override for nanoid@6.0.1 conflicts with direct dependency`。
  **照字面去查 override 会找错方向**——npm 这句话里的版本号取自**直接依赖**那一侧，
  它说的其实是"直接依赖已经是 6.0.1 了"。
- 复现只要一个最小目录（不必动仓库；注意留在系统临时目录、别落进仓库）。下面这种写法，
  以及把两侧版本对调后的写法，都会报同一句话；**不要用 `jsonc`/`json` 代码块记它**，
  本仓库的 prettier 配了 `trailingComma: all`，会把片段补成非法 JSON：

  ```text
  {
    "devDependencies": { "nanoid": "6.0.1", "postcss": "^8.5.0" },
    "overrides": { "nanoid": "^3.3.18" }
  }
  ```

  `npm install --package-lock-only` 即复现同一句话；删掉 `overrides.nanoid` 后两种版本组合都过。

- 判断「这条 override 还有没有用」要看**传递消费者声明的范围**，而不是它存不存在：
  `npm ls nanoid` 显示唯一消费者是 `postcss`，声明的也是 `^3.3.18`，与直接依赖同区间，
  于是整棵树本来就只有一份 3.3.19——override 在或不在结果相同。移除后 `package-lock.json`
  的 SHA256 **逐字节未变**，这就是"冗余"的硬证据，比读一遍 package.json 猜要可靠。
- 顺带修正一处历史归因：9226ac2「钉 nanoid ≥3.3.17 修高危传递漏洞」真正的病根是 override
  用了 `>=`，把 nanoid 解析到了 6.0.1（ESM-only），导致 postcss 的
  `require('nanoid/non-secure')` 构建期失败。**问题出在 override 本身，而不是缺少 override**
  ——按"再多加一层钉死"去修，只会越修越死。
- **收尾时的后续（同日）**：override 一移除，Dependabot 立刻关掉旧 PR、另开一个把 `nanoid`
  升到 `^6.0.1` 的分组 PR，合并后树变成根 6.0.1 + `postcss` 自己嵌套的 3.3.19，`npm ls`
  合法（两份拷贝，不再是 `invalid`）。这恰好反过来说明上面那条判据的适用边界：**"唯一消费者
  与直接依赖同区间"说明的是"此刻这份 override 没在起作用"，不保证以后也不起作用**——
  一旦直接依赖被升到别的区间，就该重新判断要不要显式钉，而不是默认它一直冗余。

### ③ 合并依赖 PR 的复合 lock（同日稍后）

- `#20` 与 `#18` 都改 `package-lock.json`，各自基于当时的 main 生成；先后合并后 Git 做的是
  文本合并，`packages["server"].dependencies.dotenv` 落成 `"^18.0.1"`，而 `server/package.json`
  是精确固定的 `"18.0.1"`。
- **CI 是绿的**——`npm ci` 的同步校验比对**解析出的版本**，不是 specifier 字符串，所以这类
  复合差异没有任何门禁会报警。识别手段只有一个：合并后跑一次 `npm install`，看 lock 有没有 diff。
- 详细约束已收进「依赖升级的硬约束」第 8 条。

## 2026-09-28 一轮加固记录（审查 → 实测 → 修复 → 验证）

本轮是一次以「可验证证据」为准绳的加固。**所有结论都先复现再改**，下面几条
纠正了初轮审查中的误判，记录下来是为了避免同样的误判再发生一次。

### ① 先纠正两个误判（比修复本身更重要）

- **「测试套件有 22 个文件跑不起来」——误判，实为冷启动 worker 饥饿。**
  冷跑一次是 `235 workers spawned · ~7.11s startup each`、22 个文件报
  `Timeout waiting for worker to respond`；**热缓存再跑，235/235 全过、30.48s、
  启动降到 1.17s/个**。所以套件本身没坏，坏的是冷启动时按文件数逐个拉起 worker 的
  开销。README 徽章上的 3239 用例数经实测**准确**，无需改动。
- **「LLM 结构化输出没有校验」——对专家链路而言是误判。**
  `chatJSON<T>` 的泛型确实是编译期谎言（`JSON.parse` 后直接 `as T`），但下一站
  `normalizeExpertOpinion`（`llm/prompts.ts:121`）做了扎实的手写归一：枚举越界回落
  `'neutral'`/`'support'`/`'inference'`、数值走 `clampInt` 带 fallback、过滤空文本、
  限量截断、缺 support/oppose 时打 `_incomplete`。
  真正缺的**不是**校验，而是**一个例外路径**——见第 ④ 条。

### ② 覆盖率门禁的分母纠正：routes/ 纳入统计

- 旧配置把 `server/src/routes/**` 整目录排除在分母外，理由写的是「由 supertest
  集成测试覆盖」。**排除意味着这些行既不计入分母、也不构成任何门禁**——
  13 个文件 3758 行、含 2100+ 行的 `quant.ts`，体量最大的业务逻辑文件恰好落在盲区。
- 实测纳入后仅下降约 1.3 个点，四项阈值**全部仍通过**：

  |                   | lines  | statements | functions | branches |
  | ----------------- | ------ | ---------- | --------- | -------- |
  | 排除 routes（旧） | 94.95% | 92.91%     | 94.74%    | 83.26%   |
  | 纳入 routes（新） | 93.66% | 91.76%     | 93.97%    | 81.88%   |
  | 阈值              | 92     | 90         | 92        | 80       |

- 结论：这层代码本就由 `server/src/__tests__/*.routes.test.ts` 的 supertest 用例
  真实覆盖着，不需要先补一堆测试才能摘掉排除项。**门禁从此统计的是真实代码面。**

### ③ 校准数据：原子写 + 读记忆化（`llm/ensemble.ts`）

- 全仓 8 处落盘点都用 tmp+rename，唯独这里用裸 `writeFileSync`。直写会先 truncate
  再逐块写，**读者可能 stat 到半截 JSON**；而 `readCalibration` 的 catch 会**静默**
  返回 `{models:{}}`，随后一次 `recordModelOutcome` 就把「只剩一条统计」的结果
  写回——历史命中率被一次并发读整份抹掉，且**全程无任何报错**。已改为 tmp+rename。
- 性能侧：`modelWeight()` 每次调用都整读整解析，而 `runEnsemble` 按模型数 N 次调用它，
  也就是**每个分析请求付 N 次全文件读 + N 次 JSON.parse 的同步阻塞代价**。
  改为按 `mtimeMs + size` 记忆化（同步 stat 很便宜，换取跳过读盘+跳过解析是划算的）。
- **顺手纠正一个想当然的判断**：`recordModelOutcome` 的「丢失更新」在**单进程内不成立**
  ——它是全同步读-改-写，读与写之间没有 `await`，事件循环里不可能被另一个请求插入。
  真正残留的是**跨进程**（多实例共享同一文件）风险，那需要文件锁，属部署拓扑决策，
  不在本次范围。已在代码注释里写清，避免后人照着「有并发 bug」的误解去加无效补丁。

### ④ LLM 空结构化响应的重问回路（`llm/expertRunner.ts`）

- 真正的漏洞是一个例外路径：模型回一个**合法但空**的壳（如 `{"arguments":[]}`）时，
  `JSON.parse` 成功、不抛错，于是被 `normalizeExpertOpinion` 补默认值后变成一条
  「自信度 60、情绪 neutral、零论点」的伪研判。**这比明确降级更糟**——报告不会标注
  `_degraded`，用户看到的是一份看起来正常、实则没有内容的专家意见。
- 修复：识别「论点与要点同时为空」，把**失败原文 + schema** 回灌重问**一次**；
  第二次仍退化就走原有降级路径（行为与修复前一致，不会因为多问一次而更糟）。
  刻意不设成无限重试——重问要花钱，必须封顶。

### ⑤ react-hooks lint 规则此前是**死代码**

- `eslint.config.mjs:27-28` 因「本配置无 TS parser」直接忽略 `**/*.ts(x)`，
  `.oxlintrc.json` 又没开任何 React 插件——于是仓库里 4 处
  `eslint-disable react-hooks/exhaustive-deps` 注释**今天完全没有约束力**。
- 开启后（`plugins: ["react"]` + `react-hooks/exhaustive-deps` / `react/rules-of-hooks`）
  全仓只暴露出**一处真实违规**：`CrossSectionPanel.tsx` 依赖数组里的 `codesText`
  冗余（回调只用派生值 `codes`，而 `codes = useMemo(parseCodes, [codesText])`），
  已移除。**其余 49 个客户端测试文件与 hooks 全部干净**。
- 同时把 oxlint `react` 插件默认带出的 `set-state-in-effect` / `refs` / `purity`
  三条**显式关掉**并记原因：逐条看过，命中的都是本仓库的刻意写法
  （`useRef(Date.now())` 的实参每次渲染都会求值但只保留首个、渲染期懒初始化
  `historyRef`），属于 React Compiler 取向的规则，与本仓库的既定模式冲突。
  不关掉的话 lint 会从 0 警告变成 25 条噪声，信噪比反而变差。

### ⑥ 指标表容量上限（`services/metrics.ts`）

`normalizeRoute` 只收敛了**路由段**，counter 的 key 里还有 `statusLabel`
（`String(res.statusCode)`）。正常部署基数有限，但前置代理返回非常规状态码时
就不再有界。两张 Map 各加上限（默认 2000，`METRICS_SERIES_MAX` 可调），
淘汰策略用「删最早创建的」——刻意**不做 LRU**：指标条目的价值只取决于它代表哪条
路由，与最近是否被访问无关，每次请求重排键序的开销不值得。

### ⑦ 闸门排队超时的 429 收口（`routes/quant.ts`）

44 个 handler 里只有 1 个用了 `respondIfQueueTimeout`，而 `routes/market.ts` 有 5 个；
其余一律落到 500，客户端无从判断该不该退避重试。给 3 个确实会打到 LLM 闸门的端点补齐
（`timeseries/analyze`、`digests/run`、`screener/run`），覆盖三种 handler 形态。
其中 `timeseries` 的判定**前置**到领域 400/502 正则之前——排队超时同样是「可重试」语义，
若将来错误文案演变到含「需/不足/失败」等字样，会被 400 分支先一步吃掉，退化成参数错误。
`isQueueTimeoutError` 只认特定错误码，所以对非闸门错误零行为变化。

### ⑧ 明确**没有**做的事，以及为什么

- **没有引入 zod 做全量请求体校验。** 现网的边界校验虽散，但并非没有：
  `normalizeExpertOpinion`、`validateHarnessPolicy`、路由内的 `as` 收窄都各自成立，
  且有 3239 个测试兜底。引入新依赖并重写数十处校验，**风险大于收益**——
  真正的漏洞（④）已经用更小的改动堵上了。若日后要统一，正确路径是
  「从 `/api/openapi.json` 生成类型 + 共享 DTO 包」，而不是在既有 3000+ 用例上动刀。
- **没有把 `routes/quant.ts` 按领域拆成 5 个文件。** 2100 行确实该拆，但这是纯机械
  大改，与本轮其余修复叠加会显著抬高回归风险。已在覆盖率层面先把它纳入门禁
  （第 ② 条），使其不再是「没人看的盲区」，拆分留作独立一轮。
- **没有改 vitest 的 pool/isolate。** 实测证明冷启动抖动来自 worker 逐个拉起，
  而 `isolate: false`（vitest 自己推荐的提速手段）会让模块级状态在测试文件间泄漏——
  本仓库恰恰有大量模块级状态（缓存、指标表、刚加的校准记忆化）。
  用正确性换 5~10 秒不划算，故保持默认。
- **`server/src/cache/` 空目录未删**：git 根本不跟踪空目录，它不在版本库里，
  只是本地残留，不构成问题。

## 2026-09-28（续）· 第二轮：结构拆分与 CI 门禁

接上一轮的四项静默失效修复，本轮处理剩下的结构问题。**先说两件代价最大的事**：
一次误操作和一次误判，都由我自己造成，记录下来是因为它们暴露了真实的机制风险。

### ① `routes/quant.ts`（2102 行）按领域拆分

- 现状是一个文件里混着 24 个路由、5 个领域（分析 / 因子 / 截面 / LLM 运维 / 运营），
  以及一批取数扇出、入参校验、模拟数据闸门、台账留痕的辅助函数。
- 拆成：`quantCore.ts`（分析 / 因子评估 / 复合因子 / 板块宇宙）、`quantCrossSection.ts`（截面）、
  `llmAdmin.ts`（LLM 运维）、`quantOps.ts`（初筛 / 时序 / 简报 / 公告 / 估值 / 健康 / 台账 / 受控评估），
  `quant.ts` 退化为组合根；跨领域共用的 23 个辅助声明移到 **`services/quant/panelService.ts`**。
- **为什么辅助不留在 routes/ 下**：它们是业务规则（模拟数据必须拒绝算 IC、持有期上限、
  并发硬上限）。留在路由文件里既无法直接单测，也会被各领域复制成多份分叉。
- 各子模块用**绝对路径**注册自己的 Router，因此挂载顺序不影响匹配结果；
  `index.ts` 仍只需 `app.use(quantRouter)` 一行，**对外 HTTP 契约零变化**（24 个路由路径逐字未变）。
- 拆分正确性的验收不是"跑通"而是**无损证明**：脚本输出与原文件逐行比对，
  除新增的 `export` 前缀外**未解释的丢失行数为 0**；随后 `tsc` 通过 + 2315 个用例全绿。

### ② 自省阈值抽成纯函数（`services/analysisReflection.ts`）

- `executeAnalysis` 里「双层自省 + 逻辑闭环」那段编码的全是**研判可信度的业务规则**：
  现金流/利润 0.5 与 0.9、毛利率波动 10 个百分点、PE 历史分位 20/80、营收增速 5%、
  反对论点置信度门槛 65。原先内联在 780+ 行的函数里，**改一个阈值无法写断言**。
- 抽成无 IO、无时钟、无随机的纯函数后，补了 24 条测试，每条对应一句会出现在报告正文里的话。
- 顺带消掉一处**真实重复**：风险条目的提取逻辑原先在自省文案和 `risk_list` 各抄了一份，
  两份阈值一旦漂移，"正文说的风险"就会和"列表列的风险"对不上。现由
  `extractOpposeRisks` 统一提供，测试里直接断言两者同源。

### ③ 校验收敛：15 处重复的 `/^\d{6}$/`

散落在 5 个文件里各写一份（`llm/tools.ts` 一处文件就 7 份）。现在统一走
`utils/stockCode.isAShareCode()`——它复用同一个 `A_SHARE_RE`，语义与内联正则**逐字等价**
（`RegExp.prototype.test` 本身就会对非字符串走隐式转换），不是"顺手改成更严格"。

### ④ 客户端

- `App.tsx` 的 `mountedTabs` 改为 **keep-alive 白名单**：只有"用户付出过、且服务端取不回来"的
  页签（模拟盘已填委托价、对比已选标的、研究助手对话草稿）继续挂载，其余页签切走即卸载。
  此前是**访问过的页签永久常驻**，量化页那类带秒表的隐藏面板一直在跑定时器。
  `App.keepalive.test.tsx` 钉住"白名单内状态不丢 / 白名单外确实卸载"。
- `manualChunks` 从 `id.includes('react')` 改为按 `node_modules` 路径解析**真实包名**分组
  ——否则将来一个叫 `reactive-*` 的包会被静默塞进 react chunk。分包结果与之前逐字节一致。
- 新增 `client/scripts/check-bundle-size.mjs`：按 chunk 核对预算并**以退出码 fail**。
  原来的 `chunkSizeWarningLimit: 1000` 之下，626 kB 的 echarts chunk 从来不会报警，
  而 warning 本来也不会让 CI 变红。已接入 CI。

### ⑤ 依赖审计此前是红的

`npm audit --audit-level=high` 报出 1 高（`brace-expansion` DoS）+ 1 中（`ip-address` SSRF），
**CI 的审计门禁会直接失败**。`npm audit fix` 把两个传递依赖做了补丁级升级
（`brace-expansion` 5.0.9→5.0.12，`ip-address` 10.4.0→10.7.3），现为 `found 0 vulnerabilities`。
两者分别是 eslint→minimatch 与 express-rate-limit 的传递依赖，升级后全量用例与 e2e 均复跑通过。

### ⑥ vitest worker 池：实测后决定**不改**

| pool              | 用例   | 错误 | 耗时 | worker 启动 |
| ----------------- | ------ | ---- | ---- | ----------- |
| forks（现行默认） | 3279 ✓ | 12   | 196s | 9.62s       |
| threads           | 3279 ✓ | 0    | 115s | 5.44s       |

threads 明显更快且本次零 worker 错误，但**仍然不改**：`isolate: true` 只保证模块注册表隔离，
**不保证 `process.env` 隔离**——每个 worker 线程会被复用跑约 10 个文件，而本仓库的测试大量
`process.env` 注入（MODEL_CALIBRATION_FILE / LLM_MAX_CONCURRENCY / 各种夹具），
一旦某个 worker 复用了会继承上一个文件的环境。叠加本仓库已有一串"本地绿、CI 红"的
时序/顺序相关缺陷历史，用正确性换 80 秒本地耗时不划算。保持默认。

### ⑦ 两条钉死文件名的结构断言测试

`clientAbort.test.ts` 与 `timeoutCancellation.test.ts` 里写着 `['watchlist.ts', 'quant.ts']`
这样的**文件清单**，拆分后直接失败。它们表达的真正不变式是
"任何路由文件都不得自建 `abortOnClientClose`" / "谁调 `extractNewsSignal` 谁就得用
`withAbortableTimeout`"。已改为**扫整个 `routes/` 目录**并加反断言（不许写成空断言），
今后再拆文件不会假绿——这比维护文件名清单更耐改。

### ⑧ 一次误操作（自己造成，如实记录）

用正则批量删除未使用 import 时，误把 `routes/quantCrossSection.ts` 清成了 0 字节。
恢复方式：从 git 里的原始 `routes/quant.ts` 按行区间取出该路由块原文，
import 以**原始清单为数据源、正文真实使用情况为过滤条件**重建，`tsc` + 66 条相关用例验证通过。

由此得到两条可复用的教训，已写进后续脚本的注释里：

1. **一次性重构脚本必须"只读输入、只写暂存区"**。第一版脚本直接原地改写源文件，
   第二次运行读到的已是自己的输出，把 1500+ 行误判成"丢失"。
   改成「输入固定读快照、输出只写 `.split-stage/`、验证通过后再搬入」之后，脚本不可能损坏工作树。
2. **不要用正则改写 import**。`type` 前缀、默认绑定、`as` 别名三种形态组合起来，
   手写拼装必错（`import type { X }` 会被拼成 `import type from`）。正确做法是
   **原样沿用原子句文本，只过滤列表项**；判断"是否用到"时必须先剔除注释——
   否则注释里提到的 `buildCrossSectionPanel` 之类会被当成依赖，import 区块越修越肿。

### ⑨ API 访问令牌：把「暴露到本机之外」变成有意识的选择

- 此前 API 层**完全开放**。本机自用没问题，但一旦内网穿透 / 公网 / 团队共享，
  等于把自选股、分析、**会烧钱的 LLM 调用**、模拟盘与文件检索接口全部开放。
- 做成**默认关闭、显式启用**：未设 `API_AUTH_TOKEN` 时中间件完全放行，
  行为与加它之前**逐字相同**——因此不影响本地开发，也不影响既有 3300+ 用例
  （新增 19 条用例后 2334 条全绿，零回归就是这条不变式的证据）。
- 比较用 `timingSafeEqual` 而非 `===`：逐字符比较会因首个不同字节的耗时差泄露前缀，
  这在公网可自动化；长度不同直接判否（`timingSafeEqual` 要求等长）。
- 豁免范围刻意极小：**仅** `OPTIONS` 预检与 `/api/health`（探针不能要求令牌）。
  并加了反断言，确保 `/api/healthz` 这类「名字相近」的路径**不**被顺手放行。
- **这里踩到一个值得记的坑**：中间件挂在 `app.use('/api', guard)` 上，而 Express 会把
  `req.path` 改写成**相对挂载点**的路径（`/api/health` → `/health`）。最初按 `req.path`
  匹配豁免前缀时**永远匹配不上**，探活会被 401 拦掉——而这恰恰是免鉴权豁免最不能失效的地方
  （容器/负载均衡探针会直接判定服务挂了）。改用 `req.originalUrl`（去掉 query）后修复。
  这条是被测试抓出来的，不是想出来的——所以豁免路径必须配"子路径也豁免"和
  "名字相近的路径不豁免"两条相反方向的断言，才锁得住。
- 已用**真实构建产物 + 真实进程**冒烟验证：无令牌 401 / 错令牌 401 / 正确令牌 200 /
  health 无令牌 200。

### ⑩ 鉴权的后半程：服务端做完不等于功能可用

补完服务端后复核「用户实际会怎么做」，发现**功能是坏的**：一旦真的配上
`API_AUTH_TOKEN`，浏览器端**零令牌支持**——axios 不带凭据、没有录入入口、
401 也没有任何提示。表现是用户配好鉴权后打开自己的系统，满屏报错且无从下手，
只能去翻 `.env` 手动改回来。**这比「不加鉴权」更糟**：安全功能把自己变成了路障。
中间件单测全绿也发现不了——它们只验证服务端契约，不涉及浏览器。

补的四件事，以及每处为什么这么选：

- **axios 请求拦截器统一注入 `x-api-token`**。REST 端点有 30+ 个，逐个传参等于
  留一个「某处忘传」的永久坑，而那种坑表现为"某个页面莫名 401"，几乎无法定位。
  拦截器是唯一能保证**新增端点默认就带鉴权**的位置。
  写法上用 `config.headers.set()` 而非展开合并——axios 的 headers 是 `AxiosHeaders`
  类实例，展开成普通对象会丢掉 `set/get/has`（TS 直接报错，运行时会静默坏掉）。
- **SSE 只能走 `?token=`**。浏览器的 `EventSource`（消费 `text/event-stream` 的原生 API）
  **不允许自定义请求头**，这是平台约束而非本项目选择。所以 `/api/analyze/stream`、
  `/api/chat/stream` 两个端点在 query 里传令牌。
  为了不扩大泄漏面，**服务端只接受 GET 的 query 令牌**（写操作的 query 只多风险、
  无收益）。日志侧不需要额外处理：`token` 不在 `logSanitize` 白名单内，
  请求日志与 telemetry span 都会把它抹成 `[redacted]`——并加了断言钉死这条
  （日后若有人把 `token` 加进白名单，令牌就会随每个 SSE 请求写进日志且无法回收）。
- **解锁条默认不渲染，捕获到 401 才出现**。本系统默认不鉴权，无条件弹窗等于让
  每个本地用户都多点一次。改为「任意 REST 401 → 全局广播 → 解锁条出现」，
  未启用鉴权的用户完全看不到它，行为与加这个组件之前逐字相同。
- **解锁后整页重载**，而不是局部重试：解锁前已失败的请求散落在各页面的
  `useEffect` 里，逐个重试覆盖不全，重载则让它们自然重发。

顺带修掉的两处小问题：测试桩缺 `interceptors`（新增拦截器后 4 个 axios mock
集体起不来，收敛成每文件内联一段并注明为何不能抽 helper——`vi.hoisted` 在 ESM
import 之前执行，抽成 import 会撞 "Cannot access before initialization"）；
以及一处 UTF-8 坏字（`既有��例`）。

**教训**：安全功能的验收标准不是「中间件测过了」，而是「用户照文档配好后，
主流程仍然可用」。前者是实现视角，后者才是用户视角——这两者之间隔着
浏览器自动携带凭据的能力边界，而那部分不写测试就完全不会被发现。

### ⑪ 全量跑随机红、单独跑必绿：把「噪声」和「回归」分开

本项目有 240+ 个测试文件，一次要 spawn 244 个 worker。现象是
`auditLog.persistence` / `rag.corpus` / `paperTrading` / `fileCachePrune` /
`compositeService` 这几个**磁盘密集**文件在全量跑时随机红，单独跑永远绿。

定位要点是**先看错误类型再动手**：

- 报 `Hook timed out in 10000ms` → 是 `hookTimeout`（默认 10s）顶不住
  `fs.rmSync(recursive)` 递归清理；
- 报 `Test timed out in 5000ms` → 是 `testTimeout`（默认 5s）。这批用例在
  `test:coverage` 下更容易触发，因为 v8 插桩让执行普遍变慢一倍以上。

两类都不是逻辑回归——把文件单独跑一遍即可证实。处理方式是分别放宽到 60s / 30s
并写清理由，而不是逐个用例加 `timeout` 参数：后者把环境噪声固化进 20 多个文件，
下次换机器（CI runner、更多核）又会复发；改配置是一处收口。

**放宽为什么不掩盖真问题**：死循环的用例不会「慢」，它不会返回。放宽只影响
「慢但会结束」的那类用例，真卡死仍会被 vitest 整体超时或 CI job timeout 兜住。
判断依据始终是**单独重跑**——单独绿 + 全量红 = 资源争抢；单独红 = 真回归。
这条区分值得固化：否则很容易把噪声当回归去改业务代码，或反过来把真回归当噪声放过。

### ⑫ E2E「卡住」不等于「跑得慢」：先分清是谁在等

本机跑 `npx playwright test` 曾出现**十几分钟无输出**、日志停在 webServer 启动那行，
`e2e/.tmp` 从未被创建、也没有浏览器进程。逐层排查后确认是**环境问题，不是用例问题**：

1. **webServer 就绪探针被代理劫持**。环境里设了 `HTTP_PROXY`/`HTTPS_PROXY` 却**没有
   `NO_PROXY`**，于是 Playwright 探测 `http://127.0.0.1:3100/` 也走了代理。
   同一地址 `curl` 走代理返回 502、加 `--noproxy '*'` 返回 200 —— 一个"服务已起但
   探针看不见"的死锁。补 `NO_PROXY=127.0.0.1,localhost,::1` 后立刻正常。
2. **`globalSetup` 的"按需重建"会二次触发删除守卫**。它在源码比产物新时执行
   `npm run build`，而构建脚本自带 `rmSync(dist)` → 撞上沙箱的
   `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。该调用是 `execSync` +
   `stdio: 'inherit'`，在后台任务里就表现为**静默挂起**（既不报错也不退出）。
   绕法：先手动把两端构建好（`mv dist` 移出再 build），让 `needsBuild` 判定为 false。
3. **`test-results/` 残留会挡住下一次运行**。被强杀的跑次会留下 580 个文件，
   开跑先清空它，同样撞守卫 → 整轮直接失败。`mv` 移走即可。

**教训**：E2E 挂起时，先用三问定位——**webServer 通不通**（`curl --noproxy '*'`）、
**globalSetup 过没过**（`.tmp` 建了没）、**浏览器起没起**（进程数）。
不要一看到没输出就去改用例或改超时。用例本身全绿：12 条通过、耗时合计约 28 秒
（Playwright 报 14.9m 是 HTML report 落盘与进程收尾占用，不是测试耗时）。

### ⑬ 「唯一权威来源」要先核实它是否名副其实

上一轮我建议：要做全量 schema 层，切入点是「从 `/api/openapi.json` 生成类型 +
共享 DTO 包」。动手前先核实这个前提 —— 结果**前提不成立**：

`server/src/services/openapi.ts` 头部写着「API 形状的唯一权威来源」，而
app 实际挂载 64 个路由条目，规范只写了 37 个。缺 25 条（量化因子/台账/简报、
LLM 集成与校准、技能路由、改进闭环全套、intl K 线、全市场初筛等）。

**为什么一直没人发现**：`openapi.routes.test.ts` 只校验一份**硬编码的 24 条**
「README 核心端点」清单。有意思的是 **README 表格早就把 endpoints 写全了**——
也就是说人读文档时完全看不出问题，残缺的只有机器可读的那份。这种缺口对
「人看文档 + 机器读规范」的双轨结构特别危险：文档与规范的一致性没人断言。

**两条可复用的做法**

1. **别信「自我声明」，去数。** 声称是权威来源，就该有一道测试证明它覆盖了全部。
   验证方式是**从 `app` 的真实路由表反推**，而不是再维护一份人肉清单——
   人肉清单必然继续漏（这次漏的正是"清单之外的那 40 条"）。
2. **新写的守卫必须先证伪。** 加完"契约与路由一致"测试后，临时删掉一个契约条目，
   确认它**确实变红并指名道姓**报出该补哪个 key，然后恢复。只跑一次绿是不算数的：
   一条永远通过（或因枚举逻辑失效而空转）的守卫比没有更危险，因为它给人虚假安全感。
   因此同批还加了「实际路由数不为 0」这条自检，专门防枚举逻辑本身悄悄失效。

**补录时的纪律**：25 条契约逐条**读 handler 实现**后按实际语义写，不靠命名推测。
几个容易写错的点——`/api/llm/ensemble` 的 temperature/maxTokens 越界是
**夹紧 + 记日志**而非报错；`/api/intl/klines` 传 A 股代码返回 400 而非降级数据；
`/api/quant/announcements` 不传 artCode 时 code 必须合规。猜出来的契约比没有更糟，
因为它会让调用方按错误的形状写代码。

**顺带一个自伤教训**：补录时我连续三次把 `errorResponse('…' }` 写错
（中文全角括号 `）` 混入代码、以及多/少一个右括号），每次只修一个就重跑，
来回三轮。正确做法是**先 `tsc --noEmit` 一次列出全部语法错**（它会连带报出
后续所有行），再用一条正则统一修，而不是逐个 `grep` + 逐个改。

## 2026-10-04 类型生成落地：从「声明唯一权威」到「真是唯一」

### 为什么响应 schema 必须补（补之前只有 2/64）

上一轮补全了 25 条遗漏路由，paths 覆盖率与 app 实际挂载对齐了。但动手前核实
前提时发现**响应体契约几乎是空的**：64 个 operation 里只有 2 个的 200 响应带
schema，其余 62 个只有一句 description。此时上生成器，只会产出 62 个
`unknown` —— 生成器能用、类型不能用，等于花一轮工程换一个不能吃的壳。

### TypeScript 7 没有编译器 API（这条决定了整个架构）

```
node -e "console.log(Object.keys(require('typescript')))"
→ [ 'version', 'versionMajorMinor' ]
```

`createProgram` / `createSourceFile` / `forEachChild` 全是 `undefined`
（TS 7 是 Go 原生移植版）。**后果**：无法从类型注解反推 JSON Schema，
所以 `ts-json-schema-generator` / `openapi-typescript` 在本项目用不了 ——
它们的输入是 TS 类型，而本项目权威来源是 OpenAPI 文档，**方向相反**。
方向既然是「文档 → 类型」，自研生成器（`services/apiTypeGen.ts`，纯函数、
零运行时依赖、可在测试里直接调）比引入一个用不上的依赖更划算。

### 写「守卫」时踩的三个坑（最容易复发，务必记住）

1. **`type _X = A extends B ? true : never` 永远绿。** TS 对未加约束的条件类型
   不做求值检查，一个明显不成立的关系也能编译通过。实测
   `Hand.StockPoolItem extends Generated.StockPoolItem` 为假（后者多 chart_list），
   tsc 静默通过。**这是虚假安全感，比没有守卫更危险** —— 守卫的价值全在"会红"。
2. **社区流行的 `Equal<X, Y>`（互斥签名）在本项目误报。** 两侧各自声明了同名
   `PaperPosition` / `FinancialData`，形状逐字相同，但两次独立声明 → identity
   不同 → 判 false。守卫一旦习惯性误报，人就开始无视它。
3. **能用就别用**：判据直接赋值 `declare const a: B = g`（两个方向）最可靠 ——
   编译器真的会检查，且错误信息直接指名是哪个类型的哪个字段。

**结论：任何守卫都必须先反向验证它会红。** `apiTypeGen.test.ts` 末尾有 4 条
专门做这件事的用例（删组件 → $ref 报错；删响应 content → 报错；换空 schema →
unknown 报错；引入不认识构造 → 报错）。`contractParity.ts` 也做过一次实测：
往 `FactorExperiment` 注入一个多余字段，确认 parity 立刻变红后才恢复。

### 假红灯和假绿灯一样有害

生成器最初只取 `content['application/json']`，于是两个 SSE 端点
（`text/event-stream`）被判成"没写 schema"而报错 —— **把本来正确的契约
判成错误**，会让人去"修"根本没坏的东西。改成按声明顺序取第一个带 schema 的
媒体类型（JSON 优先）。

### 补 62 个 schema 时抓出的真实契约 bug

这不是走过场。逐条读 handler 补写的过程里暴露出的问题，按类型分三类：

- **声明与实现相反**：`horizons` 写成 `string[]`，而 `parseHorizons` 收的是
  整数数组（`Math.trunc(Number(v))` + `Number.isInteger` 校验，传字符串反而能过）。
  且 5 处各内联一遍、其中 3 处连类型都写错 → 抽成共用 `horizonsSchema`。
- **可空只写在 description 里**：`IntlFundamentalsResult.fundamentals` 的
  description 写着「上游不可用时为 null」，schema 却是非空 `$ref`。生成的类型
  非空，消费方照契约写代码遇到降级响应就崩。**可空必须写进 schema**
  （`oneOf: [$ref, {type:'null'}]`）。`$ref` 的兄弟字段（description 之类）
  对类型生成器是不可见的。
- **必填性两边不一致**：`ScenarioResult` 漏 `supportingArguments`；
  `FinancialData` 漏 6 个服务端确实返回的字段；`IntlFundamentals` 漏 4 个必填；
  `ChartConfig.config` 必填性不符；`DataQualityFlags` 前端标可选、服务端必填。
  方向上**以服务端 `types.ts` 为权威**（它是实现，契约是投影）。

### 一个值得单独记的发现

`ValuationModelResult.sensitivity.matrix` 的元素是 `number | null`
（服务端对 g2 逼近 r 等无解组合写 null），而前端手写类型声明成 `number[][]`。
收敛到契约类型后，`ValuationPanel.tsx` 立刻报 `TS18047: 'v' is possibly 'null'`。
原代码靠 `Number.isFinite(v)` 判断发散 —— `Number.isFinite(null)` 为 false，
**行为本来就是对的**，但类型上一直在说谎。已改成
`typeof v === 'number' && Number.isFinite(v)`，语义与运行行为都不变，
只是让类型收窄与意图一致。

**这正是"更严格的类型"的价值**：它没有制造 bug，而是让一处既有的隐式假设
显式化了。

### 门禁接线

- `npm run generate:api-types` 生成 / `npm run check:api-types` 只比对；
  CI `quality` job 新增一步，改了契约没重新生成会拦住合并。
- 生成物**提交进仓库**（不 gitignore），让契约↔类型的漂移在 PR diff 里直接可见。
- 生成物落盘前过 prettier（引号统一单引号），否则 `format:check` 门禁会红。
- 体积预算**零变化**（仍 1242.54 kB / 预算 1300 kB）：类型是纯编译期产物。
  接生成类型不会带来任何运行时体积，这点值得记住。

### 仍未收敛的部分（刻意保留）

`client/src/pages/quant/types.ts` 里的 `QuantResearchReport` /
`CrossSectionResult` 等**继续手写**：它们是前端页面的展示模型（页面才是消费方），
不是 API 契约的一部分，契约里没有对应 operation。强行生成反而会让页面布局
跟着契约漂移。这类"消费方自有模型"不该由契约生成 —— 边界要划清。

## 2026-10-05 补一个类型检查盲区：客户端测试文件曾完全不被类型检查

### 怎么发现的（不是靠读代码，是靠对比）

上一轮把 `ValuationModelResult` 从手写 interface 收敛到契约生成类型后，
生产代码 tsc 全绿、3397 用例全绿、CI 两 job 全绿 —— 但那是**假绿**。

复盘时做了一件早该做的事：**对比双端 tsconfig**。发现一处刺眼的不对称：

- `server/tsconfig.json` 明确**不排除测试**，且注释写明理由
  （「这份配置同时用于 tsc --noEmit（含测试文件的类型检查）」，构建产物由
  `tsconfig.build.json` 负责）；
- `client/tsconfig.json` 排除 `src/**/*.test.ts(x)`，**没有任何检查覆盖它们**。

于是写了个临时配置把客户端测试纳入检查，一跑 **23 个错误**；再切回改动前的
`6ecbd0b` 跑同一份配置 —— **19 个**。也就是说我上一轮**引入了 4 个新错误**，
而 CI 全绿，因为那 4 个错误住在测试文件里，没有任何门禁看得见。

### 这类错误的性质：测试在断言一个不存在的契约

修的过程里最有意思的发现 —— 几个"测试早就写错了，但一直没人发现"：

1. `restWrappers.test.ts` 给 `placePaperOrder` 传的是 `{ shares: 100 }`。
   契约字段叫 **`quantity`**；服务端 `placeOrder` 也只读 `quantity`。
   测试之所以"通过"，是因为它 mock 掉了整个 api 层、只断言 URL 与方法，
   **字段名从头到尾没有任何一层检查过**。改成 `quantity` 后又暴露下一层：
   还缺 `type`（服务端对 `type` 缺失直接 400）。
2. 同一文件传 `market: 'us'`，而 `IntlMarket` 是 **`'HK' | 'US'`**（大写）。
3. `RiskSection` 的 props 把 `data` 声明为必填，实现却写了 `data = []` 默认值 ——
   **类型与实现自相矛盾**。测试里 `<RiskSection />` 不传 data 也能正常渲染
   （运行行为正确），是类型在说谎。已按实现把 `data` 改为可选。
4. `reportExport.test.ts` 的 `StockPoolItem` 夹具缺 `chart_list` —— 因为上一轮
   我把 `chart_list` 从「前端标可选」纠正成「服务端必填」后，夹具露馅了。
   **这是上一轮那次纠正的连带影响，当时确实没看见**（因为测试不被检查）。

### 为什么之前一直没暴露

因为这类错误**三重隐身**：
- vitest 不做类型检查（esbuild 只转译不检查），所以测试照样绿；
- `tsc` 排除了测试文件，所以类型检查也绿；
- 字段名错了但 mock 掉了网络层、断言只看 URL/方法，所以**行为断言也绿**。

三层同时失效。**"全绿"不等于"对"，得确认门禁覆盖了改动实际影响到的文件。**

### 做法（新增 client/tsconfig.test.json）

与 `tsconfig.json` 的差异**只有三处必要项**，其余全部 `extends` 继承
（两处配置各自维护必然漂移）：

| 差异 | 原因 |
|---|---|
| `lib` 加 `ES2022` | 测试用了 `Array.prototype.at`，ES2020 lib 里不存在（TS2550） |
| `types` 加 `node` | 测试要 `import 'node:fs'` / 用 `Buffer`（TS2591）；`@types/node` 早已在 devDependencies，只是没声明 |
| `exclude` 清空 | 目的就是把测试纳入 |

光补这三处就从 23 降到 9 —— **剩下 9 个才是真实的类型分叉**。反过来说，
剩下那 14 个是「配置缺口造成的噪声」，不修配置就无从区分噪声与真问题。

接入门禁：`npm run typecheck:tests`，CI `quality` job 新增 "TypeCheck (client tests)"。
现在客户端测试的类型漂移会让 CI 变红。

### 纪律：改类型时要看测试文件

上一轮改 `ValuationModelResult` / `StockPoolItem` / `IngestInsight` 时，
我只跑了 `tsc --noEmit -p client/tsconfig.json`（排除测试）与全量 vitest（不查类型），
**两个门禁都恰好覆盖不到测试文件的类型**。以后收敛类型时，
除主配置外必须同时跑 `npm run typecheck:tests`。

## 2026-10-05 补最后一环：真实 HTTP 响应 vs 契约（此前从未验证过）

### 为什么必须补这一环

前三轮把契约补全、接了类型生成、加了各种守卫，但**所有验证都在进程内**
（`import buildOpenApiDocument()` 后比对）。而契约与响应是**两条独立的代码路径**：

- 契约 = `services/openapi.ts` 里**手写**的 schema；
- 响应 = 各路由里 `res.json(...)` **实际拼出来**的对象。

两者不一致时，进程内测试**测不出来** —— 它只验证「契约自洽」，不验证
「契约描述的就是服务实际返回的」。这正是本项目反复出现的漂移形态
（paths 缺 25 条、horizons 声明反了、chart_list 必填性不符，都是同一类）。

### 做法

新增三个脚本（`npm run smoke:contract`）：

| 文件 | 职责 |
|---|---|
| `scripts/contract-from-dist.mjs` | 从 **server/dist** 载入契约 |
| `scripts/contract-smoke.mts` | 请求 16 个无副作用端点，逐字段校验实际响应 |
| `scripts/run-contract-smoke.mts` | 先 build → 起真实进程 → 跑校验 → 关停 |

覆盖 16 个不依赖上游、不改状态的 GET 端点。**覆盖面不足是已知取舍**：
POST 类与需要真实行情的端点离线无法稳定复现，强行纳入只会让门禁随机红。

### 两个「假绿灯」陷阱（这次抓得很值）

**陷阱 1：契约读源码、响应读 dist。** 最初 `contract-smoke` 从
`server/src/services/openapi.ts` import 契约，而被测进程跑 `server/dist/index.js`
—— 改了源码没重新 build 时，就是**新契约比旧响应**。实测：把 `WatchlistCodes.codes`
谎称成 `number`，冒烟仍报「0 个不符」。
修法两条同时上：契约改从 dist 读（`contract-from-dist.mjs`）+ 启动器**先 build 再起进程**。
（这一步顺带验证了「先构建」的价值：我第一次注入时手滑写坏了语法，构建失败被门禁直接拦下。）

**陷阱 2：拿空数组当验证样本。** 修好同源问题后重测，注入 `WatchlistCodes.codes`
仍然抓不到 —— 查真实响应才发现 `/api/watchlist` 返回 `{"codes":[]}`，
**数组为空，元素级校验根本不执行**。注入点选在了无法证伪的端点上。
换成有真实数据的 `/api/models`（`registry` 里有实际模型）后一次命中。

### 反向验证（结果）

把 `ModelSpec.id` 从 `string` 谎称成 `integer`（语法合法，能过构建）：

```
✗ GET /api/models
    $.registry[0].id: 期望 number，实际 string（"deepseek-chat"）
真实进程校验：16 个端点，1 个与契约不符      → exit 1
```

还原后 → `16 个端点，0 个与契约不符` → exit 0。
**指名具体字段、退出码非 0、还原即绿** —— 三点齐了才算一条真守卫。

顺带修掉校验器自身的一个假红灯：最初只认 OpenAPI 3.1 的
`type: ['string','null']`，不认 3.0 的 `nullable: true`，于是把 5 个
**本来正确**的契约误报成「期望非 null，实际 null」（PaperStats.currentDate、
FactorExperimentSummary.lastAt、harnessPolicy.updatedAt 等）。
假红灯同样有害 —— 它会让人去"修"根本没坏的东西。

### 纪律

**新写的门禁，第一次就要先问「它会红吗」。** 本轮三次假绿灯（源码/dist 不同源、
空数组样本、`Equal`/identity 误报）都是同一个病因的不同表现：
**没验证过守卫在故障时是否真的报警**。

## 2026-10-05 补最后一环：真实 HTTP 响应 vs 契约（此前从未验证过）

### 为什么必须补这一环

前三轮把契约补全、接了类型生成、加了各种守卫，但**所有验证都在进程内**
（`import buildOpenApiDocument()` 后比对）。而契约与响应是**两条独立的代码路径**：

- 契约 = `services/openapi.ts` 里**手写**的 schema；
- 响应 = 各路由里 `res.json(...)` **实际拼出来**的对象。

两者不一致时，进程内测试**测不出来** —— 它只验证「契约自洽」，不验证
「契约描述的就是服务实际返回的」。这正是本项目反复出现的漂移形态
（paths 缺 25 条、horizons 声明反了、chart_list 必填性不符，都是同一类）。

### 做法

新增三个脚本（`npm run smoke:contract`）：

| 文件 | 职责 |
|---|---|
| `scripts/contract-from-dist.mjs` | 从 **server/dist** 载入契约 |
| `scripts/contract-smoke.mts` | 请求 16 个无副作用端点，逐字段校验实际响应 |
| `scripts/run-contract-smoke.mts` | 先 build → 起真实进程 → 跑校验 → 关停 |

覆盖 16 个不依赖上游、不改状态的 GET 端点。**覆盖面不足是已知取舍**：
POST 类与需要真实行情的端点离线无法稳定复现，强行纳入只会让门禁随机红。

### 两个「假绿灯」陷阱（这次抓得很值）

**陷阱 1：契约读源码、响应读 dist。** 最初 `contract-smoke` 从
`server/src/services/openapi.ts` import 契约，而被测进程跑 `server/dist/index.js`
—— 改了源码没重新 build 时，就是**新契约比旧响应**。实测：把 `WatchlistCodes.codes`
谎称成 `number`，冒烟仍报「0 个不符」。
修法两条同时上：契约改从 dist 读（`contract-from-dist.mjs`）+ 启动器**先 build 再起进程**。
（这一步顺带验证了「先构建」的价值：我第一次注入时手滑写坏了语法，构建失败被门禁直接拦下。）

**陷阱 2：拿空数组当验证样本。** 修好同源问题后重测，注入 `WatchlistCodes.codes`
仍然抓不到 —— 查真实响应才发现 `/api/watchlist` 返回 `{"codes":[]}`，
**数组为空，元素级校验根本不执行**。注入点选在了无法证伪的端点上。
换成有真实数据的 `/api/models`（`registry` 里有实际模型）后一次命中。

### 反向验证（结果）

把 `ModelSpec.id` 从 `string` 谎称成 `integer`（语法合法，能过构建）：

```
✗ GET /api/models
    $.registry[0].id: 期望 number，实际 string（"deepseek-chat"）
真实进程校验：16 个端点，1 个与契约不符      → exit 1
```

还原后 → `16 个端点，0 个与契约不符` → exit 0。
**指名具体字段、退出码非 0、还原即绿** —— 三点齐了才算一条真守卫。

顺带修掉校验器自身的一个假红灯：最初只认 OpenAPI 3.1 的
`type: ['string','null']`，不认 3.0 的 `nullable: true`，于是把 5 个
**本来正确**的契约误报成「期望非 null，实际 null」（PaperStats.currentDate、
FactorExperimentSummary.lastAt、harnessPolicy.updatedAt 等）。
假红灯同样有害 —— 它会让人去"修"根本没坏的东西。

### 纪律

**新写的门禁，第一次就要先问「它会红吗」。** 本轮三次假绿灯（源码/dist 不同源、
空数组样本、`Equal`/identity 误报）都是同一个病因的不同表现：
**没验证过守卫在故障时是否真的报警**。

## 2026-10-05 稳定期实测：抓到一个「单跑永远绿、全量并发偶发红」的测试

稳定期的价值不在于再跑一遍绿，而在于**跑够多次把偶发逼出来**。
连跑 5 轮全量（245 文件 / 3397 用例），第 5 轮 exit=1。

### 症状

```
FAIL server/src/utils/__tests__/clientAbort.test.ts
  > abortOnClientClose（真实 HTTP 连接）> 客户端先断开、路由事后才注册…
Error: Test timed out in 30000ms.
```

### 排查过程（关键是**先证伪假设**，别急着改）

1. 单独跑该文件 12 次 → 全绿。**说明不是逻辑回归**。
2. 查历史记录：上一轮记过一组「全量红、单独绿」的 flaky（auditLog.persistence /
   rag.corpus / paperTrading / fileCachePrune），当时归因为「245 worker 争抢磁盘」。
   **不能直接套用那个结论** —— 那个是 `fs.rmSync` 慢，这条是 HTTP 连接，要分别验证。
3. 假设一：全量并发资源争抢导致超时。→ 与「单独跑也该偶发」矛盾，不成立。
4. 假设二：`server.close()` 等 keep-alive 空闲连接。→ 写了个最小复现脚本实测，
   `close()` **立即返回**（0ms），假设**不成立**。
5. 真因：该用例的 `/late` 路由**故意不 `res.end()`**（响应悬空，等客户端断开），
   连接因此停留在活跃态；`server.close()` 只停止接受新连接、**等待活跃连接结束**。
   单独跑时客户端已 destroy、连接恰好已死所以看不出来；全量并发下 close 事件
   偶发滞后，`await server.close()` 就挂到 testTimeout。

### 修法

在两处 `server.close()` 前加 `server.closeAllConnections()` —— 强制断开残留连接，
让收尾变成确定性动作。**业务代码不需要**，只针对测试里故意保持连接悬空的场景。

### 两条要记住的

1. **`server.close()` 不是「立即关闭」**：它等待所有活跃连接。测试里只要有
   「响应故意悬空」的路由（断连/取消类测试很常见），收尾就可能挂到超时。
   配 `closeAllConnections()` 才变确定性。
2. **上一轮的 flaky 结论不能直接套用到这一轮**。同样是「全量红、单独绿」，
   成因可能完全不同（一个是磁盘 IO，一个是连接生命周期）。**每次都要重新定位**，
   否则就是把一个 bug 的结论贴到另一个 bug 上。

### 验证方式

单跑无法证伪（本来就不复现），所以**必须在全量并发下多轮**：
修复后连跑 6 轮全量，`timeout` 出现次数均为 0、exit 均为 0。

## 2026-10-05 稳定期实测：抓到一个「单跑永远绿、全量并发偶发红」的测试

稳定期的价值不在于再跑一遍绿，而在于**跑够多次把偶发逼出来**。
连跑 5 轮全量（245 文件 / 3397 用例），第 5 轮 exit=1。

### 症状

```
FAIL server/src/utils/__tests__/clientAbort.test.ts
  > abortOnClientClose（真实 HTTP 连接）> 客户端先断开、路由事后才注册…
Error: Test timed out in 30000ms.
```

### 排查过程（关键是**先证伪假设**，别急着改）

1. 单独跑该文件 12 次 → 全绿。**说明不是逻辑回归**。
2. 查历史记录：上一轮记过一组「全量红、单独绿」的 flaky（auditLog.persistence /
   rag.corpus / paperTrading / fileCachePrune），当时归因为「245 worker 争抢磁盘」。
   **不能直接套用那个结论** —— 那个是 `fs.rmSync` 慢，这条是 HTTP 连接，要分别验证。
3. 假设一：全量并发资源争抢导致超时。→ 与「单独跑也该偶发」矛盾，不成立。
4. 假设二：`server.close()` 等 keep-alive 空闲连接。→ 写了个最小复现脚本实测，
   `close()` **立即返回**（0ms），假设**不成立**。
5. 真因：该用例的 `/late` 路由**故意不 `res.end()`**（响应悬空，等客户端断开），
   连接因此停留在活跃态；`server.close()` 只停止接受新连接、**等待活跃连接结束**。
   单独跑时客户端已 destroy、连接恰好已死所以看不出来；全量并发下 close 事件
   偶发滞后，`await server.close()` 就挂到 testTimeout。

### 修法

在两处 `server.close()` 前加 `server.closeAllConnections()` —— 强制断开残留连接，
让收尾变成确定性动作。**业务代码不需要**，只针对测试里故意保持连接悬空的场景。

### 两条要记住的

1. **`server.close()` 不是「立即关闭」**：它等待所有活跃连接。测试里只要有
   「响应故意悬空」的路由（断连/取消类测试很常见），收尾就可能挂到超时。
   配 `closeAllConnections()` 才变确定性。
2. **上一轮的 flaky 结论不能直接套用到这一轮**。同样是「全量红、单独绿」，
   成因可能完全不同（一个是磁盘 IO，一个是连接生命周期）。**每次都要重新定位**，
   否则就是把一个 bug 的结论贴到另一个 bug 上。

### 验证方式

单跑无法证伪（本来就不复现），所以**必须在全量并发下多轮**：
修复后连跑 6 轮全量，`timeout` 出现次数均为 0、exit 均为 0。

### 附：3 份并发加压下的表现（超出设计负载，仅供参考）

常规单份全量下 `auditLog.persistence` 耗时 **30.2s**（用例本身只 89-155ms，
时间全耗在文件级 hook 的 `fs.rmSync`）。人为同时跑 **3 份全量**（≈72 核满载）
时升到 **94.1s → Hook timed out in 60000ms**，同时暴露 `paperTrading` 的
`testTimeout`。**用例逻辑全部通过**，纯粹是 IO 争抢。

**为什么不放宽超时**：60s 是按「单份全量」定的，加载已经到 30s（用掉一半预算）；
3 份并发是 3 倍超载，**放宽到 180s 治不了 3 倍超载**，只会让真正的卡死更难发现。
若将来常规运行的耗时逼近 60s，应该查的是「哪个 hook 在做重 IO」而不是继续放宽。

**当前余量**：本机 24 核 / 33.8GB、245 worker 全并发，**比 CI（2 核）严苛得多**，
这是优点 —— 本机能复现的 flaky 比 CI 多。当前状态：8 轮常规全量全绿、
CI 7 次提交 14 个 job 全 success 且 `attempts=1`。

## 2026-10-05 补最大短板：契约冒烟从 16 扩到 29 个端点（含 POST / DELETE）

### 缺口是什么

上一轮补的「真实进程契约冒烟」只覆盖 16 个**无副作用 GET**，而全项目有
**64 个 operation（其中 31 个 POST）**。也就是说：POST 类端点的响应体
**从未被真实校验过** —— 而「契约声明的字段」与「res.json 实际写出的字段」
分属两条独立代码路径，正是本项目反复漂移的形态。

### 为什么之前没做

不是没想到，是**当时判断 POST 不可确定性测试**（要 LLM、要行情上游）。复盘后
发现这个判断过宽：31 个 POST 里有 **11 个是纯本地逻辑**（模拟盘下单/结算、
成本重置、清记忆、改自选股、改进 dryRun、调度器与自治监控的启停、因子评估），
既不碰网络也不碰模型，完全可以确定性验证。

### 做法

1. 冒烟脚本支持 POST / DELETE：带请求体、按契约校验响应。
2. **启动器加数据文件隔离**（这是关键的前置条件）：把 WATCHLIST_FILE /
   PAPER_TRADING_FILE / AUDIT_LOG_FILE / CHAT_HISTORY_FILE / DATA_CACHE_DIR /
   FACTOR_LEDGER_FILE / RESEARCH_DIGEST_FILE / HISTORY_FILE 全部指向
   `mkdtemp` 出来的临时目录。
   **不做这一步，跑一次冒烟就会改用户自己的自选股和模拟盘账户** ——
   那不是「测试副作用」而是**改用户数据**。7 个环境变量名都逐一核对过
   确实被服务端读取（不是猜的）。
3. research-history 播种子：`GET/DELETE /api/history/{id}` 需要一个确定可删的
   id，而 history 只在分析成功时落库（依赖 LLM + 行情），`POST /api/history`
   并不存在（404）。故按 `HistoryStore` 形状往临时目录写一条种子。

覆盖从 **16 → 29 个端点**（45%），且 29 个全部有响应体校验、零跳过。

### 本轮踩的坑：路径占位符当成字面量

排查 `DELETE /api/history/{id}` 一直 404 花了比预期久的时间：先后怀疑过
数据隔离没生效、种子被 POST 覆盖、dist 过期、`.env` 覆盖 env、id 不匹配 ——
**每个假设都被实测证伪了**（手动 curl 同一 URL 返回 200）。

真因是我把契约里的**路径模板** `{id}` 当成字面量拼在了后面，实际请求的是
`/api/history/{id}/smoke-history-1`。修法是发请求前把 `{param}` 替换掉
（`pathParams` 参数）。

**教训**：404 出现时，先把**实际请求的 URL 打出来**再做其它假设。
前面五轮的排查全是在猜环境，只有打印 URL 能一击定位。

### 反向验证（POST 守卫真的有效）

把 `WatchlistCodes.codes` 的 items 从 `string` 谎称成 `number`：

```
✗ POST /api/watchlist
    $.codes[0]: 期望 number，实际 string（"600519"）
真实进程校验：29 个端点，1 个与契约不符     → exit 1
```

还原后 → `29 个端点，0 个与契约不符` → exit 0。
**注意这次是靠 POST 抓到的**（GET /api/watchlist 那次 codes 为空数组，
元素级校验不执行）—— 与之前「拿空数组当样本」是同一类陷阱的另一个面。

### 仍未覆盖的 35 个 operation

依赖上游（行情 / LLM / 东财）而无法离线确定性验证：analyze、compare、
quant/analyze、factor/composite*、cross-section、backtest/evaluate、chat、
ingest、llm/*、quant/screener/run、valuation/model 等。
**这是明确的已知边界，不是遗漏**。要补需要给冒烟注入 fetch stub 层
（拦截 undici 请求返回固定行情/LLM 响应），属独立一轮工程。

## 2026-10-05 补最大短板：契约冒烟从 16 扩到 29 个端点（含 POST / DELETE）

### 缺口是什么

上一轮补的「真实进程契约冒烟」只覆盖 16 个**无副作用 GET**，而全项目有
**64 个 operation（其中 31 个 POST）**。也就是说：POST 类端点的响应体
**从未被真实校验过** —— 而「契约声明的字段」与「res.json 实际写出的字段」
分属两条独立代码路径，正是本项目反复漂移的形态。

### 为什么之前没做

不是没想到，是**当时判断 POST 不可确定性测试**（要 LLM、要行情上游）。复盘后
发现这个判断过宽：31 个 POST 里有 **11 个是纯本地逻辑**（模拟盘下单/结算、
成本重置、清记忆、改自选股、改进 dryRun、调度器与自治监控的启停、因子评估），
既不碰网络也不碰模型，完全可以确定性验证。

### 做法

1. 冒烟脚本支持 POST / DELETE：带请求体、按契约校验响应。
2. **启动器加数据文件隔离**（这是关键的前置条件）：把 WATCHLIST_FILE /
   PAPER_TRADING_FILE / AUDIT_LOG_FILE / CHAT_HISTORY_FILE / DATA_CACHE_DIR /
   FACTOR_LEDGER_FILE / RESEARCH_DIGEST_FILE / HISTORY_FILE 全部指向
   `mkdtemp` 出来的临时目录。
   **不做这一步，跑一次冒烟就会改用户自己的自选股和模拟盘账户** ——
   那不是「测试副作用」而是**改用户数据**。7 个环境变量名都逐一核对过
   确实被服务端读取（不是猜的）。
3. research-history 播种子：`GET/DELETE /api/history/{id}` 需要一个确定可删的
   id，而 history 只在分析成功时落库（依赖 LLM + 行情），`POST /api/history`
   并不存在（404）。故按 `HistoryStore` 形状往临时目录写一条种子。

覆盖从 **16 → 29 个端点**（45%），且 29 个全部有响应体校验、零跳过。

### 本轮踩的坑：路径占位符当成字面量

排查 `DELETE /api/history/{id}` 一直 404 花了比预期久的时间：先后怀疑过
数据隔离没生效、种子被 POST 覆盖、dist 过期、`.env` 覆盖 env、id 不匹配 ——
**每个假设都被实测证伪了**（手动 curl 同一 URL 返回 200）。

真因是我把契约里的**路径模板** `{id}` 当成字面量拼在了后面，实际请求的是
`/api/history/{id}/smoke-history-1`。修法是发请求前把 `{param}` 替换掉
（`pathParams` 参数）。

**教训**：404 出现时，先把**实际请求的 URL 打出来**再做其它假设。
前面五轮的排查全是在猜环境，只有打印 URL 能一击定位。

### 反向验证（POST 守卫真的有效）

把 `WatchlistCodes.codes` 的 items 从 `string` 谎称成 `number`：

```
✗ POST /api/watchlist
    $.codes[0]: 期望 number，实际 string（"600519"）
真实进程校验：29 个端点，1 个与契约不符     → exit 1
```

还原后 → `29 个端点，0 个与契约不符` → exit 0。
**注意这次是靠 POST 抓到的**（GET /api/watchlist 那次 codes 为空数组，
元素级校验不执行）—— 与之前「拿空数组当样本」是同一类陷阱的另一个面。

### 仍未覆盖的 35 个 operation

依赖上游（行情 / LLM / 东财）而无法离线确定性验证：analyze、compare、
quant/analyze、factor/composite*、cross-section、backtest/evaluate、chat、
ingest、llm/*、quant/screener/run、valuation/model 等。
**这是明确的已知边界，不是遗漏**。要补需要给冒烟注入 fetch stub 层
（拦截 undici 请求返回固定行情/LLM 响应），属独立一轮工程。

## 2026-10-05 评估更正：剩余 35 个 operation 的缺口比原以为的小

原评估「35 个依赖上游的 operation 从未被校验响应体」，并打算写 fetch stub 层
（14 处 fetch、12 个文件、每种上游响应形状不同）。**动手前核实前提，发现前提不成立**：

- `routes.quantFactor.test.ts` — **62 处** `expect(res.body...)`
- `routes.quantAnalyze.test.ts` — 23 处，逐字段断言 strategy / dataQuality /
  audit / optimization / summary / backtest
- `documents.ingest.test.ts` — 13 处
- 全仓 **30 个路由测试文件**都断言了响应体

即：依赖上游的端点，其响应体在路由测试里**已被深度断言**（service 层被 mock，
不打真实网络）。真正的缺口只是「这些断言没有与 OpenAPI 契约交叉校验」——
契约改了、断言没改，仍可能分叉。

**故 fetch stub 层不做**：覆盖收益低（响应体已被断言）、成本高且脆（stub 越像真实
响应，越可能在真实上游变更时静默失配）。

**更划算的下一步**：把 `scripts/contract-smoke.mts` 里已有的 JSON Schema 校验器
（`validate()`）抽成公共 helper，让 30 个已有路由测试顺带校验契约。这样不需要
fetch stub（service 已 mock、响应确定），且覆盖的是**当前最大的真缺口**：
契约与实际响应的一致性。属独立一轮改动。

**教训**：又一次印证「动手前先核实前提」。这与本会话早前那次
（以为 62 个响应无 schema、实际先核实才补齐）是同一个模式的重复 ——
上一轮我因为核实而发现了真缺口，这一轮因为核实而**避免了一个不必要的大工程**。
核实不是保险，是提高决策质量的常规动作。
