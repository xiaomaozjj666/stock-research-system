import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAuditLog } from '../client.js';

const axiosInst = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => axiosInst } }));

function makeEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    timestamp: 1_700_000_000_000 + i * 1000,
    sessionId: 's1',
    action: `a${i}`,
    category: 'tool_call' as const,
    detail: `d${i}`,
    riskLevel: 'info' as const,
  }));
}

describe('getAuditLog 分页（limit / offset）', () => {
  beforeEach(() => {
    axiosInst.get.mockReset();
  });

  it('不传 limit/offset：返回服务端全量（保留旧调用方行为）', async () => {
    axiosInst.get.mockResolvedValue({ data: { count: 45, entries: makeEntries(45) } });
    const res = await getAuditLog();
    expect(res.count).toBe(45);
    expect(res.entries).toHaveLength(45);
    // 服务端 /api/audit 未实现分页：不把 limit/offset 发过去（发了也只是被忽略）
    expect(axiosInst.get).toHaveBeenCalledWith('/audit', { params: {}, timeout: 15000 });
  });

  it('limit=20：只返回前 20 条，count 仍是服务端总数', async () => {
    axiosInst.get.mockResolvedValue({ data: { count: 45, entries: makeEntries(45) } });
    const res = await getAuditLog({ limit: 20 });
    expect(res.entries).toHaveLength(20);
    expect(res.entries[0].id).toBe('e0');
    expect(res.count).toBe(45);
  });

  it('offset=20 & limit=20：返回第 21-40 条（供「加载更多」追加）', async () => {
    axiosInst.get.mockResolvedValue({ data: { count: 45, entries: makeEntries(45) } });
    const res = await getAuditLog({ limit: 20, offset: 20 });
    expect(res.entries).toHaveLength(20);
    expect(res.entries[0].id).toBe('e20');
    expect(res.entries[19].id).toBe('e39');
    expect(res.count).toBe(45);
  });

  it('最后一页不足 limit 时按实际条数返回', async () => {
    axiosInst.get.mockResolvedValue({ data: { count: 45, entries: makeEntries(45) } });
    const res = await getAuditLog({ limit: 20, offset: 40 });
    expect(res.entries.map((e) => e.id)).toEqual(['e40', 'e41', 'e42', 'e43', 'e44']);
  });

  it('offset 超出总数：返回空数组但保留 count（用于判断"没有更多"）', async () => {
    axiosInst.get.mockResolvedValue({ data: { count: 45, entries: makeEntries(45) } });
    const res = await getAuditLog({ limit: 20, offset: 100 });
    expect(res.entries).toEqual([]);
    expect(res.count).toBe(45);
  });

  it('过滤条件照常透传，分页参数留在本地', async () => {
    axiosInst.get.mockResolvedValue({ data: { count: 3, entries: makeEntries(3) } });
    await getAuditLog({ riskLevel: 'critical', limit: 10, offset: 5 });
    expect(axiosInst.get).toHaveBeenCalledWith('/audit', {
      params: { riskLevel: 'critical' },
      timeout: 15000,
    });
  });

  it('非法 limit（负数 / NaN）视为不限，offset 非法按 0 处理', async () => {
    axiosInst.get.mockResolvedValue({ data: { count: 45, entries: makeEntries(45) } });
    expect((await getAuditLog({ limit: -5 })).entries).toHaveLength(45);
    expect((await getAuditLog({ limit: Number.NaN })).entries).toHaveLength(45);
    expect((await getAuditLog({ offset: -3, limit: 2 })).entries.map((e) => e.id)).toEqual([
      'e0',
      'e1',
    ]);
  });

  it('服务端未返回 count 时回退为当前页长度（不让「共 N 条」显示 NaN）', async () => {
    axiosInst.get.mockResolvedValue({ data: { entries: makeEntries(4) } });
    const res = await getAuditLog({ limit: 10 });
    expect(res.count).toBe(4);
  });

  it('查询失败时抛中文提示（沿用 normalizeApiError 的兜底文案）', async () => {
    // 418 无业务文案 → 走各接口自己的兜底文案（500/404 等有专门文案，见 normalizeApiError）
    axiosInst.get.mockRejectedValue({ response: { status: 418, data: {} } });
    await expect(getAuditLog({ limit: 10 })).rejects.toThrow('审计查询失败');
  });
});
