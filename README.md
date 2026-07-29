# Stock Research System

A full-stack stock analysis platform with multi-expert AI arbitration and quantitative backtesting.

## Architecture

```
client/          React + Vite + ECharts frontend
server/          Express API server
  ├── services/     Stock analysis pipeline + multi-expert arbitration
  │   └── experts/    Fundamental, Valuation, Risk, Industry, Arbitration
  └── quant/        Quantitative backtesting engine + strategy optimizer
```

## Stack

**Frontend**: React 18, ECharts 5, Vite 6, TypeScript
**Backend**: Express 4, TypeScript
**Testing**: Playwright (E2E)

## Quick Start

```bash
npm install
npm run dev:server    # → http://localhost:3001
npm run dev:client    # → http://localhost:5173
```

## Features

- 6-digit stock code analysis with multi-expert AI arbitration
- Quantitative backtesting engine with strategy optimization
- Interactive ECharts visualization (financial charts, risk metrics, scoring)
- Expert disagreement resolution via arbitration panel
- Pipeline progress tracking with SSE
