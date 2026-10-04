/**
 * 量化研究：回测 + 数据质量 + 审计 + 优化 + 摘要；受控回测评估（基线 vs 新闻叠加）；
 * 量价因子（A 股方向校正）与单因子评估 tear sheet。
 *
 * ------------------------------------------------------------------
 * 本文件原先是 2200+ 行的单文件路由（分析 / 因子 / 截面 / LLM 运维 / 运营端点混在
 * 一起），现已按领域拆为下列模块；对外 HTTP 路径与方法**逐字未变**：
 *
 *   quantCore.ts          分析、因子评估、复合因子、板块宇宙
 *   quantCrossSection.ts  截面因子评估（逐日 IC / 分层 / OOS / 因子组合回测）
 *   llmAdmin.ts           LLM 集成投票、权重校准、技能路由
 *   quantOps.ts           初筛、时序、记忆、简报、公告、估值、健康、台账、受控评估
 *
 * 各子模块用**绝对路径**注册自己的 Router，因此挂载顺序不影响匹配结果；
 * index.ts 仍只需 app.use(quantRouter) 一行，路由层级保持单层。
 *
 * 跨领域共用的取数扇出 / 入参校验 / 模拟数据闸门 / 台账留痕在
 * services/quant/panelService.ts——它们是**业务规则**（如模拟数据必须拒绝计算 IC、
 * 持有期上限、并发硬上限），放进路由文件既难以直接测试，也会被复制成多份分叉。
 */
// 基本面数据走量化侧缓存（财报按季度更新，无需每次运行重拉）：
// 把每只股票 3 次网络调用降到 1 次（仅剩 K 线的尾部增量补拉）。
// 底层仍调用 services 的 fetchFinancialData / fetchQuarterlyFinancials，
// 故既有的模块级 mock（按 services 路径）依旧生效。
import { Router } from 'express';

import quantCoreRouter from './quantCore.js';
import quantCrossSectionRouter from './quantCrossSection.js';
import llmAdminRouter from './llmAdmin.js';
import quantOpsRouter from './quantOps.js';

const router = Router();

router.use(quantCoreRouter);
router.use(quantCrossSectionRouter);
router.use(llmAdminRouter);
router.use(quantOpsRouter);

export default router;
