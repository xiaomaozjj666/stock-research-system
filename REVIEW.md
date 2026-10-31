# 评审指南

本文件定义本仓库的评审优先级与可跳过范围。

## 最可能失效的地方

1. **回测与模拟盘两套撮合口径分叉**：`server/src/quant/backtestEngine.ts`、`server/src/quant/paperTrading.ts`、`server/src/quant/costModel.ts`。T+1 成交、整手取整、涨跌停拒单、佣金/印花税/冲击成本在两侧各自实现；2026-10 的回测涨跌停修复正是一次口径补齐。任一侧单独改成交规则，另一侧就会系统性高估或低估可成交性，且各自的单元测试可能仍然全绿。
2. **时间口径与前视**：`server/src/quant/backtestEngine.ts` 的新闻姿态按 barDate 逐条过滤，`server/src/quant/portfolioBacktest.ts`、`server/src/quant/walkForward.ts`、`server/src/quant/crossSectionBuilder.ts`、`server/src/quant/factorEvaluation.ts` 依赖截面日期与发布日。新增数据源若日期缺失、时区偏移，或把「当前快照」回填历史，就会引入未来信息。
3. **上游数据解析与主备降级**：`server/src/quant/dataProvider.ts`、`server/src/services/dataFetcher.ts`、`server/src/utils/http.ts`、`server/src/quant/tushareAdapter.ts`、`server/src/quant/baostockBridge.ts`。历史上出现过 close=0、负 PE、百分比与小数混用、主备源口径混用、5xx 被双通道重试放大等真实数值事故。改动字段映射、单位换算、重试与降级顺序时，数值可能整片偏移而无报错。
4. **运行时数据路径**：`server/src/dataRoot.ts` 是持久化目录的唯一来源（默认 `server/data/`）。此前多个模块各自拼接 `server/src/data`，把运行时 JSON 写进源码树。新增账本、缓存、检查点若绕过 `DATA_ROOT` 或 env 重定向写错，会导致测试串数据、源码树出现未跟踪文件、打包产物夹带本地数据。
5. **长连接与中断**：`server/src/utils/sse.ts`、`server/src/utils/clientAbort.ts`、`server/src/utils/limitGate.ts`、`server/src/services/chatAgent.ts`。专家研判到仲裁之间可能静默较久，心跳间隔、连接关闭后的写保护、取消信号透传任一处改动，都会表现为前端「分析莫名中断」、客户端断开后仍继续产生调用费用，或并发闸门失效导致上游限流雪崩。
6. **默认无鉴权的暴露面**：`server/src/middleware.ts` 的 `API_AUTH_TOKEN` 未设置时完全放行，`server/src/index.ts` 负责 CORS、安全头与请求体上限，`server/src/routes/documents.ts` 单独放宽到 8MB。调整绑定地址、跨域、上传上限或鉴权顺序时，须同步 `SECURITY.md` 与 `.env.example`，否则默认部署的边界会被悄悄改变。

## 重点看

- 量化成交与成本：`server/src/quant/backtestEngine.ts`、`server/src/quant/paperTrading.ts`、`server/src/quant/costModel.ts`、`server/src/quant/portfolioBacktest.ts`。
- 数据获取与解析：`server/src/quant/dataProvider.ts`、`server/src/services/dataFetcher.ts`、`server/src/utils/http.ts`、`server/src/quant/baostockBridge.ts`。
- 分析流水线与续跑：`server/src/services/analysisPipeline.ts`、`server/src/services/analysisCheckpoint.ts`、`server/src/services/expertRunner.ts`、`server/src/quant/agents/`。
- 外部接口契约：`server/src/services/openapi.ts` 与生成物 `client/src/api/generated.ts` 必须同源；改路由时先看契约，再看生成结果是否已更新。
- 安全与资源上限：`server/src/middleware.ts`、`server/src/index.ts`、`server/src/routes/documents.ts`、`server/src/utils/limitGate.ts`、`server/src/utils/sse.ts`。

## 可以跳过

以下为生成物、依赖或运行时数据，不进入人工逐行评审（但依赖清单与契约生成源仍需看）：

- `node_modules/`
- `server/dist/`、`client/dist/`（构建产物）
- `test-results/`、`playwright-report/`（端到端运行产物）
- `server/data/`（运行时 JSON、审计日志、缓存、检查点；已整体忽略）
- `package-lock.json`（由依赖变更生成；评审看 `package.json` 的意图）
- `client/src/api/generated.ts`（由 `server/src/services/openapi.ts` 生成；评审看契约源）
- `docs/screenshots/`（界面截图）

## 本地验证

提交前按 CI 同一组命令自查（仓库根目录）：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e          # 涉及界面或端到端流程时
npm run check:api-types   # 改动服务端路由或接口契约时
npm run check:doc-freshness
```

## 评审规则

- 每条发现必须带 `file:line` 证据，不接受凭命名或猜测。
- 标严重度：Important / Nit / Pre-existing；区分本次引入与既有问题。
- 先报真实 bug，再报可读性；最多 3 条 nit。
- 已提过的发现不重复；第 3 轮起只审新增 diff，并请作者重新考虑方案。
- 每条发现必须被处理：修复，或在回复中说明为何不修。
- 安全类发现未解决前不得合并。
