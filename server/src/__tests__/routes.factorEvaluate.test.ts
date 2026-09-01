import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../index.js';
import type { FactorObservation } from '../quant/factorEvaluation.js';

// ============================================================================
// /api/quant/factor/evaluate 路由集成测试（纯 CPU 计算，不触外部依赖）。
// 注意：该路由挂在 quantLimiter（每分钟 5 次，硬编码无 env 覆盖）之下，
// 因此本文件的请求数刻意控制在 4 次以内；超出会用例间相互挤占限额导致 429。
// ============================================================================

/** 6 个交易日 × 4 只标的、因子排序与下期收益完全一致的「完美因子」面板 */
function perfectPanel(): FactorObservation[] {
  const shape = [
    { symbol: 'S1', value: 1, ret: -0.03 },
    { symbol: 'S2', value: 2, ret: -0.01 },
    { symbol: 'S3', value: 3, ret: 0.01 },
    { symbol: 'S4', value: 4, ret: 0.03 },
  ];
  const out: FactorObservation[] = [];
  ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09'].forEach(
    (date, d) => {
      for (const s of shape) {
        out.push({
          date,
          symbol: s.symbol,
          // 每日因子值整体平移，截面内排序不变
          value: s.value + d * 10,
          // 收益按日缩放并加市场漂移：保序（正系数缩放），同时让每日截面均值
          // 随日期变化——否则市场收益为常数列，OLS 无法估计 alpha/beta
          returns: {
            1: s.ret * (1 + d * 0.2) + d * 0.002,
            5: s.ret * (1 + d * 0.2) * 2 + d * 0.002,
          },
        });
      }
    },
  );
  return out;
}

describe('POST /api/quant/factor/evaluate', () => {
  it('完美因子面板 → 200，返回 IC/分层/换手率/alpha-beta 与「有效」判定', async () => {
    const res = await request(app)
      .post('/api/quant/factor/evaluate')
      .send({ observations: perfectPanel(), options: { quantiles: 4 } });
    expect(res.status).toBe(200);

    expect(res.body.periods).toEqual([1, 5]);
    expect(res.body.sampleSize).toBe(24);
    expect(res.body.dropped).toBe(0);
    expect(res.body.neutralized).toBe(false);
    expect(res.body.byPeriod).toHaveLength(2);

    for (const p of res.body.byPeriod) {
      expect(p.ic.n).toBe(6);
      expect(p.ic.pValue).toBe(0); // 完美因子：每日 IC 恒为 1（std=0）→ 极显著
      expect(p.quantile.monotonicity).toBeCloseTo(1, 10);
      expect(p.quantile.spread).toBeGreaterThan(0);
      expect(p.turnover).not.toBeNull();
      expect(p.alphaBeta).not.toBeNull();
      expect(p.longShortCumulative).toBeGreaterThan(1);
      expect(p.verdict.effective).toBe(true);
      expect(p.verdict.reasons).toEqual([]);
    }
  });

  it('observations 缺失 → 400', async () => {
    const res = await request(app).post('/api/quant/factor/evaluate').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('observations');
  });

  it('date 格式非法 → 400 且指明下标', async () => {
    const res = await request(app)
      .post('/api/quant/factor/evaluate')
      .send({
        observations: [
          { date: '2024-01-02', value: 1, returns: { 1: 0.01 } },
          { date: 'bad-date', value: 2, returns: { 1: 0.02 } },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('observations[1].date');
  });

  it('缺失比例超过 maxLoss → 422（数据问题，可放宽阈值重试）', async () => {
    // JSON 无法表达 NaN：value 序列化为 null，端点必须将其落成 NaN 走「缺失剔除」，
    // 而不是经 Number(null)=0 洗成真实值——本用例同时验证这条转换链
    const res = await request(app)
      .post('/api/quant/factor/evaluate')
      .send({
        observations: [
          { date: '2024-01-02', value: 1, returns: { 1: 0.1 } },
          { date: '2024-01-02', value: NaN, returns: { 1: 0.2 } },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain('maxLoss');
  });
});
