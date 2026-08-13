import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';
import { auditLogger } from '../services/auditLog.js';

/**
 * 运行时熔断中间件集成测试（金融监管 8 号文合规）
 * 默认阈值：5 分钟窗口内 >3 critical 或 >10 high 即熔断。
 * 选 POST /api/chat 作为观测端点：熔断触发时返回 503；
 * 未触发时放行到业务层（空消息返回 400），以此区分两种状态。
 */
describe('合规熔断中间件（circuitBreakerGuard）', () => {
  beforeEach(() => {
    auditLogger.clear();
  });

  function logHigh(n: number) {
    for (let i = 0; i < n; i++) {
      auditLogger.log({
        sessionId: `cb-test-${i}`,
        action: 'trade.signal',
        category: 'trade_signal',
        detail: `高风险交易信号 ${i}`,
        riskLevel: 'high',
      });
    }
  }

  it('窗口内 high 条目超阈值（>10）→ 分析类请求被熔断 503', async () => {
    logHigh(11);
    const res = await request(app).post('/api/chat').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('熔断');
  });

  it('窗口内 high 条目未超阈值 → 放行到业务层（空消息 400）', async () => {
    logHigh(5);
    const res = await request(app).post('/api/chat').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('对话内容');
  });

  it('窗口内 critical 条目超阈值（>3）→ 分析类请求被熔断 503', async () => {
    for (let i = 0; i < 4; i++) {
      auditLogger.log({
        sessionId: `cb-critical-${i}`,
        action: 'llm.chat',
        category: 'llm_call',
        detail: `严重风险 ${i}`,
        riskLevel: 'critical',
      });
    }
    const res = await request(app).post('/api/chat').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('熔断');
  });

  it('info/medium 条目不计入熔断', async () => {
    for (let i = 0; i < 15; i++) {
      auditLogger.log({
        sessionId: `cb-low-${i}`,
        action: 'data.read',
        category: 'data_access',
        detail: `数据访问 ${i}`,
        riskLevel: i % 2 === 0 ? 'info' : 'medium',
      });
    }
    const res = await request(app).post('/api/chat').send({});
    expect(res.status).toBe(400); // 未熔断，走业务校验
  });
});
