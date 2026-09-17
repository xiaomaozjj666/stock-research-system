import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAuditLog } from '../client.js';

const axiosInst = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => axiosInst } }));

function makeEntries(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${from + i}`,
    timestamp: 1_700_000_000_000 + i * 1000,
    sessionId: 's1',
    action: `a${from + i}`,
    category: 'tool_call' as const,
    detail: `d${from + i}`,
    riskLevel: 'info' as const,
  }));
}

/**
 * 假服务端：按 limit/offset 切片并返回匹配总数——镜像 server/src/routes/audit.ts 的真实语义
 * （count 恒为匹配总数，entries 只给本页；不传分页则返回全量）。
 */
function fakeServer(total = 45) {
  return (url: string, config?: { params?: Record<string, unknown> }) => {
    expect(url).toBe('/audit');
    const params = config?.params ?? {};
    const offset = typeof params.offset === 'number' ? params.offset : 0;
    const limit = typeof params.limit === 'number' ? params.limit : undefined;
    const entries = makeEntries(total).slice(
      offset,
      limit === undefined ? undefined : offset + limit,
    );
    return Promise.resolve({ data: { count: total, entries } });
  };
}

describe('getAuditLog 分页（limit / offset 透传给服务端）', () => {
  beforeEach(() => {
    axiosInst.get.mockReset();
  });

  it('不传 limit/offset：不向服务端下发分页参数（服务端返回全量，保持旧行为）', async () => {
    axiosInst.get.mockImplementation(fakeServer(45));
    const res = await getAuditLog();
    expect(res.count).toBe(45);
    expect(res.entries).toHaveLength(45);
    expect(axiosInst.get).toHaveBeenCalledWith('/audit', { params: {}, timeout: 15000 });
  });

  it('limit=20：把 limit 透传给服务端（客户端不再本地切片）', async () => {
    axiosInst.get.mockImplementation(fakeServer(45));
    const res = await getAuditLog({ limit: 20 });
    expect(axiosInst.get).toHaveBeenCalledWith('/audit', {
      params: { limit: 20 },
      timeout: 15000,
    });
    expect(res.entries).toHaveLength(20);
    expect(res.entries[0].id).toBe('e0');
    expect(res.count).toBe(45); // count 是匹配总数，不是本页条数
  });

  it('offset=20 & limit=20：两者都透传，取回第 21-40 条（不再二次偏移）', async () => {
    axiosInst.get.mockImplementation(fakeServer(45));
    const res = await getAuditLog({ limit: 20, offset: 20 });
    expect(axiosInst.get).toHaveBeenCalledWith('/audit', {
      params: { limit: 20, offset: 20 },
      timeout: 15000,
    });
    expect(res.entries.map((e) => e.id)).toEqual(makeEntries(20, 20).map((e) => e.id));
    expect(res.entries[0].id).toBe('e20');
    expect(res.entries[19].id).toBe('e39');
    expect(res.count).toBe(45);
  });

  it('最后一页不足 limit 时按服务端返回的实际条数返回', async () => {
    axiosInst.get.mockImplementation(fakeServer(45));
    const res = await getAuditLog({ limit: 20, offset: 40 });
    expect(res.entries.map((e) => e.id)).toEqual(['e40', 'e41', 'e42', 'e43', 'e44']);
  });

  it('offset 超出总数：空数组但保留 count（用于判断"没有更多"）', async () => {
    axiosInst.get.mockImplementation(fakeServer(45));
    const res = await getAuditLog({ limit: 20, offset: 100 });
    expect(res.entries).toEqual([]);
    expect(res.count).toBe(45);
  });

  it('过滤条件与分页参数一起透传', async () => {
    axiosInst.get.mockImplementation(fakeServer(10));
    await getAuditLog({ riskLevel: 'critical', limit: 10, offset: 5 });
    expect(axiosInst.get).toHaveBeenCalledWith('/audit', {
      params: { riskLevel: 'critical', limit: 10, offset: 5 },
      timeout: 15000,
    });
  });

  it('非法 limit（负数 / NaN）不下发；非法 offset 按未传处理', async () => {
    axiosInst.get.mockImplementation(fakeServer(45));
    await getAuditLog({ limit: -5 });
    expect(axiosInst.get).toHaveBeenLastCalledWith('/audit', { params: {}, timeout: 15000 });

    await getAuditLog({ limit: Number.NaN });
    expect(axiosInst.get).toHaveBeenLastCalledWith('/audit', { params: {}, timeout: 15000 });

    await getAuditLog({ offset: -3, limit: 2 });
    expect(axiosInst.get).toHaveBeenLastCalledWith('/audit', {
      params: { limit: 2 },
      timeout: 15000,
    });
  });

  it('小数分页参数向下取整（服务端只接受非负整数）', async () => {
    axiosInst.get.mockImplementation(fakeServer(45));
    await getAuditLog({ limit: 2.9, offset: 1.2 });
    expect(axiosInst.get).toHaveBeenCalledWith('/audit', {
      params: { limit: 2, offset: 1 },
      timeout: 15000,
    });
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
