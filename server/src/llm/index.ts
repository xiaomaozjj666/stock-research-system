export {
  getLLMConfig,
  isLLMAvailable,
  getModelRegistry,
  selectModel,
  modelSpec,
  getEmbedModel,
  getEmbedBaseUrl,
  isEmbeddingConfigured,
  type LLMConfig,
  type LLMTask,
  type ModelSpec,
} from './config.js';
export {
  chat,
  chatStream,
  chatJSON,
  chatWithTools,
  embed,
  type ChatMessage,
  type LLMOptions,
  type ToolCallResult,
} from './client.js';
export {
  recordUsage,
  getCostReport,
  resetCostTracker,
  type CostEntry,
  type CostReport,
} from './cost.js';
