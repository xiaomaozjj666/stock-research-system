/**
 * OpenAPI 3.1 契约聚合入口（按域模块的单一事实源）
 * ----------------------------------------------------------------------------
 * 2026-11 架构整改：原 5788 行单文件拆分为 paths/ 与 schemas/ 按域模块，
 * 本入口只做聚合，不再承载逐条契约定义；新增/修改路由契约请改对应域模块。
 * 兜底校验不变：services/__tests__/openapi.routes.test.ts 与真实路由表双向比对；
 * 生成物 docs/openapi.json 由 scripts/generate-openapi.mts 产出，CI 经
 * check:openapi 保证「生成物与源同步」。
 */
import { OPENAPI_VERSION } from './shared.js';
import { analysisPaths } from './paths/analysis.js';
import { autonomousPaths } from './paths/autonomous.js';
import { chatPaths } from './paths/chat.js';
import { documentsPaths } from './paths/documents.js';
import { improvementPaths } from './paths/improvement.js';
import { intlPaths } from './paths/intl.js';
import { llmPaths } from './paths/llm.js';
import { marketPaths } from './paths/market.js';
import { portfolioPaths } from './paths/portfolio.js';
import { quantPaths } from './paths/quant.js';
import { systemPaths } from './paths/system.js';
import { thesisPaths } from './paths/thesis.js';
import { analysisSchemas } from './schemas/analysis.js';
import { chatSchemas } from './schemas/chat.js';
import { commonSchemas } from './schemas/common.js';
import { documentsSchemas } from './schemas/documents.js';
import { improvementSchemas } from './schemas/improvement.js';
import { intlSchemas } from './schemas/intl.js';
import { portfolioSchemas } from './schemas/portfolio.js';
import { quantSchemas } from './schemas/quant.js';
import { thesisSchemas } from './schemas/thesis.js';

export { OPENAPI_VERSION };

export function buildOpenApiDocument() {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Stock Research System API',
      version: '1.0.0',
      description:
        '全栈股票研究平台：多专家仲裁、量化回测与受控评估（DSR/CSCV/Walk-Forward）、模拟盘研究闭环、合规审计（金融监管 8 号文）。所有内容仅供学术投研参考，不构成投资建议。',
    },
    servers: [{ url: '/', description: '同源部署（前端与 API 单端口）' }],
    tags: [
      { name: 'analysis', description: '多专家研判' },
      { name: 'quant', description: '量化回测与受控评估' },
      { name: 'paper', description: '模拟盘研究闭环（无实盘资金）' },
      { name: 'watchlist', description: '自选股与异动监控' },
      { name: 'chat', description: '对话式研究助手' },
      { name: 'autonomous', description: '自治监控循环' },
      { name: 'documents', description: '研报/公告 RAG 入库' },
      { name: 'intl', description: '港美股财务估值' },
      { name: 'system', description: '模型路由 / 成本 / 审计 / 健康检查 / 指标' },
    ],
    paths: {
      ...analysisPaths,
      ...autonomousPaths,
      ...chatPaths,
      ...documentsPaths,
      ...improvementPaths,
      ...intlPaths,
      ...llmPaths,
      ...marketPaths,
      ...portfolioPaths,
      ...quantPaths,
      ...systemPaths,
      ...thesisPaths,
    },
    /**
     * 复用组件。**新增端点时优先引用这里的具名组件**，而不是内联展开：
     * 内联展开让同一形状在几十处各写一遍，改一处漏一处不会有任何测试变红
     * ——这正是本文件此前漏掉 25 条路由的同一个根因。
     *
     * 具名组件同时是类型生成器的锚点：components 里的每个键都会生成一个顶层
     * TS 类型，operation 里 $ref 引用它，因此「契约字段」与「前端类型」由
     * 同一处定义，不可能分叉。
     */
    components: {
      schemas: {
        ...analysisSchemas,
        ...chatSchemas,
        ...commonSchemas,
        ...documentsSchemas,
        ...improvementSchemas,
        ...intlSchemas,
        ...portfolioSchemas,
        ...quantSchemas,
        ...thesisSchemas,
      },
    },
  };
}
