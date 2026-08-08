# 工程笔记

本文件沉淀本项目维护与开发过程中已验证的工程事实，供后续改动复用。

## 技术栈

- monorepo（npm workspaces）：`server/`（Express5 + TS7, NodeNext, `.js` 扩展名）+ `client/`（React19 + Vite8 + ECharts6 + plugin-react 6）。
- 测试：Vitest 4 + @vitest/coverage-v8 4（v8 provider），`globals:false`（测试里 `vi`/`expect`/`describe`/`it` 必须显式 import）。

## 质量门禁（应全部为 0 失败）

- `npm run lint`（JS/风格）0。
- `server`: `npx tsc --noEmit` 0。
- `client`: `npm run build` OK。
- `npm run test`（vitest run）：截至 2026-08-04 为 **599 passed / 0 failed**（57 文件）。
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
- `push2.eastmoney.com` 经 Node `fetch` / 子进程 `curl` 失败（TLS reset）。`stockMaster.loadStockMaster()`（push2 全表）在该环境必然失败，属预期。
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
- `walkForwardBacktest`：`oosRatio = avgTestSharpe / avgTrainSharpe`，≥0.5 ⇒ stable（检过拟合）。
- 单股实时分析无「多股带实现收益的面板」时，最优权重默认走等权先验。

## 环境注意

- 本机有 `http_proxy=http://127.0.0.1:7890` 代理，会干扰 npm/vitest 运行；执行前先 `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY`。
- Git Bash 里 `curl -o /tmp/x.json` 的路径映射不可靠，落盘请用项目内相对路径。
