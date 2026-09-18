# Changelog

股票研究系统（多专家投研 + 量化回测）变更历史。
按日期倒序；commit 为完整短哈希。详细工程决策与踩坑记录见 `ENGINEERING-NOTES.md`。

## 2026-09-19 — 补修：区间闸门用例的时区脆弱断言（9/17 那轮的同类漏网）

`routes.quantDateRangeGate.test.ts` 的「composite 缺省日期」用例拿
`new Date().toISOString().slice(0,10)`（UTC 日）当期望，而 `resolveDateRange` 刻意返回
**本地日历日**（见 `utils/dateRange.formatLocalIsoDate` 的注释：UTC 口径会让东八区凌晨的
"今天"退到昨天）。两者只在本地日期与 UTC 日期重合时相等——东八区 00:00–08:00 必挂，
而 CI 跑在 UTC 所以从未暴露。9/17 那轮只修了 `utils/__tests__/dateRange.test.ts` 的同类
断言，漏了这个文件。

改为按进程本地时区算期望。本地（UTC+8）与 `TZ=UTC` 均复验通过；并做了突变验证——
把 `formatLocalIsoDate` 换回 UTC 口径时该用例确实失败（`expected '2026-09-18' to be
'2026-09-19'`），断言不是恒真。

## 2026-09-17 — 第四轮：覆盖率推进、审计清零与超时取消收口（新增 1154 个测试）

这一轮不新增功能，主线是「补测 → 暴露缺陷 → 当轮修掉 → 收紧门禁」，外加把上一轮明确记为
"有意不做"的超时取消做完。测试 1978 → **3132 用例 / 230 文件**；覆盖率 lines 79.77% →
94.8% / statements 92.75% / functions 94.61% / branches 83.05%，阈值同步提到 92 / 90 / 92 / 80。

**覆盖率推进（三轮，每轮暴露的缺陷当轮修完，不是只记 TODO）**

- **第一轮（f48608b）**：新增 14 个测试文件 / 441 条用例 → 195 文件 / 2419 用例。此前 19 个客户端源文件为 0 覆盖（量化面板家族、REST 封装、App 导航分支），服务端时序计量入口也无测试。行覆盖 79.77% → 90.57%，语句 78.48% → 88.49%，函数 75% → 88.93%，分支 66.02% → 75.66%；阈值 lines 70 → 88 / statements 68 → 86 / functions 62 → 86 / branches 55 → 73。`client/src/test/setup.ts` 为 jsdom 补 `ResizeObserver` / `matchMedia` / `scrollIntoView` 兜底，消除「被动 effect 冲刷晚于 `unstubAllGlobals`」造成的跨文件随机失败。
- **第二轮（7b150d0）**：212 文件 / 2890 用例。行覆盖 → 94.39%，语句 → 92.34%，函数 → 94.32%，分支 → 82.51%；阈值提到 92 / 90 / 92 / 80。覆盖率分母排除 `.test.tsx`（此前只排了 `.test.ts`，41 个测试文件被算进分母）；server 构建改用 `tsconfig.build.json`，dist 不再含 151 个 `*.test.js`；`.gitignore` 覆盖 `.env.*`（保留 `.env.example`）；补录 9 个代码在读取但 `.env.example` 缺失的变量（含 `SSE_HEARTBEAT_MS`、`PAPER_MAX_ORDERS`、`LLM_MAX_QUEUE`、`EXPOSE_ERROR_DETAIL`）。
- **第三、四轮（e10a426 / dc30660 / 96c7ef9）**：221 → 228 → 230 文件，3018 → 3049 → 3132 用例；行覆盖 94.39% → 94.57% → 94.69% → 94.8%。

**补测暴露并修复的缺陷（择要）**

显示与数据：

- `useCountUp`：target 变 0 时短路不写回 state，换到估值字段缺失的标的会继续显示上一只的 PE/PB。
- 导出 Markdown 的情景概率少了 100 倍（页面「35%」→ 文件「0.35%」）：`probability` 契约是 0-1，`ScenarioSection` 已 ×100，导出漏了。
- `ValuationPanel` 敏感性表把行轴（折现率）标成「公允价值（元）」；隐含溢价正溢价染绿、折价染红，且「—」（无法计算）也被染成方向色，与全站红涨绿跌口径相反。
- `App` 仪表盘市值字段缺失时显示「0 亿」（缺失被当成实测值）。
- `FactorLabPanel` 的 `fmtP` 把 0.00012 显示成「0.000」，读起来像 p 恰为 0（最强显著）。
- `ReportSummary` 把 custom 策略标成「均值回归」；`NewsPostureHeatBar` 把极性 0 的中性新闻涂成看空绿。

交互与竞态：

- `ChatPanel` 发消息用 messages 快照整体替换数组，并发/交错写入会吞掉对话 → 改函数式追加。
- `QuantPage`：`useNews || !newsItems` 让「启用最新消息情绪叠加」勾选框在四种组合下都不生效（未勾选也会实时抓取新闻）；对比表「变化」列按"越大越好"折算颜色，导致最大回撤（存负数）整列反色。
- `CrossSectionPanel` 组合回测表头读当前表单 state 而非本次运行参数，改「调仓周期」后表头宣称 40 日、表内仍是 21 日那次的数据。
- `PaperTradingPage`「下单」在途期间未禁用 → 资金类操作可重复提交；审计「加载更多」用渲染快照算 offset，同帧连点两次永远取不到最后一页。
- `HistoryPage`「查看」无序号守卫，慢响应会顶掉用户最后点的那份报告；并发删除共用 `deletingId` 会让 A 清掉 B 的状态。
- `api/client.ts`：`chatWithAgentStream` 收尾（done/error/cancel）后，已排进任务队列的那一帧仍会回调调用方。

服务端健壮性与数据可信：

- `llm/client`：响应头到达即清超时、body 读取裸奔——上游在头之后卡住时该请求永不结束，而它占着的 `llmGate` 配额只在 finally 归还，累积到并发上限全站 LLM 调用排队超时且必须重启才能恢复。
- `quant/dataProvider`：`generateSimulatedData` 的 while 无迭代上限且入口无校验（同步循环占满事件循环）→ 加 20000 次硬上限。
- 4 条量化路径（composite / backtest evaluate / 截面与表达式取数 / batch）此前会把「行情源不可达时生成的合成 K 线」算成真实结论并返回 200 → 统一改为 422 + `degraded` + 命中代码。
- `horizons` 解析五处不一致（单只路径连元素上界都没有，`h=1e9` 可过；batch 先 floor 后不复检下界，`h=0.5` → 0 → `tStat=NaN` 静默产出错误显著性）→ 抽 `parseHorizons` 统一 1..504、最多 8 档、去重。
- `dataService.getData` 把缓存对象**引用**直接返回，`analysisPipeline` 就地改写它，于是"从未由 API 提供过"的修正值被写进内存甚至落盘，同一份数据的口径取决于谁先跑过 → 全部出口返回深拷贝。
- `errorDetail` 由 fail-open 反转为 fail-safe：本仓库 `npm start` 与 `启动系统.bat` 都不设 `NODE_ENV`，原判据在生产部署下永不生效，20+ 处 `detail` 会把上游 URL 与本机路径直接回给调用方；新增 `EXPOSE_ERROR_DETAIL=1` 供本地排障。
- `X-Request-ID` 只接受 `[A-Za-z0-9_-]{1,64}`：此前客户端可注入 16KB 或控制字符，并被原样回写响应头、写进日志与错误响应。
- 限流上限解析统一收口：`Number(env) || N` 对负数不设防（`Number('-5')` 是 -5），而 max<=0 会被 express-rate-limit 视为「永不放行」，该类请求 100% 429。
- `watchlistService` 非原子全覆盖写 + 无锁 → tmp+rename 与写临界区（写盘中断会留下截断 JSON，读侧静默返回空清单，用户看起来像"自选股被清空"）；`quantCache` 写缓存同样改 tmp+rename（并发写会让读者读到半截 JSON）。
- `paper` 接单/结算校验交易日必须是真的 `YYYY-MM-DD`（含 2026-02-31 这类「格式对但不存在」），此前脏日期会被写成当前交易日并进入 T+1 判定。
- `limitGate`：派发段日志同步抛错会让 waiter 永不 settle、配额无人归还（命中上限后闸门无法自愈）。
- `concurrency`：首个 worker 失败后其余 worker 仍在跑（白烧上游配额、rejection 无人 await）→ 首个失败即中止。
- `index.ts`：畸形 JSON 请求体此前返回 500「服务器内部错误」（把所有 POST 路由的输入问题说成服务端故障）→ 按 body-parser 的 `entity.parse.failed` 返回 400；补 `headersSent` 守卫（SSE 头已发出后再写响应会抛 `ERR_HTTP_HEADERS_SENT`）。
- `chat`：`/api/chat/history/clear` 此前无限流也不校验 sessionId（会抹状态的写操作）→ 挂 `chatLimiter` 并复用 chatMemory 的白名单（含 `__proto__` 等原型链键）。
- `historyService` / `factorLedger`：同步读+解析整份 JSON 且同请求读两遍（库满时约 0.14-0.18s 阻塞事件循环，SSE 长连接会一起等）→ 内存 store + 脏标记 + 写锁。
- `routes/audit`：无分页（满额时下发约 3.5MB 而客户端只用 20 条）→ 支持 limit/offset，非法时间参数由静默 NaN 过滤改为 400。

结论来源披露（防止规则引擎结论被当成 LLM 研判）：

- 专家层降级分三类（未配置 / 排队超时 / 调用失败）并打标记，人数、名单、原因写进既有 `limitation_explain`。
- 仲裁层此前**完全静默**降级——"8 位专家全 LLM 成功、仲裁却是规则引擎"时报告不会披露 → 同样打标记并单独披露来源。
- 导出补齐「## 研究局限性」段落（页面已渲染，导出此前完全缺失）。

口径与可访问性：

- 分数着色不再借用涨跌色：`lib/colors` 新增 `scoreCls` / `scoreBarCls` / `scoreGrade` 与 `.score-*` 色板（优秀档由红改绿、较差档由绿改红），并加源码级守卫断言"这两个面板不得出现涨跌色"。
- `.no-print` 真正落地（报告动作区与导出/打印按钮、图表工具条、失败列重试、搜索历史清空/删除），并补测试确认该规则只在 `@media print` 生效。
- `ExpertOpinions` 折叠头由纯 `onClick` 的 div 改为 button + `aria-expanded`（键盘与读屏此前完全打不开）；App 的 tab 补 `aria-controls` 与 panel 的 `role=tabpanel`；`PriceTrendChart` 切换按钮补 `aria-pressed` 并把激活态对比度提到 ≥4.5:1；`prefers-reduced-motion` 补 `scroll-behavior:auto`。
- `StockSelector` / `StockSearchInput`：在途检索返回后下拉会自己弹回来盖住用户目标 → 补请求序号守卫；历史项删除按钮补可读名称（此前读屏读成「乘号」）。

**超时取消语义收口（96c7ef9）**

上一轮记为「有意不做」的两项，这一轮做完：

- 新增 `utils/timeout.ts` 的 `withAbortableTimeout(run, ms, opts)`：收惰性工厂而不是已创建的 Promise，把「本次超时」与「调用方取消」合并成一个 signal 交给上游，超时能真正级联到 socket 级；调用方 signal 已置位时不调用 run（少打一次注定白烧的上游）。
- 接入 6 处：`analysisPipeline` 的新闻 3s / K线 12s / 评级回填 8s；`watchlistBacktest` 的新闻 5s（同时接批次信号）；`routes/quant` 的 `/api/quant/analyze` 与 `/api/backtest/evaluate` 各 5s。`outcomeTracker` 取消后不再为剩余条目取数，已完成条目照常落盘。
- **调用方取消不算「尽力而为」里的失败**：原样上抛取消原因，不再吞成「没有新闻」——否则批量作业取消后每只股票都会继续跑完剩余流程。
- 刻意保留 `withTimeout` 的 2 处（一致预期 6s / 公告 6s）：这两个 provider 由 `withQuantCache` 在并发调用方之间共享，abort 会连带打断别人那次取数，而超时后让它跑完反而把结果写进缓存（白烧变预热）。例外前提（eventProvider 15s / announcementProvider 12s 硬上限）已加不变量测试钉住。
- 顺带修掉 `fetchLatestNews` 的真泄漏：逐端点的 8s 定时器原先只在成功路径 clearTimeout，`!resp.ok` 走 continue 时定时器仍挂 8s 并触发一次无人关心的 abort。
- `llm/client.ts` 自写的 `readBodyWithTimeout` race 实现合并到 `withTimeout`（两套并存只会分叉），保留薄封装与「响应体」错误字样。

**CI 脆弱测试与构建收口**

- `ce6c47e`：审计分页 offset 改由 ref 权威维护（写入点同步更新，不再依赖镜像 effect 的提交时机）；`auditLog` 落盘失败用例改为「父路径是普通文件」注入(两端都确定性抛错)，此前依赖「append 到目录必 EISDIR」，Linux CI 上不触发。
- `435794d`：`dateRange.test.ts` 的默认窗口用例改按进程本地时区算期望（硬编码 `2026-01-01` 只在 UTC+8 成立，CI 的 UTC 下必挂），并改用「起止相差恰好 1 天」验证区间。
- `d51f277`：股票搜索用例显式 30s（CI 无外网时链路本就先等 suggest 超时再回落本地全表匹配，5s 属机器抖动触发的脆弱断言）。
- `de7678c`：`build` 脚本先 `rmSync('dist')` 再 tsc——tsc 只写不删，上一轮收窄 include 后本地 dist 仍留着 151 个 `*.test.js` 孤儿文件，而 E2E 的 webServer 直接跑 `node server/dist/index.js`，等于可能验到上一版代码。
- `0806872`：截面因子末四列改按 `period` 取最大档（此前取 `byPeriod` 末元素，服务端返回顺序一变就悄悄换档，且表头未标明是哪一档），表头补「（最长档）」并加乱序回归用例。

验证：全量 230 文件 / 3132 用例通过（新增 2 文件 29 用例）；覆盖率 lines 94.8% / statements 92.75% / functions 94.61% / branches 83.05%（阈值 92 / 90 / 92 / 80）；lint 0 warning 0 error；Prettier 全通过；双端 tsc；双端 build；E2E 9/9。新增的源码级不变量测试已用突变验证（改回裸 `withTimeout` 时确实失败）。

## 2026-09-16 — 第三轮收尾：清空全部遗留项（新增 87 个测试）

把前两轮明确记为"未做/有疑虑"的条目全部落地，不再保留已知缺口。测试 1891 → **1978 用例 / 181 文件**；覆盖率 lines 79.77% / statements 78.48% / functions 75% / branches 66%。

**服务端：流式健壮性与信息边界**

- **SSE 心跳**：新增每 15 秒的注释帧（`: ping`，`SSE_HEARTBEAT_MS` 可调、0 关闭）。此前通道没有任何心跳，而深度分析在 `experts → arbitration` 之间可能静默 60s+，nginx/ALB 的默认读超时会把连接掐断——前端表现为"分析莫名中断"。
- **生产环境不再回传原始错误消息**：新增 `utils/errorDetail.ts`，各路由 catch 统一改用它（生产返回 `undefined`，本地保留 message 便于排障）。此前路由内 catch 绕过了全局错误中间件的 `NODE_ENV` 判断，会把上游 URL/内部路径随 `detail` 一起泄漏。
- **日志与 trace 去敏**：新增 `utils/logSanitize.ts`，请求日志与 span 只记路径 + 白名单 query 参数，其余键值记 `[redacted]`。此前 `/api/chat/stream?message=…`、`/api/stocks/search?keyword=…` 会把用户原文写进日志与 span。
- **`/api/ingest` 的 body 上限**：全局 100kb 会让真实 PDF（base64 后更大）必然 413；现只对该路径放行 8MB 并加大小预检，全局上限保持不变（不抬高所有路由的内存占用）。
- **无界增长收口**：成本台账、纸面盘订单/净值序列加上限（净值曲线保留最近 N 条、统计口径不受影响），估值分析的**负缓存加 TTL**（此前失败结果永久缓存，一次瞬时抖动会让该股估值一直走兜底到重启）。
- **审计与链路打通**：审计 helper 支持写入 `traceId`，quant 等路由从请求上下文透传，审计条目可回查请求链路。
- **`abortOnClientClose` 去重**：两份等价实现抽到 `utils/clientAbort.ts`（watchlist 与 quant 共用）。
- **自治循环披露裁剪**：清单超过单次上限时，状态响应里给出 `requested`/`skipped`，不再让用户以为监控覆盖了全部清单。
- **`watchlistLimiter` 补测**：该限流器的 429 分支此前零断言（测试配置把阈值放大到 100 规避了限流），现用独立文件在 import 前压回阈值 1 验证 429 + `Retry-After`。

**客户端：图表行为与可访问性**

- **`EChart` 改增量更新**：`notMerge:true`（每次整图重建）→ `notMerge:false` + `replaceMerge`，切换周期/叠加 MA/BOLL/MACD 时不再整图重建，同时保证系列数减少时旧系列被正确移除。
- **图表文本替代**：`EChart` 支持 `ariaLabel`，K 线图与回测曲线补上 `role="img"` + 说明（canvas 对读屏不可见，此前这些图等于不存在）；未传标签时不生成空名元素。
- **窄屏宽表滑动线索**：≤768px 给宽表容器加右侧内阴影，提示"还有列可以横向滑动"（此前只截断、无任何提示）。
- **对比部分成功的渲染测试**：补齐客户端用例（成功列保留、失败列标注原因并可单只重试、全部成功不出现失败标记、全部失败逐列可重试）——上一轮因 mock 路径与夹具问题删掉的那条，这次真正跑通。

**依赖与测试稳定性**

- **nanoid 跨主版本修正**：override 原为 `>=3.3.17`，实际解析到 6.0.1（ESM-only），而 postcss 声明的是 `^3.3.x`——`npm ls` 报 invalid，构建期 `require('nanoid/non-secure')` 失败。现改为 `^3.3.18` 并显式声明依赖，解析到 3.3.19。
- 移除无引用的 `@testing-library/user-event` 与重复声明的 `playwright`（`@playwright/test` 已传递依赖）；`.npmrc` 清理已不在树中的 esbuild 死白名单条目。
- 限流测试稳定性：这类用例每个都要 `resetModules` 后重新 import 整个应用，全量套件（181 文件并行）下会超过默认 5s 用例超时并间歇性假失败，已为相关文件设置 30s 超时。

## 2026-09-16 — 第二轮收尾：并发闸门 / 出站校验 / 复访入口（新增 237 个测试）

承接同日三批优化，把审计中**尚未落地**的项做完。测试 1654 → **1891 用例 / 172 文件**；覆盖率 lines 78.54% / statements 77.26% / functions 73.4% / branches 64.46%。

**服务端：资源上限与出站安全**

- **LLM 全局并发闸门**（新增 `utils/limitGate.ts`）：此前无任何全局并发上限，最坏路径（对比 3 只 × 8 专家 × 2 次尝试）会有 24~48 个调用直打上游，再叠加退避重试形成雪崩。现在超过 `LLM_MAX_CONCURRENCY`（默认 8 = 单次分析的专家并行度，不拖慢常见路径）即排队，排队超时返回 **429 + Retry-After**（`middleware.respondIfQueueTimeout`，analysis/chat/quant/market 路由统一接入）。闸门放在 LLM 出口而非各调用点：逐点限流必然漏。
- **入口参数限幅**：`/api/llm/ensemble` 的 `temperature` 夹紧到 [0,2]、`maxTokens` 封顶 4096（`LLM_MAX_TOKENS_CAP`），`messages`/`history` 加条数与字符上限——此前 `maxTokens` 可任意放大账单。
- **自选股容量与监控上限**：清单上限 200（`WATCHLIST_MAX`，超限返回可操作 400）、批量回测/监控单次上限 20（`WATCHLIST_MAX_CODES`，超出部分**如实披露 requested/skipped** 而不静默截断；之所以不整体 400：monitor 是定时器与自治循环的唯一预警通道）、并发夹紧到 [1,8] 并把请求 AbortSignal 下传到 socket 层（断开即取消在途取数）。
- **出站 URL 参数统一校验**（新增 `utils/stockCode.ts`）：此前 `1&lmt=99999` 这类入参可经 `secid=${secid}` 改写上游查询参数。intl/watchlist/quant 路由改用统一白名单校验；`dataProvider.resolveSecid` 补字符白名单兜底（保留 4~7 位等历史形态兼容）。
- **限流补齐**：健康/指标/契约端点 120/min（探针被限流会在监控侧伪装成故障）、写操作 10/min、只读元数据端点复用 30/min；`/api/health` 外呼加 60 秒 memo + 并发合流，并如实标注 `cached`/`checkedAt`，GET 不再写盘。
- **对比分析支持部分成功**：`Promise.all` → `allSettled`，单只失败只进 `failures`（`{code: 股票代码, error: 可读中文, errorCode}`），其余股票结果照常返回（全部成功时不出现该字段，老客户端零改动）；LLM 排队超时仍走 429 整批退避。
- **RAG 语料按文件失效**：目录签名由「mtime + 条目数」升级为逐文件 `mtime:size`，同名文件被覆盖后立即可见（此前最长 60 秒 TTL 内检索到旧内容）。
- 其余：`/api/compare` 的 `detail` 生产环境不再回传原始 message（与全局错误中间件口径一致）。

**前端：复访与打磨**

- **「今日」聚合页**（新增导航 tab）：自选股异动（持久化快照）+ 关注股观点变化（对比最近两次评分）+ 最近研究简报，三块数据源彼此独立降级（不因一个接口失败整页空白）。
- **在途分析恢复入口**：刷新/关页中断的分析会在下次进入时提示「上次对 X 的分析在 N 分钟前中断」，一键从服务端断点续跑（不重复支付已完成部分）；正常收尾即清除痕迹，断点过期则如实说明将重新开始。
- **`prefers-reduced-motion` 覆盖 JS 动画**：新增 `useReducedMotion()`，`useCountUp` 与全部 ECharts 图（5 张走势/财务图 + K 线 + 回测图）在减少动态偏好下关闭动画（此前 CSS 覆盖不到 JS）。
- **分析进度不再"卡在 95%"**：阶段内改用渐近推进（数学上永不抵达下一阶段起点，整数显示封顶），新增「本阶段已耗时」秒表与「预计还需（估算）」——后者由本机历史阶段耗时中位数推算，无历史时回退经验区间并明确标注。
- **审计日志分页**：显示「共 N 条 / 当前前 M 条」并支持「加载更多」追加（服务端暂无 limit/offset，客户端切片并在注释写明后端加上限时须改造）。
- **图表与着色口径统一**：`BacktestChart` 迁到 `EChart` 封装（统一 init/dispose/ResizeObserver），颜色走 `lib/colors.ts` 令牌；新增 `signCls`（红涨绿跌）与 `significanceCls`（显著性）区分——此前"正收益显示绿色"，把统计显著性配色当成了涨跌配色；"交易次数/回撤"等不再用涨跌色表达好坏。
- 对比单只失败时：失败列标注原因并提供「重试这一只」（复用同一批已成功股票凑数，命中服务端在途去重不会重跑）。

**工程化**

- 存量 lint 警告清零（research-agent 未用参数/导入、测试文件未用工具函数）。
- `e2e/global-setup.ts`：每次运行清空隔离目录（此前残留导致本地重复跑的顺序依赖），并按「源码是否比产物新」判断重建——此前 dist 存在即跳过构建，本地 e2e 可能在旧产物上"全绿"。
- 补齐路由级测试：`quant/analyze` 主路径、`market` 三端点、`health` 503 降级、限流 429 分支、对比部分成功契约、自选股容量、出站注入防护、健康探针 memo 等。
- `.env.example` 补 9 个新变量；OpenAPI 契约同步新增的 400/429 与跳过披露字段。

## 2026-09-16 — 三批优化：正确性 / 体验 / 工程化（新增 96 个测试）

起因是一次系统性体检（5 路并行代码审计 + 真实浏览器运行时实测）。实测同时推翻了三条"看起来严重但实际不成立"的初判：报告悬停每帧序列化大 option（实测 51 步悬停共 14.7ms、无长任务）、换股票会污染 localStorage（有卸载保护，实测未复现）、页面未做代码分割（早已 lazy + echarts 按需）。测试从 1553 → **1654 用例 / 148 文件**；覆盖率 lines 77.7% / statements 76.46% / functions 72.07% / branches 63.48%。

**正确性与可靠性（服务端）**

- **模拟盘入参校验**：`/api/paper/settle` 的收盘价此前未做数值校验，`{"600519":"abc"}` 会经 `NaN` 传染 cash/持仓/净值、落盘序列化成 `null` 且不可自愈 → 现在拒绝非正有限数与超量条目（上限 500）；下单接口补 `side`/`type` 枚举白名单（非法 `side` 曾可绕过 T+1）；落盘失败不再误报 400（避免用户以为没下单而重复下单）。
- **评级台账并发写保护**：`evaluateOutcomes` 是跨 `await` 的读-改-写，与 `recordAnalysis` 并发时会整份覆盖新记录 → 改为串行队列 + 写前按 id 重读合并。
- **分析 single-flight + 断点代次**：同代码并发分析（SSE + POST / 多标签页 / 对比）此前会重复付费调用 LLM，且 A 的专家结论可能被 merge 进 B 的断点 → 按代码共享同一轮结果，断点加 `runId` 与代次校验，tmp 名带代次。
- **两套缓存 pruner 互删**：`DATA_CACHE_DIR` 共用时 24h pruner 会删掉 30 天 TTL 的量化 K 线缓存 → 条目加 `kind` 标记互相跳过、容量只统计本类；`/api/health` 复用同一目录解析且 GET 不再写盘。
- **搜索关键词上限**（32 字符）：超长关键词会触发全表最长公共子串 DP（实测 1500 汉字约 0.5s）阻塞事件循环。
- **RAG 语料索引**：由「每条对话同步全量读盘」改为快照 + 目录签名失效 + 异步 IO（新增 `RAG_CORPUS_TTL_MS`，默认 60s）。
- **时区口径统一**：模拟行情生成此前用 UTC 判周末却用本地取日/月，非 UTC 宿主会产出不同序列（测试假失败）。
- **默认只监听 `127.0.0.1`**（新增 `HOST`）：系统无鉴权，绑定全网卡会让同局域网任何设备调用写接口。
- **可观测性**：metrics 路由表改为自动生成（OpenAPI 契约 + 运行时路由发现）、被客户端中断的长请求记 `status="aborted"` 并进耗时直方图、trace span 标记 `http.aborted`。

**体验（前端）**

- **报告时间语境**：结果新增 `generatedAt` / `dataAsOf`，报告头显示「数据截止 … 收盘 · 生成于 …」，超过 5 天提示可能滞后；导出 Markdown 同步带上时间戳。
- **「加载失败」不再伪装成「暂无数据」**：历史 / 自选股 / 量化页区分加载、成功、空数据、失败四态并给重试入口；量化页错误保留到下次成功或显式关闭，且支持同参数重跑。
- **tab 面板首次激活后常驻**：切走不再丢失已填参数与已出结果（「历史」例外——它无输入态且需取最新，进入即重新拉取）。
- **可访问性**：38 个表单控件补标签关联（`htmlFor`/`aria-label`）、tab 栏补 `role="tablist"` 与 ←/→/Home/End 导航、进度条补 `role="progressbar"`、专家观点折叠头由 `div` 改 `button`、移动端目录抽屉补 `Esc` 与焦点管理、分析进度补 live region。
- **移动端与打印**：修复量化页 390px 下 43px 横向溢出（根因是 grid 项默认 `min-width:auto`）、目录与「回到顶部」按钮重叠；`@media print` 整体重绑为浅色（此前深色主题会打印成白纸浅字）并补打印按钮。
- **其他**：异动预警落盘 + 自选股页常驻「最近监控」卡片（此前离开页面即失）、历史列表内联评分变化、因子实验室补「已耗时 + 取消」、快捷键（`Ctrl/⌘+K` 搜索、`Ctrl/⌘+Enter` 分析、`1`~`7` 切 tab）、`--text-muted` 对比度 3.56:1 → 4.91:1。

**工程化**

- **本地依赖与 lockfile/CI 对齐**：此前本地装的是 vitest 4.1.11 而 CI 用 5.0.0（8 个包版本滞后），本地绿灯不可迁移。
- 新增 `.env.example`（75 个变量分组注释）与 README「环境变量」章节；订正 README / ENGINEERING-NOTES 中的过期陈述（启动脚本"自动安装"、覆盖率阈值、lint 覆盖范围、Vitest 版本等）。
- **新增 SSE 链路测试**：`utils/sse.ts` 9 例 + `/api/analyze/stream` 5 例——此前旗舰流式链路（多事件分帧、断连协作取消、`resume` 契约）零测试。
- **CI**：`permissions: contents: read`、`npm audit --audit-level=high` 真实门禁（实测 0 漏洞）、构建产物在 job 间传递（e2e 省去重复构建，并加产物存在性校验防止 globalSetup 静默兜底重建）、e2e `--retries=1`。
- lint/format 覆盖 `e2e/` 与 `scripts/`；`scripts/dev.mjs` 退出时杀整棵进程树（此前 Windows 上 tsx/vite 残留占住 3001/5173，已实测确认并修复）。

## 2026-09-14 — 依赖批量升级：生产组 3 项（764bc51）+ 开发组 9 项（1d54b11）

- **生产依赖**（dependabot #15）：`express-rate-limit` 8.6.2 → 8.7.0、`react` / `react-dom` 19.2.8 → 19.3.0。
- **开发依赖**（dependabot #16）：`vitest` 4.1.11 → 5.0.0、`@vitest/coverage-v8` 4.1.11 → 5.0.0（跨大版本）、`vite` 8.2.1 → 8.3.0、`playwright` / `@playwright/test` 1.62.1 → 1.63.0、`eslint` 10.9.1 → 10.10.0、`oxlint` 1.80.0 → 1.82.0、`globals` 17.11.0 → 17.12.0、`@testing-library/user-event` 14.6.6 → 14.6.7。
- 合并时同步把根 `package.json` 的 `overrides.vite` 由 8.2.1 对齐到 8.3.0（与 `client` 的 vite 一致，避免 vitest 拉到 6.x 造成 hoist 冲突）。
- 说明：两个提交本身只改依赖清单与 lockfile；此处如实记录版本变化，未附测试结论（本次编辑按约定不运行 npm/vitest）。

## 2026-09-13 — 文档校准：测试口径统一 + 研究 Agent / MCP 工具数补录（15fe3b7）

- 统一测试用例数口径：README 徽章与正文此前不一致（徽章 1370 / 正文 923），统一为 **1553 用例 / 140 个测试文件**（研究 Agent 批次后的实际数量）。
- `server/src/research-agent/` 补进 README（核心特性段落 + 代码示例入口），并在 CHANGELOG 补录该批次。
- MCP 工具数订正：`mcp/server.ts` 实际暴露 **9 个**工具（此前文档写 5 / 8），并补上 `quant_factor_expression_batch`。
- `client` 的 vite 由浮动版本 pin 回 **8.2.1**，与根 `overrides` 及 lockfile 对齐。
- `.github/workflows/ci.yml` 注释与根 `package.json` 对齐（根已无 `allowScripts` 字段，`--dangerously-allow-all-scripts` 是唯一放行手段）。

## 2026-09-13 — README 补记 pdfjs-dist 为 PDF 入库的可选依赖（151bef0）

- README 的可选增强说明此前只覆盖 Baostock 侧车，未提 **PDF 抽取依赖 `pdfjs-dist`**（`server/src/quant/pdfExtract.ts` 以动态 import 加载，未安装时不影响构建与其余功能，但该入口会抛出明确错误并提示改用纯文本入口，不静默降级）——本次补上该说明。

## 2026-09-12 — 多步研究 Agent 规划层：AlphaSense 式四阶段编排

- 新增 `server/src/research-agent/`（19 个文件，含独立 `DESIGN.md`）：把「研究问题 → 结构化研究报告」拆为 **Planner → Retriever → Verifier → Synthesizer → Report** 四阶段可观测编排。`ResearchOrchestrator`（`orchestrator.ts`）持有事件总线（`AgentEvent`）、运行统计（`RunStats`）、终止门与 replan；证据模型强制携带 `SourceRef` + `AcquisitionPath`（轮次 / 查询词 / 适配器 / 尝试次数 / 降级链），可信度 = 来源层级基准分 × 时效衰减，不与 LLM 自评耦合。
- 收敛与兜底：四重终止条件（P0 全部达标 / 连续 N 轮无新证据 / 达 `maxRounds` / 无待办任务）保证有限轮数内产出结果；证据不足自动触发补充检索，检索失败或持续证据不足触发 replan（计划版本化修订，**P0 不可被丢弃**）；结论编排对 `keyEvidenceIds` 做存在性校验，编造 ID 一律剔除并回退到验证采信集合；检索失败、证据不足与未决冲突全部进报告 `limitations`。
- 公共 API 出口 `index.ts`：`ResearchOrchestrator` / `EvidenceRetriever` / `createPlan`·`revisePlan` / `verifySubQuestion`·`computeEvidenceStrength`·`buildSupplementHints` / `synthesize` / `renderReportMarkdown` / `completeJson`；LLM 与检索适配器为接口定义，具体渠道由调用方注入。
- 测试 +58（7 个文件：15 项编排 e2e + planner/retriever/verifier/synthesizer/utils/report 单元测试），全套 **1553 通过**；模块逻辑覆盖率 lines 98.1% / functions 97.5% / branches 92.2%。

## 2026-09-12 — 内置估值建模：两阶段 EPS 贴现 + 可比公司表

- `quant/valuationModel.ts`（纯函数零依赖）：`twoStageEpsDcf`（显性期 + Gordon 终值，
  g2 ≥ r 直接抛错不输出发散值）、`sensitivityMatrix`（r × g1 逐格独立计算，非法格 NaN）、
  `buildComparableAnalysis`（同业过滤非正估值后取中位数，本股折溢价 + 中位 PE 隐含价值）、
  `runValuationModel` 组合入口（基期 EPS 取最新年报，显性期增速取 EPS 3 年 CAGR 钳制
  [-20%,30%]，可整体覆盖；局限声明随结果 limitations 返回）。
- `POST /api/quant/valuation/model` + Chat 工具 `run_valuation_model`；前端估值面板
  （QuantPage 常驻）输出内在价值/现价溢价、逐期现金流表、敏感性矩阵与可比表。
- 实测（600519）：EPS 65.66 自动推导、g1=9.56%（3 年 CAGR）、内在价值 1489.81 vs 现价
  1275.16（+16.8%），可比 4 家中位 PE 17.57（本股溢价 +11.4%）。
- 修一个实现 bug：epsCagr 运算符优先级（Math.round(x)*100/100 恒为 0）→ round4；
  窗口语义改为「最近 years+1 个有效值」。
- 测试 +12（DCF 手工算例对照/发散校验/矩阵/可比表/自动推导），全套 1495 通过。

## 2026-09-12 — 公告全文通道 + 港美股 K 线 + 数据来源溯源表

- `quant/announcementProvider.ts`：东财公告网关适配（列表 np-anotice-stock / 正文
  np-cnotice-stock），列表 24h、正文 30 天（不可变）缓存；`buildAnnouncementBrief`
  组装「标题一览 + 最新一篇正文摘录」语境块（原文口径截断标注，不做摘要改写）。
  接线 `GET /api/quant/announcements`、分析管线（限时 6s 降级）、Chat 工具
  `get_recent_announcements`。
- `GET /api/intl/klines`：港美股日 K 线，secid 映射（HK=116.x / US=107.x）后复用
  dataProvider.fetchKlineBySecid（导出原有私有函数），缓存合并与 look-ahead 防御与
  A 股同一实现；模拟盘港美股查询结果区新增近一年收盘价曲线。
- 数据来源溯源表：`DataSource` 增加 `coverage`（覆盖的报告模块），报告页由 chip 列表
  升级为「来源 × 说明 × 覆盖范围 × 置信度」表格；公告/新闻/一致预期按可得性条件出现。
- 测试 +10（公告列表/正文/语境块/校验、港美股 K 线 secid 映射与代码校验），全套 1483 通过。

## 2026-09-12 — 研究简报定时闭环 + Chat Agent 量化工具接入

- `quant/researchDigest.ts`：研究简报（初筛最新状态 + 实验台账概览 + 与上一份的增量说明），落盘与 factorLedger 同模式（env 重定向 + 原子写 + 容量 60）。`startDigestScheduler` 由 `QUANT_DIGEST_INTERVAL_HOURS` 控制（默认 0 关闭），接线 `GET /api/quant/digests` 与 `POST /api/quant/digests/run`，前端新增简报面板（截面模式页）。
- Chat Agent 新增 4 个 function-calling 工具：`get_screener_latest`（初筛最新结果）、`get_factor_experiments`（台账概览）、`run_timeseries_analyze`（时序计量，与 HTTP 端点同口径）、`list_recent_digests`（简报列表）；deps 注入可 mock。
- 时序计量入口收敛到 `quant/timeseries/analyze.ts`：HTTP 路由与 Chat 工具共用同一实现，消除参数校验与窗口口径的漂移面；HTTP 层退化为薄包装（错误按数据不足/参数类映射 502/400）。
- 组合回测参数化 UI：截面面板内可调调仓周期/持仓只数/单边成本（请求与展示同一 state，非法输入钳制回默认）。
- 测试：+14（简报聚合/增量/轮换/调度开关、4 个新工具分支），全套 1473 通过。

## 2026-09-12 — Baostock Python sidecar：指数历史成分宇宙接入（本批）

- **幸存者偏差的正面修复落地**：Baostock `query_hs300/zz500/sz50_stocks(date)` 提供任意历史日期的指数成分快照，**含其后退市的证券**（实测 2015-06-30 沪深300 成分含 2016 年退市的武钢股份）——东财免费通道与 Tushare 免费积分（index_weight 无权限）都给不了的数据。
- `server/scripts/baostock-sidecar.py`：一次性进程，stdin/stdout JSON 协议，第三方噪声全重定向 stderr；运行目录切到临时目录防日志污染；字段实测（updateDate/code/code_name，code 归一 6 位数字码）。
- `quant/baostockBridge.ts`：spawn 桥接（60s 超时、ENOENT 友好指引 PYTHON_BIN）、**不可变快照 30 天缓存 / 最新快照 24h**（QUANT_BAOSTOCK_CACHE_TTL_HOURS 可覆盖）、上游失败回落陈旧缓存、同 key 并发去重。
- 接线：`resolveUniverse` 新增 `indexUniverse` 源（{index, date?}）——截面/表达式/批量三路由与 MCP 工具同步支持；健康检查新增 baostock 块（hs300 端到端探针，含陈旧兜底）；截面幸存者声明按源区分口径（index 源声明「含其后退市证券，缺 K 线者如实跳过」）。
- 客户端：截面页新增「指数历史成分」源（指数下拉 + 快照日期选填）。
- 实测：hs300@2024-06-28 → 300 只（updateDate 2024-06-24）、zz500 最新 500 只；错误路径 JSON 化。

## 2026-09-12 — Tushare token 配置 + 适配器实机验证接线（本批）

- token 注入 `server/.env`（gitignored，不入库），`.env.example` 补文档块。
- **免费积分频控实测**：`stock_basic` 1 次/小时（40203，报错文案随用量从 1 次/分钟升级）；
  `index_weight` 免费积分**无权限**（40203「没有接口访问权限」）——历史成分缺口需充值积分或走 Baostock。
- 适配器加 `*Cached` 包装：24h 磁盘缓存（`QUANT_TUSHARE_CACHE_TTL_HOURS` 可覆盖）+ 上游失败回落陈旧缓存 + 并发去重；请求路径禁止直连裸函数（头注释写死纪律）。
- 接线：`/api/quant/health` 新增 `tushare` 块（配置态 / 上市·退市·暂停计数 / 失败降级披露，不影响 preflight.ok）；截面响应幸存者偏差声明在 token 可用时附退市股名单规模。
- 实测：`stock_basic` L=5562 只（含行业）；缓存/陈旧兜底/并发去重 + TTL=0 旁路 + health 双路径 单测覆盖。

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
- **MCP server**（`mcp/server.ts`，`npm run mcp:serve`）：stdio JSON-RPC 薄适配器，9 个工具暴露给 Cursor / Claude Code / Cline。

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
