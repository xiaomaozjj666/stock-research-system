/**
 * 多步研究 Agent 规划层 —— 公共 API
 * ------------------------------------------------------------------
 * 用法：
 *   const agent = new ResearchOrchestrator({ llm, adapters, onEvent });
 *   const result = await agent.run('分析 XX 行业 2026 年竞争格局');
 *   result.report          // 结构化报告（分节/引用/置信度/局限性）
 *   result.reportMarkdown  // Markdown 渲染
 *   result.events          // 中间执行状态事件流
 */
export * from './types.js';
export {
  ResearchOrchestrator,
  type AgentRunResult,
  type OrchestratorDeps,
} from './orchestrator.js';
export { EvidenceRetriever } from './retriever.js';
export { createPlan, revisePlan } from './planner.js';
export { verifySubQuestion, computeEvidenceStrength, buildSupplementHints } from './verifier.js';
export { synthesize } from './synthesizer.js';
export { renderReportMarkdown } from './report.js';
export { completeJson, LLMOutputError } from './llm.js';
export type { LLMAdapter, LLMRequest } from './llm.js';
export type { SearchAdapter, SearchHit, SearchQuery, FetchedDoc } from './search.js';
