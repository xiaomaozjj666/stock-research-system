import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuditLogger,
  auditLogger,
  auditLLMCall,
  auditToolCall,
  auditTradeSignal,
  auditDataAccess,
  filePersistenceHook,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLDS,
  type AuditLoggerOptions,
  type AuditEntry,
} from '../auditLog.js';

/**
 * 测试用工厂：创建可控时间与确定性 ID 的 AuditLogger
 * @returns logger 实例 + tick 函数（推进时钟毫秒）
 */
function createLogger(
  options: { thresholds?: Partial<AuditLoggerOptions['thresholds']>; maxEntries?: number } = {},
): { logger: AuditLogger; tick: (ms: number) => void; clock: () => number } {
  let clock = 1_000_000;
  let idCounter = 0;
  const logger = new AuditLogger({
    now: () => clock,
    generateId: () => `id-${++idCounter}`,
    thresholds: options.thresholds,
    maxEntries: options.maxEntries,
  });
  return {
    logger,
    tick: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}

describe('AuditLogger — 审计条目创建和查询', () => {
  let logger: AuditLogger;
  let tick: (ms: number) => void;
  let clock: () => number;

  beforeEach(() => {
    const r = createLogger();
    logger = r.logger;
    tick = r.tick;
    clock = r.clock;
  });

  it('log() 自动生成 id 和 timestamp', () => {
    const entry = logger.log({
      sessionId: 's1',
      action: 'test',
      category: 'system',
      detail: '测试条目',
      riskLevel: 'info',
    });
    expect(entry.id).toBeTruthy();
    expect(entry.id).toMatch(/^id-\d+$/);
    expect(entry.timestamp).toBe(clock());
    expect(entry.sessionId).toBe('s1');
    expect(entry.action).toBe('test');
    expect(entry.category).toBe('system');
    expect(entry.riskLevel).toBe('info');
  });

  it('log() 保留调用方提供的 id 和 timestamp', () => {
    const entry = logger.log({
      id: 'custom-id',
      timestamp: 12345,
      sessionId: 's1',
      action: 'test',
      category: 'system',
      detail: '自定义',
      riskLevel: 'info',
    });
    expect(entry.id).toBe('custom-id');
    expect(entry.timestamp).toBe(12345);
  });

  it('log() 保留可选字段 userId / traceId / metadata', () => {
    const entry = logger.log({
      sessionId: 's1',
      userId: 'u1',
      action: 'test',
      category: 'llm_call',
      detail: '带元数据',
      riskLevel: 'low',
      traceId: 'trace-abc',
      metadata: { model: 'gpt-4', tokens: 100 },
    });
    expect(entry.userId).toBe('u1');
    expect(entry.traceId).toBe('trace-abc');
    expect(entry.metadata).toEqual({ model: 'gpt-4', tokens: 100 });
  });

  it('query({}) 返回全部条目', () => {
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's1',
      action: 'b',
      category: 'system',
      detail: '2',
      riskLevel: 'info',
    });
    expect(logger.query({})).toHaveLength(2);
  });

  it('query() 按 sessionId 过滤', () => {
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's2',
      action: 'b',
      category: 'system',
      detail: '2',
      riskLevel: 'info',
    });
    const r = logger.query({ sessionId: 's1' });
    expect(r).toHaveLength(1);
    expect(r[0].sessionId).toBe('s1');
  });

  it('size() 返回当前条目数', () => {
    expect(logger.size()).toBe(0);
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    expect(logger.size()).toBe(1);
  });

  it('clear() 清空所有条目', () => {
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    logger.clear();
    expect(logger.size()).toBe(0);
    expect(logger.query({})).toHaveLength(0);
  });
});

describe('AuditLogger — 按条件过滤', () => {
  let logger: AuditLogger;
  let tick: (ms: number) => void;

  beforeEach(() => {
    const r = createLogger();
    logger = r.logger;
    tick = r.tick;
    // 填充测试数据：4 条不同类别/等级/会话/用户/traceId 的条目
    // tick(1) 使时间戳为 1000000, 1000001, 1000002, 1000003
    logger.log({
      sessionId: 's1',
      userId: 'u1',
      action: 'a',
      category: 'llm_call',
      detail: 'd',
      riskLevel: 'low',
      traceId: 't1',
    });
    tick(1); // t=1000001
    logger.log({
      sessionId: 's1',
      userId: 'u2',
      action: 'b',
      category: 'tool_call',
      detail: 'd',
      riskLevel: 'high',
      traceId: 't2',
    });
    tick(1); // t=1000002
    logger.log({
      sessionId: 's2',
      userId: 'u1',
      action: 'c',
      category: 'trade_signal',
      detail: 'd',
      riskLevel: 'critical',
      traceId: 't1',
    });
    tick(1); // t=1000003
    logger.log({
      sessionId: 's2',
      userId: 'u2',
      action: 'd',
      category: 'data_access',
      detail: 'd',
      riskLevel: 'info',
      traceId: 't2',
    });
  });

  it('按单个 category 过滤', () => {
    const r = logger.query({ category: 'llm_call' });
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('a');
  });

  it('按多个 category 过滤', () => {
    const r = logger.query({ category: ['llm_call', 'tool_call'] });
    expect(r).toHaveLength(2);
  });

  it('按单个 riskLevel 过滤', () => {
    const r = logger.query({ riskLevel: 'critical' });
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('c');
  });

  it('按多个 riskLevel 过滤', () => {
    const r = logger.query({ riskLevel: ['high', 'critical'] });
    expect(r).toHaveLength(2);
  });

  it('按时间范围过滤（startTime + endTime）', () => {
    // 条目时间：1000000, 1000001, 1000002, 1000003
    const r = logger.query({ startTime: 1000001, endTime: 1000002 });
    expect(r).toHaveLength(2);
    expect(r[0].timestamp).toBe(1000001);
    expect(r[1].timestamp).toBe(1000002);
  });

  it('仅按 startTime 过滤', () => {
    const r = logger.query({ startTime: 1000002 });
    expect(r).toHaveLength(2);
  });

  it('仅按 endTime 过滤', () => {
    const r = logger.query({ endTime: 1000001 });
    expect(r).toHaveLength(2);
  });

  it('按 userId 过滤', () => {
    expect(logger.query({ userId: 'u1' })).toHaveLength(2);
    expect(logger.query({ userId: 'u2' })).toHaveLength(2);
  });

  it('按 traceId 过滤', () => {
    expect(logger.query({ traceId: 't1' })).toHaveLength(2);
    expect(logger.query({ traceId: 't2' })).toHaveLength(2);
  });

  it('组合多条件过滤（交集）', () => {
    const r = logger.query({ sessionId: 's1', riskLevel: 'high' });
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('b');
  });

  it('无匹配时返回空数组', () => {
    expect(logger.query({ sessionId: 'nonexistent' })).toHaveLength(0);
  });
});

describe('AuditLogger — 导出', () => {
  it('export() 导出全部条目为 JSON', () => {
    const { logger } = createLogger();
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's2',
      action: 'b',
      category: 'system',
      detail: '2',
      riskLevel: 'info',
    });
    const parsed = JSON.parse(logger.export()) as {
      exportedAt: string;
      count: number;
      entries: Array<{ sessionId: string }>;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.exportedAt).toBeTruthy();
    // exportedAt 是合法 ISO 时间
    expect(new Date(parsed.exportedAt).getTime()).not.toBeNaN();
  });

  it('export(sessionId) 只导出指定会话', () => {
    const { logger } = createLogger();
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's2',
      action: 'b',
      category: 'system',
      detail: '2',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's1',
      action: 'c',
      category: 'system',
      detail: '3',
      riskLevel: 'info',
    });
    const parsed = JSON.parse(logger.export('s1')) as {
      count: number;
      entries: Array<{ sessionId: string }>;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.entries.every((e) => e.sessionId === 's1')).toBe(true);
  });

  it('export() 空日志导出 count=0', () => {
    const { logger } = createLogger();
    const parsed = JSON.parse(logger.export()) as { count: number; entries: unknown[] };
    expect(parsed.count).toBe(0);
    expect(parsed.entries).toEqual([]);
  });
});

describe('AuditLogger — 熔断检查', () => {
  it('连续 critical 操作超过阈值触发熔断', () => {
    const { logger } = createLogger({
      thresholds: { windowMs: 5 * 60 * 1000, criticalThreshold: 3, highThreshold: 10 },
    });
    // 阈值是 >3 才熔断，3 个不触发
    for (let i = 0; i < 3; i++) {
      logger.log({
        sessionId: 's1',
        action: 'test',
        category: 'system',
        detail: `critical-${i}`,
        riskLevel: 'critical',
      });
    }
    expect(logger.checkCircuitBreaker().tripped).toBe(false);

    // 第 4 个 critical → 熔断
    logger.log({
      sessionId: 's1',
      action: 'test',
      category: 'system',
      detail: 'critical-3',
      riskLevel: 'critical',
    });
    const result = logger.checkCircuitBreaker();
    expect(result.tripped).toBe(true);
    expect(result.criticalCount).toBe(4);
    expect(result.totalHighRiskCount).toBe(4);
    expect(result.reason).toContain('critical');
    expect(result.reason).toContain('4');
  });

  it('high 操作超过阈值触发熔断', () => {
    const { logger } = createLogger({
      thresholds: { windowMs: 5 * 60 * 1000, criticalThreshold: 3, highThreshold: 5 },
    });
    // 5 个 high 不触发（阈值 >5）
    for (let i = 0; i < 5; i++) {
      logger.log({
        sessionId: 's1',
        action: 'test',
        category: 'system',
        detail: `high-${i}`,
        riskLevel: 'high',
      });
    }
    expect(logger.checkCircuitBreaker().tripped).toBe(false);

    // 第 6 个 high → 熔断
    logger.log({
      sessionId: 's1',
      action: 'test',
      category: 'system',
      detail: 'high-5',
      riskLevel: 'high',
    });
    const result = logger.checkCircuitBreaker();
    expect(result.tripped).toBe(true);
    expect(result.highCount).toBe(6);
    expect(result.totalHighRiskCount).toBe(6);
    expect(result.reason).toContain('high');
    expect(result.reason).toContain('6');
  });

  it('正常操作（info/low/medium）不触发熔断', () => {
    const { logger } = createLogger();
    for (let i = 0; i < 20; i++) {
      logger.log({
        sessionId: 's1',
        action: 'test',
        category: 'system',
        detail: `normal-${i}`,
        riskLevel: i % 2 === 0 ? 'info' : 'low',
      });
    }
    const result = logger.checkCircuitBreaker();
    expect(result.tripped).toBe(false);
    expect(result.criticalCount).toBe(0);
    expect(result.highCount).toBe(0);
    expect(result.totalHighRiskCount).toBe(0);
  });

  it('时间窗口外的高风险操作不触发熔断', () => {
    const { logger, tick } = createLogger({
      thresholds: { windowMs: 5 * 60 * 1000, criticalThreshold: 3, highThreshold: 10 },
    });
    // 在窗口起点记录 10 个 critical
    for (let i = 0; i < 10; i++) {
      logger.log({
        sessionId: 's1',
        action: 'test',
        category: 'system',
        detail: `old-critical-${i}`,
        riskLevel: 'critical',
      });
    }
    // 推进时间到窗口之外（5 分钟 + 1 毫秒）
    tick(5 * 60 * 1000 + 1);
    const result = logger.checkCircuitBreaker();
    expect(result.tripped).toBe(false);
    expect(result.criticalCount).toBe(0);
    expect(result.totalHighRiskCount).toBe(0);
  });

  it('按 sessionId 过滤熔断检查（仅该会话计入）', () => {
    const { logger } = createLogger({
      thresholds: { windowMs: 5 * 60 * 1000, criticalThreshold: 3, highThreshold: 10 },
    });
    // s1 有 4 个 critical（应熔断）
    for (let i = 0; i < 4; i++) {
      logger.log({
        sessionId: 's1',
        action: 'test',
        category: 'system',
        detail: `s1-c-${i}`,
        riskLevel: 'critical',
      });
    }
    // s2 有 0 个 critical
    logger.log({
      sessionId: 's2',
      action: 'test',
      category: 'system',
      detail: 's2-info',
      riskLevel: 'info',
    });
    expect(logger.checkCircuitBreaker('s1').tripped).toBe(true);
    expect(logger.checkCircuitBreaker('s2').tripped).toBe(false);
    // 不传 sessionId 检查全部 → 熔断
    expect(logger.checkCircuitBreaker().tripped).toBe(true);
  });

  it('critical 优先于 high 触发熔断（reason 体现 critical）', () => {
    const { logger } = createLogger({
      thresholds: { windowMs: 5 * 60 * 1000, criticalThreshold: 3, highThreshold: 5 },
    });
    // 同时超过 critical 和 high 阈值
    for (let i = 0; i < 6; i++) {
      logger.log({
        sessionId: 's1',
        action: 'test',
        category: 'system',
        detail: `high-${i}`,
        riskLevel: 'high',
      });
    }
    for (let i = 0; i < 4; i++) {
      logger.log({
        sessionId: 's1',
        action: 'test',
        category: 'system',
        detail: `critical-${i}`,
        riskLevel: 'critical',
      });
    }
    const result = logger.checkCircuitBreaker();
    expect(result.tripped).toBe(true);
    expect(result.criticalCount).toBe(4);
    expect(result.highCount).toBe(6);
    // critical 优先 → reason 应包含 critical
    expect(result.reason).toContain('critical');
  });

  it('getHighRiskEntries 返回 high 和 critical 条目', () => {
    const { logger, tick, clock } = createLogger();
    // tick(1) 使时间戳为 1000000, 1000001, 1000002, 1000003
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: 'info',
      riskLevel: 'info',
    });
    tick(1);
    logger.log({
      sessionId: 's1',
      action: 'b',
      category: 'system',
      detail: 'high',
      riskLevel: 'high',
    });
    tick(1);
    logger.log({
      sessionId: 's1',
      action: 'c',
      category: 'system',
      detail: 'critical',
      riskLevel: 'critical',
    });
    tick(1);
    logger.log({
      sessionId: 's1',
      action: 'd',
      category: 'system',
      detail: 'low',
      riskLevel: 'low',
    });

    // 全部高风险
    const all = logger.getHighRiskEntries();
    expect(all).toHaveLength(2);
    expect(all[0].riskLevel).toBe('high');
    expect(all[1].riskLevel).toBe('critical');

    // since 过滤：clock()=1000003，取 clock()-1=1000002 仅返回 critical 条目
    const sinceHigh = logger.getHighRiskEntries(clock() - 1);
    expect(sinceHigh).toHaveLength(1);
    expect(sinceHigh[0].riskLevel).toBe('critical');
  });

  it('getHighRiskEntries(since) 无匹配返回空数组', () => {
    const { logger, clock } = createLogger();
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: 'high',
      riskLevel: 'high',
    });
    // since 在未来 → 无匹配
    expect(logger.getHighRiskEntries(clock() + 99999)).toHaveLength(0);
  });

  it('熔断结果包含完整字段', () => {
    const { logger } = createLogger({
      thresholds: { windowMs: 300000, criticalThreshold: 3, highThreshold: 10 },
    });
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: 'h',
      riskLevel: 'high',
    });
    const result = logger.checkCircuitBreaker();
    expect(result).toHaveProperty('tripped');
    expect(result).toHaveProperty('windowMs', 300000);
    expect(result).toHaveProperty('criticalCount', 0);
    expect(result).toHaveProperty('highCount', 1);
    expect(result).toHaveProperty('totalHighRiskCount', 1);
    expect(result).toHaveProperty('checkedAt');
    expect(typeof result.checkedAt).toBe('number');
  });
});

describe('AuditLogger — 持久化钩子与内存上限', () => {
  it('持久化钩子每条记录调用一次', () => {
    const hook = vi.fn();
    const logger = new AuditLogger({ persistenceHook: hook });
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's1',
      action: 'b',
      category: 'system',
      detail: '2',
      riskLevel: 'info',
    });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0][0].sessionId).toBe('s1');
    expect(hook.mock.calls[1][0].action).toBe('b');
  });

  it('持久化钩子抛错不阻断审计主流程', () => {
    const hook = vi.fn(() => {
      throw new Error('磁盘满');
    });
    const logger = new AuditLogger({ persistenceHook: hook });
    // 不应抛出
    expect(() => {
      logger.log({
        sessionId: 's1',
        action: 'a',
        category: 'system',
        detail: '1',
        riskLevel: 'info',
      });
    }).not.toThrow();
    // 条目仍保留在内存中
    expect(logger.size()).toBe(1);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('超过 maxEntries 上限时丢弃最旧条目', () => {
    const { logger } = createLogger({ maxEntries: 3 });
    logger.log({
      sessionId: 's1',
      action: 'a',
      category: 'system',
      detail: '1',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's1',
      action: 'b',
      category: 'system',
      detail: '2',
      riskLevel: 'info',
    });
    logger.log({
      sessionId: 's1',
      action: 'c',
      category: 'system',
      detail: '3',
      riskLevel: 'info',
    });
    expect(logger.size()).toBe(3);
    // 第 4 条 → 最旧的 'a' 被丢弃
    logger.log({
      sessionId: 's1',
      action: 'd',
      category: 'system',
      detail: '4',
      riskLevel: 'info',
    });
    expect(logger.size()).toBe(3);
    const actions = logger.query({}).map((e) => e.action);
    expect(actions).toEqual(['b', 'c', 'd']);
  });
});

describe('AuditLogger — 默认熔断阈值', () => {
  it('DEFAULT_CIRCUIT_BREAKER_THRESHOLDS 符合 8 号文要求', () => {
    // 5 分钟内 >3 个 critical → 熔断
    expect(DEFAULT_CIRCUIT_BREAKER_THRESHOLDS.windowMs).toBe(5 * 60 * 1000);
    expect(DEFAULT_CIRCUIT_BREAKER_THRESHOLDS.criticalThreshold).toBe(3);
    expect(DEFAULT_CIRCUIT_BREAKER_THRESHOLDS.highThreshold).toBe(10);
  });

  it('getThresholds() 返回当前阈值副本', () => {
    const logger = new AuditLogger({
      thresholds: { criticalThreshold: 5 },
    });
    const t = logger.getThresholds();
    expect(t.criticalThreshold).toBe(5);
    // 其余使用默认值
    expect(t.windowMs).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLDS.windowMs);
    expect(t.highThreshold).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLDS.highThreshold);
    // 副本：修改不影响内部状态
    t.criticalThreshold = 999;
    expect(logger.getThresholds().criticalThreshold).toBe(5);
  });
});

describe('辅助函数 — 写入全局 auditLogger 单例', () => {
  beforeEach(() => {
    auditLogger.clear();
  });

  it('auditLLMCall 创建 llm_call 审计条目', () => {
    const entry = auditLLMCall('s1', 'gpt-4', '你好', '你好！', 'low');
    expect(entry.category).toBe('llm_call');
    expect(entry.action).toBe('llm.chat');
    expect(entry.riskLevel).toBe('low');
    expect(entry.metadata?.model).toBe('gpt-4');
    expect(entry.metadata?.prompt).toBe('你好');
    expect(entry.metadata?.response).toBe('你好！');
    expect(auditLogger.query({ category: 'llm_call' })).toHaveLength(1);
  });

  it('auditLLMCall 默认风险等级为 low', () => {
    const entry = auditLLMCall('s1', 'gpt-4', 'p', 'r');
    expect(entry.riskLevel).toBe('low');
  });

  it('auditLLMCall 可自定义风险等级', () => {
    const entry = auditLLMCall('s1', 'gpt-4', 'p', 'r', 'medium');
    expect(entry.riskLevel).toBe('medium');
  });

  it('auditToolCall 创建 tool_call 审计条目', () => {
    const entry = auditToolCall('s1', 'run_analysis', { code: '600519' }, { score: 85 }, 'medium');
    expect(entry.category).toBe('tool_call');
    expect(entry.action).toBe('tool.run_analysis');
    expect(entry.riskLevel).toBe('medium');
    expect(entry.metadata?.toolName).toBe('run_analysis');
    expect(entry.metadata?.args).toEqual({ code: '600519' });
    expect(entry.metadata?.result).toEqual({ score: 85 });
  });

  it('auditToolCall 默认风险等级为 low', () => {
    const entry = auditToolCall('s1', 'test', {}, {});
    expect(entry.riskLevel).toBe('low');
  });

  it('auditTradeSignal 创建 trade_signal 审计条目', () => {
    const entry = auditTradeSignal('s1', '600519', '买入', '基本面良好');
    expect(entry.category).toBe('trade_signal');
    expect(entry.action).toBe('trade.signal');
    expect(entry.riskLevel).toBe('medium');
    expect(entry.metadata?.stockCode).toBe('600519');
    expect(entry.metadata?.signal).toBe('买入');
    expect(entry.metadata?.reasoning).toBe('基本面良好');
  });

  it('auditTradeSignal 强烈信号自动提升为 high', () => {
    const strong1 = auditTradeSignal('s1', '600519', '强烈买入', '技术面突破');
    const strong2 = auditTradeSignal('s1', '600519', '强烈卖出', '技术面破位');
    const strong3 = auditTradeSignal('s1', '600519', '重仓建仓', '估值极低');
    const strong4 = auditTradeSignal('s1', '600519', '紧急清仓', '黑天鹅事件');
    expect(strong1.riskLevel).toBe('high');
    expect(strong2.riskLevel).toBe('high');
    expect(strong3.riskLevel).toBe('high');
    expect(strong4.riskLevel).toBe('high');
  });

  it('auditTradeSignal 普通信号保持 medium', () => {
    const entry = auditTradeSignal('s1', '600519', '持有', '趋势平稳');
    expect(entry.riskLevel).toBe('medium');
  });

  it('auditDataAccess 创建 data_access 审计条目', () => {
    const entry = auditDataAccess('s1', '财务数据库', 'read');
    expect(entry.category).toBe('data_access');
    expect(entry.action).toBe('data.read');
    expect(entry.riskLevel).toBe('info');
    expect(entry.metadata?.resource).toBe('财务数据库');
    expect(entry.metadata?.action).toBe('read');
  });

  it('辅助函数均写入全局单例', () => {
    auditLLMCall('s1', 'm', 'p', 'r');
    auditToolCall('s1', 't', {}, {});
    auditTradeSignal('s1', '600519', '买入', 'r');
    auditDataAccess('s1', 'res', 'read');
    expect(auditLogger.size()).toBe(4);
    // 按类别验证
    expect(auditLogger.query({ category: 'llm_call' })).toHaveLength(1);
    expect(auditLogger.query({ category: 'tool_call' })).toHaveLength(1);
    expect(auditLogger.query({ category: 'trade_signal' })).toHaveLength(1);
    expect(auditLogger.query({ category: 'data_access' })).toHaveLength(1);
  });
});

describe('审计日志落盘持久化（JSON 行追加到 audit.log）', () => {
  // 测试隔离：重定向到进程专属临时文件，避免与其他测试文件的并行 worker 竞态写同一真实 audit.log
  let tmpDir: string;
  let tmpFile: string;
  let origEnv: string | undefined;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-'));
    tmpFile = path.join(tmpDir, 'audit.log');
    origEnv = process.env.AUDIT_LOG_FILE;
    process.env.AUDIT_LOG_FILE = tmpFile;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.AUDIT_LOG_FILE;
    else process.env.AUDIT_LOG_FILE = origEnv;
  });

  it('filePersistenceHook 把条目追加为一行 JSON', () => {
    const before = fs.existsSync(tmpFile) ? fs.readFileSync(tmpFile, 'utf-8') : '';
    const beforeLines = before ? before.split('\n').filter((l) => l.trim()).length : 0;

    const entry: AuditEntry = {
      id: 'persist-1',
      timestamp: 123456,
      sessionId: 's1',
      action: 'data.read',
      category: 'data_access',
      detail: '测试资源 (read)',
      riskLevel: 'info',
    };
    filePersistenceHook(entry);

    const after = fs.readFileSync(tmpFile, 'utf-8');
    const afterLines = after.split('\n').filter((l) => l.trim());
    expect(afterLines.length).toBe(beforeLines + 1);

    // 末行即新写入的条目，可反序列化为合法 JSON
    const parsed = JSON.parse(afterLines[afterLines.length - 1]) as AuditEntry;
    expect(parsed.id).toBe('persist-1');
    expect(parsed.category).toBe('data_access');
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.riskLevel).toBe('info');
  });

  it('全局 auditLogger 已配置落盘：辅助函数调用后写入 audit.log', () => {
    // 内存计数与文件均为追加式；校验末行对应本次调用
    auditLogger.clear();
    auditDataAccess('s1', '行情/财务数据接口', 'read');

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
    expect(last.category).toBe('data_access');
    expect(last.action).toBe('data.read');
    expect(last.sessionId).toBe('s1');
    expect(typeof last.id).toBe('string');
    expect(typeof last.timestamp).toBe('number');
  });

  it('落盘钩子抛错不阻断（AuditLogger 内部静默降级）', () => {
    // 模拟磁盘写失败：注入一个抛错的钩子，log() 不应抛，条目仍保留在内存
    const throwing = new AuditLogger({
      persistenceHook: () => {
        throw new Error('磁盘写失败');
      },
    });
    expect(() => {
      throwing.log({
        sessionId: 's1',
        action: 'a',
        category: 'system',
        detail: '1',
        riskLevel: 'info',
      });
    }).not.toThrow();
    expect(throwing.size()).toBe(1);
  });
});
