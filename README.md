# Stock Research System

A full-stack stock analysis platform with multi-expert AI arbitration, quantitative backtesting, controlled evaluation, and a paper-trading research loop.

## Architecture

```
client/          React + Vite + ECharts frontend
server/          Express API server
  ├── services/     Stock analysis pipeline + multi-expert arbitration
  │   └── experts/    Fundamental, Valuation, Risk, Industry, CapitalFlow, Policy, HotMoney, Unlock, Arbitration
  ├── quant/        Quantitative backtesting engine + strategy optimizer + paper trading
  │   └── agents/     DataEngineer / BacktestAuditor / StrategyOptimizer (LLM agents)
  ├── llm/          LLM routing, cost tracking, RAG, knowledge graph, MCP tools
  └── data/         Cached security master / paper-trading / audit logs
```

## Stack

- Monorepo（npm workspaces）：`server/`（Express 5 + TypeScript）+ `client/`（React + Vite + ECharts）。
- **Frontend**: React, ECharts 6, Vite, TypeScript
- **Backend**: Express 5, TypeScript
- **Testing**: Vitest（service/quant unit tests + coverage）、Playwright（E2E）

## Quick Start

```bash
npm install --legacy-peer-deps --dangerously-allow-all-scripts
npm run dev:server    # → http://localhost:3001
npm run dev:client    # → http://localhost:5173
```

## API 概览

| 分类 | 接口 | 说明 |
| --- | --- | --- |
| 分析 | `POST /api/analyze` | 6 位 A 股代码多专家 AI 研判 |
| | `GET /api/analyze/stream` | SSE 流式分析（逐阶段推送进度） |
| | `POST /api/compare` | 2-3 只股票横向对比 |
| | `GET /api/stocks`、`GET /api/stocks/search` | 支持股票列表 / 搜索 |
| 量化 | `POST /api/quant/analyze` | 量化研究（回测 + 数据质量 + 回测审计 + 优化 + 摘要） |
| | `POST /api/backtest/evaluate` | 受控评估：新闻叠加 vs 基线（DSR / Bootstrap CI） |
| **模拟盘** | `GET /api/paper/portfolio` | 模拟盘账户：现金 / 持仓 / 订单 / 每日净值 |
| | `POST /api/paper/order` | 模拟下单（市价/限价，A 股规则撮合） |
| | `POST /api/paper/settle` | 日终结算：按收盘价撮合挂单 + 记录当日净值 |
| | `GET /api/paper/stats` | 累计收益 / 最大回撤 / 年化夏普 |
| **审计** | `GET /api/audit` | 合规审计查询（支持 `category` / `riskLevel` / `startTime` / `endTime` / `sessionId` 过滤） |
| **港美股** | `GET /api/intl/fundamentals?code=&market=` | 港美股财务估值（`market=HK/US`；A 股代码走 `/api/analyze`） |
| 对话 | `POST /api/chat`、`GET /api/chat/stream` | 自然语言智能体（SSE 流式） |
| 自选股 | `GET/POST/DELETE /api/watchlist`、`POST /api/watchlist/news-backtest`、`POST /api/watchlist/monitor` | 清单管理 / 批量新闻回测 / 异动监控 |
| 自治循环 | `POST /api/autonomous/start`、`/stop`、`GET /api/autonomous/status` | 主动监控自治循环 |
| 文档 RAG | `POST /api/ingest`、`GET /api/documents` | 研报/财报/公告 PDF/文本入库 + 洞察抽取 |
| 模型/成本 | `GET /api/models`、`GET /api/cost`、`POST /api/cost/reset` | 多模型路由 / 成本治理 |
| 其他 | `GET /api/health` | 健康检查（外部 API 可达性 + 缓存目录） |

## Features

- 6 位股票代码多专家 AI 仲裁（基本面 / 估值 / 风险 / 行业 / 资金流 / 题材 / 政策 / 解禁）
- 量化回测引擎 + 策略优化（LLM agents：数据质量 / 回测审计 / 策略优化）
- 受控评估：Deflated Sharpe Ratio（DSR）+ CSCV 回测过拟合概率（PBO）+ Walk-Forward 样本外稳健性
- 模拟盘研究闭环：策略信号 → 模拟下单 → 日终收盘价撮合（A 股 T+1 / 涨跌停 / 整手 / 费用规则）→ 净值与绩效
- 港美股财务估值（东方财富 datacenter RPT 网关，无 token）
- 合规审计（金融监管 8 号文）落盘 + 运行时熔断 + `/api/audit` 查询
- 全链路追踪（`X-Trace-Id` + LLM span / 成本）
- 对话式智能体 + 自选股异动监控 + 自治循环
- 交互式 ECharts 可视化（财务图表 / 风险指标 / 评分）

## Data Sources & Research Loops

- **模拟盘研究闭环**：无实盘资金的量化研究闭环——策略信号 → 模拟下单 → 日终按收盘价撮合（A 股 T+1 / 主板 ±10% 涨跌停拒单 / 整手 100 股 / 佣金万三 + 卖出印花税 0.1%）→ 记录每日净值 → 绩效统计（累计收益 / 最大回撤 / 夏普）。账户 JSON 持久化（原子 rename，无 sqlite 依赖）。
- **港美股（东财 datacenter RPT）**：`quant/intlDataProvider.ts` 走 `datacenter.eastmoney.com` 的 RPT 网关（免费无 token）。港股 `RPT_HKF10_FN_MAININDICATOR` + 名称兜底；美股 `RPT_USF10_INFO_ORGPROFILE` + 财务指标；单只失败降级 `degraded=true`，不阻断。
- **受控评估（DSR / CSCV）**：`compareBacktests` 输出 Deflated Sharpe Ratio（扣除"试了 N 个策略取最佳"的搜索偏差）与 Bootstrap 置信区间；`quant/cscv.ts` 用组合对称交叉验证计算回测过拟合概率（PBO）；`walkForward.ts` 以 OOS 夏普 < 70% × IS 夏普判定过拟合。
