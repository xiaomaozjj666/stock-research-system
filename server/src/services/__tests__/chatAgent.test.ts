import { describe, it, expect, vi } from 'vitest';
import { createChatAgent, type ChatAgentDeps } from '../chatAgent.js';

function baseDeps(over: Partial<ChatAgentDeps>): ChatAgentDeps {
  return {
    runAnalysis: async () => ({ stock_pool: [{ stock_name: '茅台', total_score: 80, rating: '买入', valuation: { currentPrice: 100, pe: 20 }, risk_list: ['流动性风险'] }] }),
    runBacktest: async () => ({}),
    parseStrategyInput: (s) => ({ stockCode: String((s as { stockCode: string }).stockCode), strategy: String((s as { strategy: string }).strategy) }),
    fetchOHLCVData: async () => [],
    retrieveEvidence: async () => [],
    isLLMAvailable: () => false,
    chat: async () => '',
    chatWithTools: async () => ({ content: '', toolCalls: [] }),
    ...over,
  };
}

describe('chatAgent — 规则降级（无 LLM）', () => {
  it('解析代码并给出规则摘要', async () => {
    const agent = createChatAgent(baseDeps({}));
    const r = await agent.run({ message: '帮我分析 600519' });
    expect(r.degraded).toBe(true);
    expect(r.toolsUsed).toContain('run_analysis');
    expect(r.answer).toContain('600519');
  });

  it('无代码时返回能力说明', async () => {
    const agent = createChatAgent(baseDeps({}));
    const r = await agent.run({ message: '你好' });
    expect(r.degraded).toBe(true);
    expect(r.toolsUsed).toEqual([]);
  });
});

describe('chatAgent — 带 LLM', () => {
  it('返回 chatWithTools 的最终回答与工具调用', async () => {
    const agent = createChatAgent(baseDeps({
      isLLMAvailable: () => true,
      chatWithTools: async () => ({ content: '这是分析', toolCalls: [{ name: 'run_analysis', args: { stockCode: '600519' } }] }),
    }));
    const r = await agent.run({ message: '分析 600519' });
    expect(r.degraded).toBe(false);
    expect(r.answer).toBe('这是分析');
    expect(r.toolsUsed).toContain('run_analysis');
  });

  it('用户要求辩论时触发多空辩论', async () => {
    const runDebate = vi.fn(async () => ({ bull: '涨', bear: '跌', synthesis: '中性' }));
    const agent = createChatAgent(baseDeps({ isLLMAvailable: () => true, runDebate }));
    const r = await agent.run({ message: '600519 多空辩论' });
    expect(runDebate).toHaveBeenCalled();
    expect(r.debate?.synthesis).toBe('中性');
  });

  it('sessionId 下持久化用户与助手轮次', async () => {
    const appendTurn = vi.fn();
    const agent = createChatAgent(baseDeps({ isLLMAvailable: () => false, appendTurn }));
    await agent.run({ message: '你好', sessionId: 's1' });
    expect(appendTurn).toHaveBeenCalledWith('s1', { role: 'user', content: '你好' });
    expect(appendTurn).toHaveBeenCalledWith('s1', { role: 'assistant', content: expect.any(String) });
  });
});
