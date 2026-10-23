# 安全策略

Stock Research System 是面向 A 股的全栈投研平台，包含 Express API、React 前端、量化回测、模拟盘与本地数据缓存。系统默认按本机单用户运行，API 默认不鉴权——把服务暴露到 localhost 之外前必须先配置访问令牌。

## 支持的版本

版本号见 `package.json`（当前为 1.0.0）；仓库未发布 tag / release，安全修复进入 `main` 最新提交。

| 版本           | 支持状态                              |
| -------------- | ------------------------------------- |
| 1.0.x（当前）  | ✅ 接收安全报告并在 `main` 修复       |
| 更早的历史提交 | ❌ 不单独维护，请使用 `main` 最新代码 |

## 私密报告漏洞

**请勿在公开 Issue 中粘贴漏洞细节、利用代码或真实 token / 研究数据。**

请通过 GitHub 的私密漏洞报告渠道提交：

1. 打开 [Security Advisories](https://github.com/xiaomaozjj666/stock-research-system/security/advisories) 页面；
2. 点击 **Report a vulnerability**；
3. 填写复现步骤与影响范围。

也可直接访问：<https://github.com/xiaomaozjj666/stock-research-system/security/advisories/new>

若页面上看不到该入口（仓库尚未开启私密报告），请先开一个**不含漏洞细节**的 Issue 说明需要私密渠道，维护者开启后会与你联系。

报告中建议包含：

- 受影响的版本 / 提交号、Node.js 版本与部署方式（本机 / 反向代理 / 容器）；
- 复现步骤或最小复现，包括是否设置了 `API_AUTH_TOKEN`、`HOST`、`ALLOWED_ORIGINS`；
- 影响说明，例如未授权访问、鉴权绕过、路径穿越、命令注入、审计日志或研究数据泄露；
- 如有可能，附上修复建议。

**请勿粘贴真实的 `TUSHARE_TOKEN`、`EASTMONEY_SEARCH_TOKEN`、`DEEPSEEK_API_KEY`，也不要粘贴自选股、持仓、模拟盘账户或研究历史等个人数据**，请用演示数据复现并脱敏。在修复发布前，请勿公开细节。

## 范围说明

- 覆盖 `server/` 的 API 与量化模块、`client/` 前端、MCP 适配器、审计日志与本地数据文件。
- 服务默认绑定 `127.0.0.1` 且 API 不鉴权；改为 `0.0.0.0`、做内网穿透或公网部署前，必须设置 `API_AUTH_TOKEN`，并按需收紧 `ALLOWED_ORIGINS`、`TRUST_PROXY`（见 `.env.example` 的「启动与安全」）。
- 不覆盖：东方财富 / Tushare / Baostock 等上游数据的准确性与可用性、LLM 生成内容，以及投资收益。
