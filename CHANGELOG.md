# Changelog

股票研究系统（多专家投研 + 量化回测）变更历史。
按日期倒序；commit 为完整短哈希。详细工程决策与踩坑记录见 `docs/ENGINEERING-NOTES.md`。

## 2026-10-06（第六轮补）· 生产代码软逃逸 10 → 1，顺带抓出 8 处「测试桩在撒谎」

**背景**：上一轮把测试代码的 `as never` 清零（114 → 0）后，剩下生产代码里的
10 处 `as unknown as`（当时整体标注为「模块替身 / 动态 import 的必要代价」）。
本轮逐处核实，**发现该判断只对 1 处成立**——另外 9 处在掩盖真实问题。

**逐处核实结果**

| 位置 | 断言掩盖了什么 | 处理 |
| --- | --- | --- |
| `chatAgent` + `llm/tools` | **最有价值的一处**：`runBacktest` 声明为 `(unknown, unknown) => Promise<unknown>`，真实实现是 `(OHLCVData[], StrategyConfig) => BacktestResult`，且**同步**返回 | 收紧 `ToolDeps` / `ChatAgentDeps` 两处签名，用 `import type` 挂真实类型（编译后擦除，不破坏「tools.ts 不 import 重型模块」的设计原则） |
| `analysisPipeline` | `promise: undefined as unknown as Promise<...>` 是一句**类型谎言**——构造时该字段真为 `undefined` | `promise` 改可选 + 读取处 `!`，让「此刻尚未赋值」对类型系统可见 |
| `quantOps` | `parseStrategyInput` 本就返回 `StrategyConfig`，断言纯属多余 | 直接赋值 |
| `crossSectionBuilder` | `Object.fromEntries` 返回 `{[k: string]: T}`，无法表达键的字面量联合 | 改用带显式累加器类型的 `reduce`，顺带让「新增因子漏初始化」会报错 |
| `TodayPanel` | 自定义了字段更松的局部 `AlertItem` 再断言转换——契约改名时编译器无声 | 删掉局部类型，直接用契约生成的 `WatchlistAlert` |

**签名收紧的连锁反应：抓出 8 处「测试桩在撒谎」**

`ToolDeps` / `ChatAgentDeps` 收紧后 tsc 逐条报出所有不符的桩，全部同类：

- `runBacktest: async () => ({ sharpe: 1.2 })` —— 谎称**异步**（真实同步返回），
  且 `sharpe` 这个字段**根本不存在**（真字段是 `sharpeRatio`）
- `parseStrategyInput: (s) => ({ stockCode, strategy })` —— 返回的不是
  `StrategyConfig`，缺 `name` / `type` / `params` / `startDate` / `endDate`
- `fetchOHLCVData: async () => []` —— 返回 `unknown[]` 而非 `OHLCVData[]`

新增 `server/src/test/depStubs.ts` 提供形状完整的桩工厂
（`backtestResultStub` / `strategyConfigStub` / `barsStub` / `parseStrategyStub`）。
两处声明（`ToolDeps` 与 `ChatAgentDeps`）现在必须一致——不一致时
`productionDeps` 赋值会报错，这正是我们想要的。

**唯一保留的 1 处**：`quant/pdfExtract.ts` 用 `await import(spec)` 动态加载
**可选依赖** pdfjs-dist（未安装时构建不能失败），specifier 存于变量以免被
静态解析。此时 import 返回值只能是 `any`，断言用于收窄到手写形状——真正的类型擦除。

**守卫变化**：软逃逸基线 10 → **1**，并反向验证过（注入一处后立刻变红）。
新增 EXEMPT：`depStubs.ts` / `client/src/test/setup.ts`（jsdom 全局桩）/
`client/src/test/partial.ts` —— 它们不是 `*.test.ts` 但性质是测试基建，
按「文件名排除测试」的规则会被误算进生产代码。

**方法论：软逃逸不是「必要代价」，而是发现问题的入口**

上一轮把 10 处软逃逸整体标注为「无法消除」是不对的。`as unknown as` 的危害
不是「不好看」，而是**让签名漂移无人察觉**——本轮 8 处测试桩问题正是被它
掩盖的。逐处核实「这个断言是否真的必要」比整体豁免有用得多。

## 2026-10-05（第六轮）· 类型逃逸清零：114 → 0，并因此抓出 4 处真实桩缺陷

**背景**：上一轮接入契约校验时抓出 12+ 处「测试桩 ≠ 契约」，根因都是
`as never`。当时只把生产代码的逃逸清零（3 → 0），测试侧留了个
「基线 25，只许减不许增」的守卫。收尾时核实这个守卫，发现它**本身就是坏的**。

**守卫坏在哪（两次改错，第三次才对）**

1. 第一版基线写 **82**，但统计范围是 `server/src/**` 全递归，而守卫实际只扫
   `server/src/__tests__/` 顶层。**基线虚高 = 门槛形同虚设**，涨到 82 都不红。
2. 第二版把范围「对齐」成 25 —— 看似修好，实则更糟：`llm/__tests__`、
   `quant/__tests__`、`services/__tests__`、`client/src/**` 全部脱离监管，
   合计 86 处逃逸无人看管。**先让守卫能测准，再谈基线数字。**
3. 第三版改成「server/src + client/src + e2e 下全部 `*.test.ts(x)`」，
   实测真实存量 **114**，基线随之写 114。然后逐个清掉，最终基线设为 **0**。

**清理方式：补基础设施，不加豁免**

- 新增 `server/src/test/partial.ts` 与 `client/src/test/partial.ts`：
  `partial<T>()` / `partialList<T>()` / `reqOf()` / `mwReq()` / `mwRes()` /
  `jsonResponse()`。把「构造不完整的测试替身」所需的类型擦除**集中到一处**，
  调用点保留强类型提示 —— 字段名拼错仍会被拦，只有「缺字段」被有意放过。
- `contractFixtures.analysisResult` 返回类型由 `Record<string, unknown>`
  改为 `AnalysisResult`，工厂自身开始受编译器约束（调用点的 `as never` 随之消失）。
- 多个本地工厂补上返回类型标注（`reg(): ModelSpec[]`、`compositeResult(): CompositeAlphaResult`、
  `makeData(): CheckpointDataPayload` 等），不匹配在**定义处**报，而非在每个调用点靠断言蒙混。

**清出来的 4 处真实缺陷**（都是 `as never` 长期掩盖的）

| 位置                       | 问题                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HistoryPage.test.tsx`     | 断言写 `{ stock_pool: [{ id: 'h2' }] }`，而真实字段是 `stock_code` —— 断言在验证一个不存在的结构                       |
| `analyzeStream.test.ts`    | 完成事件的 `AnalysisResult` 缺 `data_sources` / `research_confidence` / `limitation_explain`，契约扩字段后该用例没跟上 |
| `ChartsSection.test.tsx`   | `peerComparison` 桩多写 `pb` / `roe` / `marketCap` 三 个组件根本不读的字段                                             |
| `intlDataProvider.test.ts` | 「港股代码映射 116.\*」用例**丢了 URL 断言**——用例名断言的东西没在断言                                                 |

**方法论：清 `as never` 后必须立刻 typecheck**

把 `as never` 换成 `partial<T>()` 后忘加 import，`jsonResponse` 未定义 →
`ReferenceError` 被被测代码的 `catch` 吞掉 → 走「降级模拟数据」分支 →
**用例仍绿，但拿到的是 9 条 `isSimulated: true` 的假数据**。
是 `typecheck` 立刻报出「Cannot find name 'jsonResponse'」才发现的。
这与本项目反复出现的「假绿灯」同源：**任何清理动作都要有独立的验证门禁**。

另一处类型陷阱：`partial.ts` 里 `Request` / `Response` 同时匹配 express 与 DOM
两个同名类型，报错是「缺 93 个属性」，方向完全误导。已显式
`import type { Request, Response } from 'express'`，fetch 桩另用
`FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>`。

**门禁**：`typecheck` / `typecheck:tests` / `lint`（0 warnings）/ `format:check` /
`check:api-types` / `smoke:contract`（29 端点 0 不符）/ 全量 vitest 全绿。

## 2026-10-04（第五轮）· 类型生成：契约成为唯一权威来源，并抓出 9 处真实契约 bug

**背景**：上一轮补全了 25 条遗漏路由（契约的 paths 覆盖 app 实际挂载的 64 条），
但动手做类型生成前先核实前提，发现**响应体契约几乎是空的**：64 个 operation 里
只有 2 个的 200 响应带 schema，其余 62 个只有一句 description。直接上生成器
只会产出 62 个 `unknown`——生成器能用、类型不能用。

**做法（三段）**

- **补齐 62 个成功响应 schema**。逐条读 handler 与其调用的 service 补写，
  复用 `components/schemas` 里的具名组件（`$ref`），不内联展开。
- **自研生成器** `server/src/services/apiTypeGen.ts` + `scripts/generate-api-types.mts`，
  输出 `client/src/api/generated.ts`（**212 个类型**：61 个 operation 响应 +
  RequestBody + Params + 组件）。
- **前端接入 + 双向守卫**：`client.ts` 改用生成的端点类型；
  `client/src/api/contractParity.ts` 对 8 个同名类型做**双向赋值**等价检查（编译期）。

**为什么自研而不引依赖**：`ts-json-schema-generator` / `openapi-typescript` 的输入是
**TypeScript 类型**，而本项目的权威来源是 **OpenAPI 文档**（方向相反）；且本机
`typescript@7`（Go 原生移植版）**只导出 `version` / `versionMajorMinor`**，
没有 `createProgram` 等反射 API，无法从注解反推 JSON Schema。方向既定，
几百行生成器比引入一个用不上的依赖更划算。

**补 schema 时抓出 9 处真实契约 bug**（这才是重点——不是走过场）

1. `horizons` 声明成 `string[]`，而 `parseHorizons` 收的是**整数数组**；
   且 5 处各内联写一遍、其中 3 处连类型都写错 → 抽成共用 `horizonsSchema`。
2. `IntlFundamentalsResult.fundamentals` **只在 description 里写「可能为 null」**，
   schema 却是非空 `$ref`。生成出的类型非空，消费方照契约写代码遇到降级响应就崩。
   **可空必须写进 schema**（改为 `oneOf: [$ref, {type:'null'}]`）。
3. `ScenarioResult` 漏 `supportingArguments`；`preconditions` 被误标可选。
4. `FinancialData` 漏 6 个服务端确实返回的字段。
5. `IntlFundamentals` 漏 4 个必填字段。6. `ChartConfig.config` 必填性不符。
6. `DataQualityFlags` 前端标可选、服务端必填。
7. `WatchlistMonitorResult.generatedAt` 实际可为 null，前端写成必填 `string`——
   这正是 `client.ts` 里那个 `Omit<...> & {generatedAt: string|null}` 绕行类型的由来；
   根因修好后该绕行类型已删除。
8. `IntlKline` 前端手写版漏 `isSimulated`（上游失败会降级为模拟 K 线），
   等于丢掉了"提示用户这是假行情"的能力。

**两个关于"守卫"的教训（本项目最容易复发的坑）**

- `type _X = A extends B ? true : never` 这种写法**永远绿**：TS 对未加约束的
  条件类型不做求值检查，一个明显不成立的关系也能编译通过。那是虚假安全感，
  比没有守卫更危险。
- 社区流行的 `Equal<X, Y>`（互斥签名）在本项目**误报**：两侧各自声明了同名
  `PaperPosition` / `FinancialData`，形状逐字相同，但两次独立声明 → identity 不同 → false。
- 最终采用**双向赋值**（`declare const a: B = g` 两个方向），实测对"形状相同但
  分别声明"放行、对字段增删/可选性变化报错。**任何守卫都必须先反向验证它会红**——
  `apiTypeGen.test.ts` 末尾有 4 条专门做这件事的用例。

**顺带修掉一个假红灯**：生成器最初只取 `content['application/json']`，
于是两个 SSE 端点（`text/event-stream`）被误判成"没写 schema"。假红灯和假绿灯
一样有害——前者会让人去改本来正确的契约。

**接线**：`npm run generate:api-types`（生成）/ `npm run check:api-types`（只比对）；
CI `quality` job 新增一步 `check:api-types`，改了契约没重新生成会拦住合并。
生成物**提交进仓库**（不 gitignore），让契约↔类型的漂移在 PR diff 里直接可见。

## 2026-10-04（第四轮）· OpenAPI 契约补全 25 条遗漏路由，并加双向漂移守卫

**背景**：上一轮我给出的建议是「若要做全量 schema 层，正确切入点是从
`/api/openapi.json` 生成类型 + 共享 DTO 包」。动手前先核实这个前提是否成立——
结果不成立，于是先修前提。

**发现**：`services/openapi.ts` 头部写着「API 形状的唯一权威来源」，但
app 实际挂载 **64** 个路由条目，规范只写了 **37** 个。缺口包括量化因子/台账/简报、
LLM 集成与校准、技能路由、改进闭环全套、intl K 线、全市场初筛等 25 条。
更关键的是**没有任何测试能发现**：`openapi.routes.test.ts` 只校验一份
硬编码的 24 条「README 核心端点」清单——而 README 表格本身早就把 endpoints
写全了，所以人读文档觉得「都写了」，只有机器可读的规范是残缺的。

**做法**

- **补录 25 条契约**，逐条读 handler 实现后按实际语义写（不靠猜）：请求体字段、
  状态码分支、以及几条容易写错的语义——例如 `/api/llm/ensemble` 的
  temperature/maxTokens 越界是**夹紧 + 记日志**而非报错；`/api/intl/klines`
  传 A 股代码返回 400 而非降级数据；`/api/quant/announcements` 不传 artCode
  时 code 必须是 6 位 A 股代码。
- **加「与实际挂载路由一致」守卫**：从 `app` 的真实路由表反推，与规范**双向**比对
  （路由有而规范缺 / 规范有而路由不存在），并附一条「实际路由数不为 0」防止
  枚举逻辑本身失效导致假绿。失败信息直接给出该补哪个 `paths` key。
  这条测试**做过反向验证**：临时删掉一个契约条目，确认它确实变红并指名道姓，
  而不是永远通过。

**为什么值得单独做**：上一轮我建议的切入点（从 openapi.json 生成类型）完全依赖
规范完整——规范缺 25 条，生成出来的类型也会缺 25 条。先把权威来源修对，
下一轮做类型生成才有意义。同时这份「唯一权威来源」的自我声明此前名不副实，
现在才真的成立。

**门禁（实跑）**：`npm audit` 0 漏洞 / lint 0 警告 / 双端 tsc 0 / 格式全过 /
**244 文件 3376 用例全绿** / 双端 build 通过 / 体积预算通过。

## 2026-10-04（第三轮续）· 鉴权补齐浏览器侧：上一轮的服务端鉴权实际上把用户锁在了门外

**背景**：上一轮把 API 访问令牌做完了服务端，中间件单测全绿、真实进程冒烟也通过。
本轮复核「用户照文档配好之后实际会怎样」，发现**功能是坏的**：浏览器端零令牌支持。
一旦真的配上 `API_AUTH_TOKEN`，前端 axios 不带凭据、没有录入入口、401 也无任何提示——
用户打开自己的系统只看到满屏报错，无从下手，只能去翻 `.env` 手动改回来。
**这比不加鉴权更糟**：安全功能把自己变成了路障。中间件测试发现不了，
它们只验证服务端契约，不涉及浏览器能否自动携带凭据。

**补的四件事**

- **axios 请求拦截器统一注入令牌**。REST 端点有 30+ 个，逐个传参会留下"某处忘传"的
  永久坑（表现为某个页面莫名 401，几乎无法定位）。拦截器是唯一能保证新增端点默认
  就带鉴权的位置。用 `headers.set()` 而非展开合并——axios 的 headers 是 `AxiosHeaders`
  类实例，展开会丢掉 `set/get/has`。
- **SSE 走 `?token=`**。浏览器 `EventSource`（消费 `text/event-stream` 的原生 API）
  **不允许自定义请求头**，这是平台约束，故分析/对话两个流式端点用 query 传令牌。
  服务端**只接受 GET 的 query 令牌**，写操作不认（只多泄漏面、无收益）。
  日志侧无需额外处理：`token` 不在 `logSanitize` 白名单内，请求日志与 telemetry span
  都会抹成 `[redacted]`，并加断言钉死（否则日后有人把 token 加进白名单即等于把凭据写进日志）。
- **解锁条默认不渲染，捕获到 401 才出现**（任意 REST 401 → 全局广播）。
  本系统默认不鉴权，无条件弹窗等于让每个本地用户都多点一次；未启用鉴权的用户
  完全看不到它，行为与加这个组件之前逐字相同。
- **解锁后整页重载**而非局部重试：解锁前已失败的请求散落在各页面 `useEffect` 里，
  逐个重试覆盖不全，重载让它们自然重发。

**顺带修掉的两处**：4 个 axios 测试桩缺 `interceptors`（新增拦截器后集体起不来；
已内联补齐并注明为何不能抽公共 helper——`vi.hoisted` 在 ESM import 之前执行）；
一处 UTF-8 坏字。

**测试超时的定位**：`auditLog.persistence` / `rag.corpus` / `paperTrading` /
`fileCachePrune` / `compositeService` 曾在**全量跑**时随机红、**单独跑必绿**。
根因是资源争抢而非逻辑：一次要 spawn 244 个 worker，磁盘密集的用例（`fs.rmSync` 递归清理、
快照落盘往返）顶穿默认 `hookTimeout` 10s / `testTimeout` 5s；而 `test:coverage` 额外挂 v8
插桩后执行普遍变慢一倍以上，更容易触发。已分别放宽到 60s / 30s 并注明理由。
放宽不掩盖真卡死——死循环的用例不会返回，仍会被整体超时或 CI job timeout 兜住。

**E2E「卡住」的排查**：本机跑 Playwright 曾十几分钟无输出。逐层定位后确认是环境问题，
不是用例问题：环境设了 `HTTP_PROXY`/`HTTPS_PROXY` 却**没有 `NO_PROXY`**，webServer
的就绪探针访问 `127.0.0.1` 也走代理，于是「服务已起但探针看不见」形成死锁
（同一地址 `curl` 走代理 502、`--noproxy '*'` 200）。补 `NO_PROXY` 后 12 条一次全过。
另有两处连带坑记在 `docs/ENGINEERING-NOTES.md` ⑫（globalSetup 重建触发删除守卫
而静默挂起、被强杀跑次残留的 `test-results` 挡住下一轮）。

**本轮门禁结果（均为实跑）**：`npm audit` 0 漏洞 / lint 0 警告 / 双端 tsc 0 /
格式全过 / **244 文件 3372 用例全绿** / 覆盖率 lines 93.83% statements 91.92%
functions 94% branches 82.25%（四项均过阈值）/ 双端 build 通过 /
体积预算 17 个产物全过（合计 1242.54 kB / 预算 1300 kB）/
Playwright `--retries=1` **12 条全过**（真实构建产物 + 真实进程 + 真实浏览器）。

## 2026-09-28（第三轮）· API 访问令牌：把"暴露到本机之外"变成有意识的选择

**背景**：此前 API 层完全开放。本机自用没问题，但一旦内网穿透 / 公网 / 团队共享，
等于把自选股、分析、**会烧钱的 LLM 调用**、模拟盘与文件检索接口全部开放。

**做法**：做成默认关闭、显式启用，而不是"强制鉴权"或"继续不管"。

- 未设 `API_AUTH_TOKEN` 时中间件完全放行，**行为与加它之前逐字相同**——不影响本地开发，
  也不影响既有用例。零回归就是这条不变式的证据（新增 19 条后 2334 条全绿）。
- 比较用 `timingSafeEqual` 而非 `===`：逐字符比较会因首个不同字节的耗时差泄露 token 前缀，
  公网可自动化利用；长度不同直接判否。401 响应不回显期望值。
- 豁免范围刻意极小：**仅** `OPTIONS` 预检与 `/api/health`（容器/负载均衡探针不能要求令牌）。
  并加反断言，确保 `/api/healthz` 这类名字相近的路径不被顺手放行。
- 已用**真实构建产物 + 真实进程**冒烟验证：无令牌 401 / 错令牌 401 / 正确令牌 200 / health 200。

**一个被测试抓出来的坑（值得记）**：中间件挂在 `app.use('/api', guard)` 上，而 Express 会把
`req.path` 改写成**相对挂载点**的路径（`/api/health` → `/health`）。最初按 `req.path` 匹配
豁免前缀时永远匹配不上，探活会被 401 拦掉——而这正是免鉴权豁免最不能失效的地方
（探针拿不到 401 以外的响应就会判定服务挂了）。改用 `req.originalUrl` 后修复。
教训：豁免路径必须同时配"子路径也豁免"和"名字相近的路径不豁免"两条**相反方向**的断言，
只写前者锁不住。

**本轮门禁结果（均为实跑）**：`npm audit` 0 漏洞 / lint 0 警告 / 双端 tsc 0 / 格式全过 /
**178 文件 2334 用例全绿** / 双端 build 通过 / Playwright `--retries=1` 12 条全过。

## 2026-09-28（续）— 结构拆分与 CI 门禁：路由按领域拆分、自省阈值可单测、体积预算、依赖审计清零

上一轮修的是"静默失效"（丢数、500 掩盖 429、伪研判、失效的 lint 规则），
本轮处理剩下的结构问题，并**把 CI 从"审计门禁会红"修到全绿**。

**① `routes/quant.ts`（2102 行）按领域拆分**

一个文件里混着 24 个路由、5 个领域。现拆为 `quantCore.ts` / `quantCrossSection.ts` /
`llmAdmin.ts` / `quantOps.ts`，`quant.ts` 退化为组合根；跨领域共用的 23 个辅助声明
（取数扇出 / 入参校验 / 模拟数据闸门 / 台账留痕）移到 `services/quant/panelService.ts`
——它们是业务规则，留在 routes/ 下既无法直接单测也会被各领域复制成多份分叉。
各子模块用绝对路径注册自己的 Router，`index.ts` 仍只需一行 `app.use(quantRouter)`，
**对外 HTTP 契约零变化**。正确性以「与原文件逐行比对、未解释丢失行数为 0」验收。

**② 自省阈值抽成纯函数（`services/analysisReflection.ts`）**

「双层自省 + 逻辑闭环」里的阈值（现金流/利润 0.5 与 0.9、毛利率波动 10 点、PE 分位 20/80、
营收增速 5%、反对论点置信度 65）原先内联在 780+ 行的 `executeAnalysis` 里，改一个阈值
无法写断言。抽成无 IO 的纯函数后补 24 条测试，并顺带消掉一处真实重复：
风险条目提取原先在自省文案和 `risk_list` 各抄了一份，阈值漂移会让两者对不上。

**③ 校验收敛**：5 个文件里 15 处各写一份的 `/^\d{6}$/` 统一走 `utils/stockCode.isAShareCode()`
（复用同一个正则，语义逐字等价）。

**④ 客户端**：`mountedTabs` 改为 keep-alive 白名单（此前访问过的页签永久常驻，
隐藏的量化页一直跑定时器）；`manualChunks` 从子串匹配改为按真实包名分组；
新增 `check-bundle-size.mjs` 体积预算并接入 CI——原来的 `chunkSizeWarningLimit: 1000`
之下，626 kB 的 echarts chunk 从不报警，而 warning 本来也不会让 CI 变红。

**⑤ 依赖审计此前是红的**：`npm audit --audit-level=high` 报 1 高（`brace-expansion` DoS）+
1 中（`ip-address` SSRF），**CI 审计门禁会直接失败**。`npm audit fix` 做了补丁级升级
（`brace-expansion` 5.0.9→5.0.12、`ip-address` 10.4.0→10.7.3，均为传递依赖），
现 `found 0 vulnerabilities`，升级后全量用例与 e2e 均复跑通过。
（后续 Dependabot 独立提交了同两项的 5.0.12 / 10.7.2 升级，合并时 lock 的 `ip-address`
取更高的 10.7.3。）

**⑥ 两条钉死文件名的结构断言测试**改为扫整个目录并加反断言——拆分后不再假绿，
今后再拆文件也不用维护文件名清单。

**⑦ vitest worker 池实测后决定不改**（详见 `docs/ENGINEERING-NOTES.md` 第 ⑥ 条）：
threads 更快且本次零错误，但 `isolate: true` 不保证 `process.env` 隔离，
而本仓库测试大量注入 env，正确性风险不值得那 80 秒。

**本轮门禁结果（均为实跑）**：`npm audit` 0 漏洞 / lint 0 警告 / 双端 tsc 0 /
格式全过 / **240 文件 3312 用例全绿** / 覆盖率 lines 93.88% · statements 91.96% ·
functions 94.12% · branches 82.25%（四项阈值均过）/ 双端 build 通过 / 体积预算 1238 kB
（上限 1300）/ Playwright `--retries=1` 12 条全过。

## 2026-09-28 — 一轮加固：覆盖率分母纠正、四处静默失效修复、客户端基建补齐

以「先复现再改」为准绳的一轮加固。所有改动都有对应的新增测试，全量门禁通过
（lint / 双端 tsc / 双端 build / 238 文件 3279 用例 + 覆盖率阈值 / 12 条 Playwright）。

**① 覆盖率门禁的分母纠正（本次最重要的改动）**

- 旧配置把 `server/src/routes/**` 整目录排除在覆盖率分母外（13 个文件、3758 行，
  含 2100+ 行的 `quant.ts`），理由写的是「由 supertest 集成测试覆盖」。
  **排除意味着这些行既不占分母、也不构成门禁**——体量最大的业务逻辑文件恰好在盲区里。
- 实测纳入后仅降约 1.3 个点，四项阈值**全部仍通过**（说明该目录本就由
  `server/src/__tests__/*.routes.test.ts` 真实覆盖）。新基线：
  lines 93.81% / statements 91.88% / functions 94.08% / branches 82.09%。

**② 校准数据静默丢数（`llm/ensemble.ts`）**

- 全仓 8 处落盘点都用 tmp+rename，唯独这里裸 `writeFileSync`。直写会先 truncate 再写，
  读者可能读到半截 JSON，而 `readCalibration` 的 catch **静默**返回空档，
  随后一次 `recordModelOutcome` 就把「只剩一条统计」的结果写回——历史命中率被整份抹掉且无报错。
- 顺带修掉每请求 N 次全文件读 + N 次 JSON.parse 的同步阻塞（按 mtimeMs + size 记忆化）。
- 顺手纠正一处想当然的判断：`recordModelOutcome` 的「丢失更新」在**单进程内不成立**
  （全同步读-改-写，中间没有 `await`），残留的是跨进程风险，需文件锁，属部署拓扑决策。

**③ 闸门排队超时的 429 收口（`routes/quant.ts`）**

44 个 handler 里只有 1 个用了 `respondIfQueueTimeout`，其余落到 500，客户端无从判断
该不该退避重试。给 3 个确实会打到 LLM 闸门的端点补齐（`timeseries/analyze`、
`digests/run`、`screener/run`），覆盖同步/异步/带领域错误分支三种 handler 形态。
`timeseries` 的判定**前置**到领域 400/502 正则之前，防止将来文案演变被参数分支吃掉。

**④ LLM 空结构化响应的重问回路（`llm/expertRunner.ts`）**

模型回一个**合法但空**的壳（`{"arguments":[]}`）时不抛错，会被 `normalizeExpertOpinion`
补默认值后变成「自信度 60、零论点」的伪研判——**比明确降级更糟**，因为报告不会标注降级。
现识别该形态并把失败原文 + schema 回灌**重问一次**（刻意封顶，不无限烧 token）。

**⑤ react-hooks lint 规则此前是死代码**

`eslint.config.mjs` 因无 TS parser 直接忽略 `**/*.ts(x)`，`.oxlintrc.json` 又没开 React
插件——4 处 `eslint-disable react-hooks/exhaustive-deps` 注释**完全没有约束力**。
开启后全仓只暴露一处真实违规（`CrossSectionPanel.tsx` 依赖数组里的冗余 `codesText`），已修。
同时把 oxlint `react` 插件默认带出的 3 条 React Compiler 取向规则显式关掉并记原因，
避免 lint 从 0 警告变成 25 条噪声。

**⑥ 指标表容量上限（`services/metrics.ts`）**

`normalizeRoute` 只收敛路由段，counter key 里还有 `statusLabel`。两张 Map 加上限
（默认 2000），淘汰「最早创建的」——刻意不做 LRU：指标条目的价值只取决于它代表哪条路由。

**⑦ 客户端基建补齐**

- `api/client.ts` 37 处调用点补上 axios 泛型（真正受益的是 6 个无返回标注、
  `any` 曾泄漏给调用方的函数）；`client/src/hooks/useQuery.ts` 抽出零依赖的查询 hook
  （序号防乱序 + 卸载中止 + onSettled 同批更新），迁移 `HistoryPage` / `WatchlistPage`。
- `App.tsx` 的 `activeTab` 与 `location.hash` 双向同步：**不引路由库**也能深链、
  收藏与浏览器前进后退；未知 hash 回落到默认页而非渲染空白。

**⑧ 测试补强**

- 新增 `e2e/analyze.spec.ts`（3 条）：此前分析流程的**失败路径完全无 e2e**。
  用 `page.route` 把「后端挂掉」变成确定事件，因此不依赖外部数据源、稳定且快，
  覆盖的是真实前端路径（EventSource → 退避重连 → 错误归一化 → 横幅 → 重试），
  其中一条专门盯「失败后 loading 必须复位」，这是流式分析最易泄漏的状态。
- 新增 `ensemble.calibration.test.ts`（12 条，委托式 fs mock 统计真实系统调用）、
  `expertRunner` 重问回路（7 条）、`llmLimits` 三个端点的 429 映射（7 条）、
  `metrics` 容量上限（3 条）、`useQuery`（6 条）、`App` hash 深链（5 条）。

**⑨ 明确没做的**（详见 `docs/ENGINEERING-NOTES.md` 第 ⑧ 条）

- 未引入 zod 全量改写请求体校验——现网边界校验虽散但各自成立且有 3279 用例兜底，
  真正的漏洞（④）已用更小改动堵上。
- 未把 `routes/quant.ts` 拆成 5 个文件——先让它进入门禁（①），拆分留作独立一轮。
- 未改 vitest 的 pool/isolate——`isolate: false` 会让模块级状态在测试文件间泄漏，
  本仓库恰恰有大量模块级状态，正确性不换那 5~10 秒。

## 2026-09-22（当日稍后）— 收尾：三个 Dependabot PR 合并后的 lock 复合差异（2853e1c / d5f5eef / 070b1b6）

PR #19 被 Dependabot 自己关掉、另开了 #20（5 项 → 7 项）——上一节移除 override 之后，
那个原本卡住的 `nanoid` 升级终于能被收进分组。本仓 #20、#18 与 `issue-agent` #5 按其 CI
结果全部合并（各自分支上 quality + e2e 双 job 均为绿）。

**① 两个 PR 都改 `package-lock.json` 时，后合并的会留下复合差异**

- #20（开发组）与 #18（dotenv）各自基于当时的 main 生成 lock。先后合并后，lock 里
  `packages["server"].dependencies.dotenv` 落成 `"^18.0.1"`，而 `server/package.json`
  是精确固定的 `"18.0.1"`——文本合并拼出来的，两边都不是错的，合起来才错。
- **CI 拦不下它**：`npm ci` 的同步校验比对的是**解析出的版本**（两者都指向 18.0.1），
  不是 specifier 字符串。所以这类差异没有任何门禁会报警，只能靠人发现。
- 识别方法：合并依赖 PR 后跑一次 `npm install`，看 `package-lock.json` 是否出现 diff。
  lock 是**逐字镜像** manifest 的（同文件里根的 `^6.0.1`、typescript 的 `^7.0.2` 都保留了
  脱字符），故以 manifest 为准改回 `"18.0.1"`（070b1b6，一行，无版本变化）。

**② `nanoid` 的最终状态（接上一节）**

- 根节点 `nanoid` 由 `^3.3.18` 升到 `^6.0.1`；`postcss` 声明的 `^3.3.18` 让它**自己嵌套**
  了一份 `3.3.19`。`npm ls nanoid` 合法（两份拷贝），不再是历史上那次 `invalid`。
- 仓库内无任何代码 `import 'nanoid'`，故这次升级对运行时无影响。上一节那条约束不变：
  **同一个包不要同时写进直接依赖与 `overrides`**，否则 Dependabot 升任一侧都会触发 `EOVERRIDE`。

**③ 顺带订正两处过期文档**

- `docs/ENGINEERING-NOTES.md` 的「质量门禁」节此前记的还是 2026-08-11 的
  `761 passed / 69 文件` 与旧阈值 `70/68/62/55`；实际是 **3239 / 235** 与
  **`92/90/92/80`**，已按实测订正并标注日期。

## 2026-09-22 — CI 回绿：超时用例去掉网络依赖，冗余 override 移除（a2e3bf5 / 8967003）

两处门禁变红，都不是业务代码的问题，但都值得治本而不是加宽阈值。

**① `/api/stocks/search` 正常路径用例改为打桩（Dependabot 的 PR 因此变红）**

- 该用例此前真实打通路由 → 服务层：CI 上要先等东财 suggest 超时，再回落本地全表
  5000+ 只股票的最长公共子串 DP，耗时随机器负载在数秒到数十秒间浮动。**同一提交在两次
  CI 上会得出相反结论**——d51f277 已为此把超时从默认 5s 放宽到 30s，本轮仍被打穿
  （30107ms 超时），PR #19 因此变红。
- 根因不是超时给得不够，而是它违反了 `ci.yml` 里写明的约定「测试均已 mock 网络
  （不依赖真实行情/东财接口）」。现按 `routes.market.test.ts` / `routes.rateLimit.test.ts`
  的同一口径给 `searchStocks` 打桩。
- 断言同时收紧：被闸门拒绝的两条请求必须**不触达服务层**（`not.toHaveBeenCalled()`，
  这正是"拦在昂贵匹配之前"这条语义本身）；正常词必须放行，并**原样回传**服务层结果
  （此前只判 200 与 `Array.isArray`）。用例 30107ms → 462ms，本文件 14 条不变。
- 突变验证：把长度闸门挪到服务调用之后、把 `res.json(results)` 换成 `res.json([])`，
  恰好这两条用例失败，其余 12 条不受影响。

**② `nanoid` 从 `overrides` 移除（Dependabot 的更新任务本身变红）**

- 现象：Dependabot Updates 报 `dependency_file_not_resolvable`，详情为
  `Override for nanoid@6.0.1 conflicts with direct dependency`。本地用最小 `package.json`
  复现确认这就是 npm 的 `EOVERRIDE`，且**报错文案里的版本号取自「直接依赖」那一侧**：
  `nanoid` 同时写在 `devDependencies`（`^3.3.18`）与 `overrides`（`^3.3.18`）里，
  Dependabot 只要单独把直接依赖升到 6.0.1，两侧 specifier 不再逐字相同，npm 就拒绝解析。
- 这条 override 早已冗余：唯一的传递消费者 `postcss` 声明的也是 `^3.3.18`，直接依赖本身
  就足以把整棵树钉在 3.x。移除后 `package-lock.json` **逐字节未变**（SHA256 相同），
  `npm ls nanoid` 仍是单个 `3.3.19 deduped`（**这是当日该提交时的状态**；几小时后合并
  PR #20，nanoid 被升到 `^6.0.1`，树变成根 6.0.1 + postcss 嵌套 3.3.19，见下一节）。
- 9226ac2 那条「钉 nanoid ≥3.3.17 修高危传递漏洞」的结论不变：当时真正的病根是 override
  用了 `>=` 把 nanoid 解析到 6.0.1（ESM-only），而不是缺少 override。
- 结论：**同一个包不要同时出现在 `devDependencies` 与 `overrides` 里**——两侧 specifier
  一旦不同步就是 `EOVERRIDE`，而 Dependabot 恰好会分别更新它们。

本地全量 3239 用例 / 235 文件全过；覆盖率 lines 94.95% / statements 92.91% / functions
94.74% / branches 83.26%，与用例数一样均未变动（本轮只改断言口径与依赖声明）。

## 2026-09-19 — 改进闭环补齐：统计护栏、无人值守调度与 MCP 暴露

上一节把 L2 闭环跑通了，但留了三处短板：只能人工调接口、统计上只是启发式、同分候选按遍历
顺序任意取舍。这一轮逐个解决。测试 3197 → **3237 用例 / 235 文件**；覆盖率
lines 94.94% / statements 92.9% / functions 94.7% / branches 83.25%。

**① 统计护栏：从「比例更高」升级为「配对检验显著」**

- 目标函数由「采信集精度」换成**决策准确率**：一条记录的判定只有两种好结局——采信了扛住样本外的因子（真阳性）、剔除了没扛住的因子（真阴性）。只盯精度会漏掉后者：把好因子一起扔掉的策略精度可能更高。准确率把两类错误一起算，而且**天然是配对二值**，于是可以直接上检验。精度仍照常记录（使用者口径），但不再参与决策。
- 新增 `mcnemarExact(b, c)`：McNemar 精确检验（双侧），不一致对服从 Binomial(b+c, 0.5)，p = 2×P(X ≤ min(b,c)) 封顶 1；`b+c > 1000` 时 0.5ⁿ 下溢，保守返回 1（现有配置不可达：台账上限 500 条、验证集占 30%）。
- 新增 `pairedDecision()`：逐条配对比较两个判据的判定正确率，产出 b / c / p 值与两侧准确率。
- 决策三条同时成立才落盘：准确率更高 + 稳定条数不减 + **p < 0.05**。台账新增 `significance` 块（准确率前后、不一致对 b/c、p 值、α、是否显著）——**b/c 是可复核的最小充分统计量**，拿这两个数任何人都能重算 p 值。
- **不做多重比较校正**，理由写在代码里：候选是在训练集上挑的，验证集自始至终没参与选择，选择偏差由切分本身挡掉；验证集上的检验是一次干净的确认性检验，不是"32 次里的最大值"。再叠 Bonferroni 属双重保守，会让循环几乎永不行动。

**② 证据下限提高，让检验真的有功效**

- 可回放下限 20 → **60**，验证集下限 6 → **20**。取 20 是因为它让 6:0 的不一致对恰好可达显著（p≈0.031），而 5:0 只有 p=0.0625——判据一旦被改写就影响后续所有分析结论，样本不够时"不动"才是正确答案。
- 顺带修掉一个原设计缺陷：下限 20/6 时「验证集不足」这条守门逻辑**不可达**（20 条证据的验证集必然 ≥6），等于没写。

**③ 同分候选取舍：从「遍历顺序」改为「最小归一化移动」**

- 新增 `policyMovement()`：各维度变化幅度除以该维度定义域宽度后求和，布尔维度记 1。
- 实测暴露的问题：按"改了几个维度"排序时，两个都只改一维、得分又完全相同的候选只能由遍历顺序决定——它会把显著性从 0.05 一路收紧到 0.01，而真正起作用的是单调性。改成比移动量后**动得最少者胜出**（能不动就不动），并把并列数写进 verdict 文案供人复核。

**④ 无人值守：周期调度**

- 新增 `services/improvementScheduler.ts`，照 `scheduler.ts` 同一范式：setTimeout 链（**结构上不可能重叠**）、单轮失败不终止循环、连续失败指数退避（封顶 8 倍）、连续 5 次失败自动停止、timer `unref()` 不阻止进程退出。默认间隔 **6 小时**（`IMPROVEMENT_INTERVAL_HOURS`，0 = 关闭），首次延迟 10 分钟避开启动预热，接线在 `index.ts` 的同一个预热块里。
- `/api/improvement/scheduler/start|stop` 运行期开关；status 如实回传 `scheduler`（未启动为 `null`，不假装在跑）。env 显式关闭又没传 `intervalHours` 时返回 **400 并给出两条出路**——静默改用默认值会让"我明明关了它"变成假的；显式传间隔则压过 env。
- 与监控循环的三点差异都有理由：间隔 6 小时而非 5 分钟（判据的输入是按天积累的实验）、首次延迟 10 分钟而非一整个间隔、连续失败上限 5 而非 10（间隔以小时计，5 次足以说明环境需要人介入）。

**⑤ MCP 暴露**

- 新增三个工具：`quant_improvement_status`、`quant_improvement_run`（`dryRun` 可选）、`quant_improvement_history`（`limit` 夹到 [1,200]）。工具总数 9 → 12；`server.tools.test.ts` 里钉住工具名**顺序**与 `required` 映射的两处断言同步更新。

**⑥ CI 抓到的缺陷：台账时间倒序比较器对相等键返回 -1**

- 推送后 CI 在 `improvementLedger.test.ts` 的「记录后可按时间倒序查回」上失败（`expected '第一条' to be '第二条'`），**本地全绿**。根因不是测试写错，是比较器病态：`(a, b) => (a.createdAt < b.createdAt ? 1 : -1)` 在同毫秒写入时，`compare(a,b)` 与 `compare(b,a)` **都**返回 -1——违反排序契约（相等必须返回 0），顺序由排序算法实现决定。
- 本地躲过的原因是写盘要「mkdir + writeFileSync + rename」，两次记录通常间隔 >1ms；CI 的临时文件系统快得多，两次写入常落在同一毫秒。典型"本地跑不出来"的缺陷。
- 修法：相等键返回 0，交给稳定排序保持数组原序；台账数组本就是**新在前**，故同毫秒内的先后即写入先后。同一写法在 `factorLedger.listFactorExperiments` 里也有（改进台账是照它抄的），一并修正——那里的顺序还决定改进循环「较早 70% 训练 / 较新 30% 验证」的切分，不确定等于每轮拿到的训练/验证集都在变。
- 回归测试各加一条，直接落盘 **5 条**同时间戳记录断言完整顺序（用 5 条而不是 2 条：元素太少时排序算法可能恰好保住原序，测不出病态比较器）。已做突变验证：改回病态版本两条用例都确实失败。

验证：全量 235 文件 / 3239 用例通过（新增 1 文件 42 用例）；覆盖率 lines 94.95% / statements 92.91% / functions 94.74% / branches 83.26%（阈值 92 / 90 / 92 / 80）；lint 0 warning 0 error；Prettier 全通过；双端 tsc；双端 build；E2E 9/9。

## 2026-09-19 — 改进闭环（RSI · L2）：用历史实验回放调采信判据

给因子采信判据补上闭环的最后一段。此前判据是 `judgeFactor` 里写死的四个常量
（`ic.n<5` / `p>=0.05` / `monotonicity<0.6` / `spread<=0`），而因子实验台账已经攒了
「试过什么、结论如何」——却没有任何机制把这份经验变成下一次**判断方式**的改动。
按 arXiv:2609.11873 的分级，这恰是「跑得多」（自我修正）与「改进方法并留给后续」
（递归自我改进 L2→L4）之间的那道坎。

测试 3132 → **3197 用例 / 234 文件**；覆盖率 lines 94.9% / statements 92.84% /
functions 94.67% / branches 83.13%（阈值 92 / 90 / 92 / 80）。

- **`quant/harnessPolicy.ts`（新增）**：判据从常量变成持久状态。默认值与改造前逐字一致，未运行改进循环时**线上行为完全不变**；写入前必须过边界校验（越界一律拒绝，不静默夹紧——静默改值会让循环以为自己保留了一个策略、实际生效的是另一个）；文件损坏或字段越界一律回落出厂值，且读失败**不写缓存**（一次瞬时失败不该把默认值钉在内存里）。
- **`quant/factorLedger.ts` 增 `evidence` 块**：把判据的原始输入（icN / 分档数 / 单调性 / 多空价差）落盘。此前只存 pValue 与 oosStable，历史记录无法回放——攒再多实验也调不动判据。旧记录缺此块，回放时**跳过**（不猜、不补默认值，宁可样本变少也不造假数据）。
- **`quant/improvementLoop.ts`（新增）**：一轮 = 读证据 → 较早 70% 训练挑候选、较新 30% 验证做决策 → 候选网格（显著性 × 单调性 × 最小样本期数，32 个唯一点）逐个回放 → 胜出者须在验证集上**严格更优**，且不得牺牲样本外稳定的**绝对条数**（靠少采信把精度刷上去不是进步）→ 通过才落盘生效。
  目标函数取「采信集的样本外稳定占比」：`oosStable` 由评估器独立算出、不依赖判据本身，是台账里唯一可自动判定的真值信号；同时设采信率下限，否则最优解几乎总是「几乎不采信」。
- **`quant/improvementLedger.ts`（新增）**：改动台账，每条记录回答四件事——改了什么（before/after 两份完整策略，可直接回滚）、凭什么改（用了多少条证据、怎么切分）、改完好了多少（**验证集**指标，连同被采信数一起记，只看精度不看样本量会被"只采信 1 个且恰好蒙对"骗过去）、谁被否了（本轮全部候选）。`triedValues` 供下一轮跳过已探索区域，**证据变多后自动重新可探索**。
- **`/api/improvement/{status,run,history}`**：可查、可演练（`dryRun` 不落盘、不回传记录，避免"有记录=已生效"的误读）、可回滚（删策略文件即回出厂判据）。状态接口把「可回放证据够不够」单列——刚上线时 `available=0` 会如实说 `ready:false`，藏起来用户会以为循环在干活。

若干取舍（都是先写错再改对的）：

- 候选同分时改为取**与现任差异最小者**：没有这一级，目标函数对「哪个维度起的作用」没有偏好，会在一堆同分候选里按遍历顺序随便挑，把与提升无关的维度也顺手改掉（实测会把显著性从 0.05 挪到 0.01，只因它排在网格前面）。
- `MIN_VALIDATION_COUNT` 由 6 提到 8：证据下界 20 条时验证集恰好 6 条，原值让「验证集不足」这条守门逻辑成为**不可达的死代码**；同理「无新候选」分支原本也永远进不去（现任判据总被保留），改为只把**未探索过**的候选算新信息。
- 演练标记加在**所有**出口上：只在「本来就会改」的分支加，会让没改成的演练与真实运行返回一模一样的文案，事后翻日志分不出哪次真的动过手。
- 「现任判据」永远参与评估——**「不改」必须是合法选项**。
- 路由的切分预告与循环共用 `splitCounts`，不在调用处各算一份（预告说够了、实跑却因验证集不足直接返回，是最难排查的不一致）。

局限（同时写在代码注释里）：这是**带训练/验证切分的启发式搜索**，不是显著性检验；候选网格有限，结论只对「这批历史实验」负责。故每条记录都把候选全集、切分口径与样本量一并落盘，供人复核而不是只能相信。判据证据自本次改造起才开始留痕，**存量记录不参与回放**——需先积累若干轮新的因子评估。

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
