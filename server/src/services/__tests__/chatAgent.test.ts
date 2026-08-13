import { describe, it, expect, vi } from 'vitest';
import { createChatAgent, type ChatAgentDeps } from '../chatAgent.js';

function baseDeps(over: Partial<ChatAgentDeps>): ChatAgentDeps {
  return {
    runAnalysis: async () => ({
      stock_pool: [
        {
          stock_name: '茅台',
          total_score: 80,
          rating: '买入',
          valuation: { currentPrice: 100, pe: 20 },
          risk_list: ['流动性风险'],
        },
      ],
    }),
    runBacktest: async () => ({}),
    parseStrategyInput: (s) => ({
      stockCode: String((s as { stockCode: string }).stockCode),
      strategy: String((s as { strategy: string }).strategy),
    }),
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
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatWithTools: async () => ({
          content: '这是分析',
          toolCalls: [{ name: 'run_analysis', args: { stockCode: '600519' } }],
        }),
      }),
    );
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
    expect(appendTurn).toHaveBeenCalledWith('s1', {
      role: 'assistant',
      content: expect.any(String),
    });
  });
});

describe('chatAgent — 路由规划（planner/router）', () => {
  it('显式辩论关键词命中 debate 路径，不调 chatJSON', async () => {
    const chatJSON = vi.fn();
    const runDebate = vi.fn(async () => ({ bull: '涨', bear: '跌', synthesis: '中性' }));
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON,
        runDebate,
        chatWithTools: async () => ({ content: '分析', toolCalls: [] }),
      }),
    );
    const r = await agent.run({ message: '600519 来场多空辩论' });
    expect(r.plan?.action).toBe('debate');
    expect(chatJSON).not.toHaveBeenCalled(); // 关键词命中，省一次 LLM 调用
    expect(runDebate).toHaveBeenCalled();
  });

  it('规划器返回 direct 时走 chat，不走 chatWithTools', async () => {
    const chatWithTools = vi.fn(async () => ({ content: '工具回答', toolCalls: [] }));
    const chat = vi.fn(async () => '直接回答');
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'direct', reason: '闲聊' }),
        chatWithTools,
        chat,
      }),
    );
    const r = await agent.run({ message: '你好呀' });
    expect(r.plan?.action).toBe('direct');
    expect(chat).toHaveBeenCalled();
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(r.answer).toBe('直接回答');
    expect(r.toolsUsed).toEqual([]);
  });

  it('规划器返回 tools 时走 chatWithTools', async () => {
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'tools', reason: '需要查数据' }),
        chatWithTools: async () => ({
          content: '分析结果',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.plan?.action).toBe('tools');
    expect(r.toolsUsed).toContain('run_analysis');
  });

  it('chatJSON 缺失时降级为 tools 路径', async () => {
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatWithTools: async () => ({ content: 'ok', toolCalls: [] }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.plan?.action).toBe('tools');
    expect(r.plan?.reason).toMatch(/未配置|降级/);
  });

  it('规划器异常时降级为 tools', async () => {
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => {
          throw new Error('LLM 挂了');
        },
        chatWithTools: async () => ({ content: 'ok', toolCalls: [] }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.plan?.action).toBe('tools');
    expect(r.plan?.reason).toMatch(/异常|降级/);
  });
});

describe('chatAgent — 幻觉防护（事实校验）', () => {
  it('有工具结果时触发校验，verified=true 时不警示', async () => {
    // 第二次 chatJSON 调用（校验）返回 verified
    let callCount = 0;
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => {
          callCount++;
          if (callCount === 1) return { action: 'tools', reason: '分析' };
          return { verified: true, unverified: [], warning: '' };
        },
        chatWithTools: async () => ({
          content: '茅台评分80',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.verification).toBeDefined();
    expect(r.verification?.verified).toBe(true);
    expect(r.verification?.warning).toBe('');
  });

  it('校验发现未验证断言时标记 verified=false 并给警示', async () => {
    let callCount = 0;
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => {
          callCount++;
          if (callCount === 1) return { action: 'tools', reason: '分析' };
          return { verified: false, unverified: ['茅台明年涨到2000元'], warning: '含未验证预测' };
        },
        chatWithTools: async () => ({
          content: '茅台明年涨到2000元',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.verification?.verified).toBe(false);
    expect(r.verification?.unverified).toContain('茅台明年涨到2000元');
    expect(r.verification?.warning).toBe('含未验证预测');
  });

  it('计算型声明算术重构：发现计算错误时填入 calculationErrors', async () => {
    let callCount = 0;
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => {
          callCount++;
          if (callCount === 1) return { action: 'tools', reason: '分析' };
          return {
            verified: false,
            unverified: [],
            calculationErrors: [
              {
                claim: '营收增长30%',
                reconstructedFormula: '(220-180)/|180| = 22.2%',
                recomputedValue: '22.2%',
                claimedValue: '30%',
                discrepancy: '回答称30%但实际增速为22.2%',
              },
            ],
            warning: '存在1处计算错误',
          };
        },
        chatWithTools: async () => ({
          content: '营收增长30%',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.verification?.verified).toBe(false);
    expect(r.verification?.calculationErrors).toHaveLength(1);
    expect(r.verification?.calculationErrors[0].claim).toBe('营收增长30%');
    expect(r.verification?.calculationErrors[0].recomputedValue).toBe('22.2%');
    expect(r.verification?.warning).toContain('计算错误');
  });

  it('calculationErrors 为空且 unverified 为空时 verified=true', async () => {
    let callCount = 0;
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => {
          callCount++;
          if (callCount === 1) return { action: 'tools', reason: '分析' };
          return { verified: true, unverified: [], calculationErrors: [], warning: '' };
        },
        chatWithTools: async () => ({
          content: '分析正确',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.verification?.verified).toBe(true);
    expect(r.verification?.calculationErrors).toHaveLength(0);
    expect(r.verification?.warning).toBe('');
  });

  it('direct 路径不触发校验（无工具结果）', async () => {
    let chatJSONCalls = 0;
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => {
          chatJSONCalls++;
          return { action: 'direct', reason: '闲聊' };
        },
        chat: async () => '你好',
        chatWithTools: async () => ({ content: '', toolCalls: [] }),
      }),
    );
    const r = await agent.run({ message: '你好' });
    expect(r.plan?.action).toBe('direct');
    expect(r.verification).toBeUndefined();
    expect(chatJSONCalls).toBe(1); // 仅规划，未校验
  });

  it('chatJSON 缺失时跳过校验', async () => {
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatWithTools: async () => ({
          content: '分析',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
      }),
    );
    const r = await agent.run({ message: '分析 600519' });
    expect(r.verification).toBeUndefined();
  });
});

describe('chatAgent — 风控三分视角辩论', () => {
  it('风控关键词命中时触发 riskDebate（非 debate 路径也能触发）', async () => {
    const runRiskDebate = vi.fn(async () => ({
      aggressive: '激进建议',
      neutral: '中性建议',
      conservative: '保守建议',
      synthesis: '综合风控决策',
    }));
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'tools', reason: '需要数据' }),
        chatWithTools: async () => ({
          content: '分析结果',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
        runRiskDebate,
      }),
    );
    const r = await agent.run({ message: '600519 风控建议' });
    expect(runRiskDebate).toHaveBeenCalled();
    expect(r.riskDebate?.synthesis).toBe('综合风控决策');
    expect(r.riskDebate?.aggressive).toBe('激进建议');
    expect(r.riskDebate?.conservative).toBe('保守建议');
  });

  it('debate 路径同时触发多空辩论和风控辩论', async () => {
    const runDebate = vi.fn(async () => ({ bull: '涨', bear: '跌', synthesis: '中性' }));
    const runRiskDebate = vi.fn(async () => ({
      aggressive: '加仓',
      neutral: '持有',
      conservative: '减仓',
      synthesis: '建议持有',
    }));
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        runDebate,
        runRiskDebate,
        chatWithTools: async () => ({ content: '分析', toolCalls: [] }),
      }),
    );
    const r = await agent.run({ message: '600519 多空辩论' });
    expect(runDebate).toHaveBeenCalled();
    expect(runRiskDebate).toHaveBeenCalled();
    expect(r.debate?.synthesis).toBe('中性');
    expect(r.riskDebate?.synthesis).toBe('建议持有');
  });

  it('无风控关键词且非 debate 路径时不触发 riskDebate', async () => {
    const runRiskDebate = vi.fn();
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'tools', reason: '分析' }),
        chatWithTools: async () => ({ content: '分析结果', toolCalls: [] }),
        runRiskDebate,
      }),
    );
    await agent.run({ message: '分析 600519' });
    expect(runRiskDebate).not.toHaveBeenCalled();
  });

  it('风控辩论失败时不影响主回答', async () => {
    const runRiskDebate = vi.fn(async () => {
      throw new Error('辩论服务不可用');
    });
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'tools', reason: '分析' }),
        chatWithTools: async () => ({
          content: '主回答',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
        runRiskDebate,
      }),
    );
    const r = await agent.run({ message: '600519 风控' });
    expect(r.answer).toBe('主回答');
    expect(r.riskDebate).toBeUndefined();
  });

  it('risk_debating 阶段事件在风控辩论时推送', async () => {
    const events: string[] = [];
    const runRiskDebate = vi.fn(async () => ({
      aggressive: '',
      neutral: '',
      conservative: '',
      synthesis: '',
    }));
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'tools', reason: '分析' }),
        chatWithTools: async () => ({
          content: '分析',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
        runRiskDebate,
      }),
    );
    await agent.runStream({ message: '600519 风控' }, (e) => events.push(e.phase));
    expect(events).toContain('risk_debating');
  });
});

describe('chatAgent — 流式阶段事件（runStream）', () => {
  it('逐阶段推送 retrieving→planning→...→done', async () => {
    const events: string[] = [];
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'tools', reason: '分析' }),
        chatWithTools: async () => ({
          content: '分析结果',
          toolCalls: [{ name: 'run_analysis', args: {} }],
        }),
      }),
    );
    await agent.runStream({ message: '分析 600519' }, (e) => events.push(e.phase));
    // 至少包含 retrieving、planning、tool_calling、verifying、done
    expect(events).toContain('retrieving');
    expect(events).toContain('planning');
    expect(events).toContain('tool_calling');
    expect(events[events.length - 1]).toBe('done');
  });

  it('done 事件携带完整 response', async () => {
    let doneResponse: { answer: string; toolsUsed: string[] } | undefined;
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        chatJSON: async () => ({ action: 'tools', reason: '分析' }),
        chatWithTools: async () => ({ content: '结果', toolCalls: [] }),
      }),
    );
    await agent.runStream({ message: '分析' }, (e) => {
      if (e.phase === 'done') doneResponse = e.response;
    });
    expect(doneResponse?.answer).toBe('结果');
  });

  it('离线降级时仍推送 done 事件', async () => {
    const events: string[] = [];
    const agent = createChatAgent(baseDeps({ isLLMAvailable: () => false }));
    await agent.runStream({ message: '分析 600519' }, (e) => events.push(e.phase));
    expect(events[events.length - 1]).toBe('done');
  });

  it('异常时推送 error 事件并 rethrow', async () => {
    const events: string[] = [];
    const agent = createChatAgent(
      baseDeps({
        isLLMAvailable: () => true,
        retrieveEvidence: async () => {
          throw new Error('检索崩溃');
        },
      }),
    );
    await expect(agent.runStream({ message: '分析' }, (e) => events.push(e.phase))).rejects.toThrow(
      '检索崩溃',
    );
    expect(events).toContain('error');
  });
});
