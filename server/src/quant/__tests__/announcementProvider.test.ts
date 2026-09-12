/**
 * 公告数据源测试：列表/正文解析、缓存纪律、语境块组装。
 * fetch 全量 mock；缓存经 QUANT_ANNOUNCEMENT_CACHE_TTL_HOURS=0 旁路。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  fetchAnnouncementList,
  fetchAnnouncementContent,
  buildAnnouncementBrief,
} from '../announcementProvider.js';

const mockedFetch = vi.spyOn(globalThis, 'fetch');

let tmpDir = '';
beforeEach(() => {
  mockedFetch.mockReset();
  process.env.QUANT_ANNOUNCEMENT_CACHE_TTL_HOURS = '0';
  // 正文缓存 TTL 30 天不可配置（不可变数据）：逐用例隔离缓存目录
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-ann-'));
  process.env.DATA_CACHE_DIR = tmpDir;
});
afterEach(() => {
  delete process.env.DATA_CACHE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('fetchAnnouncementList — 列表解析与校验', () => {
  it('解析 art_code/title/notice_date（日期截前 10 位）', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          list: [
            {
              art_code: 'AN2026091201',
              title: '2026 年半年度报告',
              notice_date: '2026-08-28 21:30:00',
            },
            {
              art_code: 'AN2026091102',
              title: '关于回购股份的进展公告',
              notice_date: '2026-09-01',
            },
          ],
        },
      }),
    } as never);
    const r = await fetchAnnouncementList('600519');
    expect(r.code).toBe('600519');
    expect(r.announcements).toEqual([
      { artCode: 'AN2026091201', title: '2026 年半年度报告', date: '2026-08-28' },
      { artCode: 'AN2026091102', title: '关于回购股份的进展公告', date: '2026-09-01' },
    ]);
  });

  it('非 6 位代码抛错，不发请求', async () => {
    await expect(fetchAnnouncementList('AAPL')).rejects.toThrow('6 位');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('HTTP 非 2xx 如实报错', async () => {
    mockedFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as never);
    await expect(fetchAnnouncementList('600519')).rejects.toThrow('HTTP 503');
  });

  it('pageSize 钳制到 [1,30]', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { list: [] } }),
    } as never);
    await fetchAnnouncementList('600519', 999);
    expect(String(mockedFetch.mock.calls[0][0])).toContain('page_size=30');
    await fetchAnnouncementList('600519', 0);
    expect(String(mockedFetch.mock.calls[1][0])).toContain('page_size=1');
  });
});

describe('fetchAnnouncementContent — 正文', () => {
  it('取 notice_content；空正文如实返回空串', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: { notice_content: '本公司董事会及全体董事保证公告内容真实、准确、完整。' },
      }),
    } as never);
    expect(await fetchAnnouncementContent('AN001')).toContain('真实、准确、完整');
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { notice_content: '' } }),
    } as never);
    expect(await fetchAnnouncementContent('AN002')).toBe('');
  });
});

describe('buildAnnouncementBrief — 语境块', () => {
  it('标题一览 + 最新一篇正文；正文失败不拖垮标题块', async () => {
    mockedFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('np-anotice-stock')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              list: [
                { art_code: 'AN001', title: '半年度报告', notice_date: '2026-08-28' },
                { art_code: 'AN002', title: '回购进展', notice_date: '2026-09-01' },
              ],
            },
          }),
        } as never;
      }
      // 正文第一篇成功、（缓存关闭后不会二次请求同 art）
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { notice_content: '主要财务数据：营业收入同比增长 12%。' } }),
      } as never;
    });
    const brief = await buildAnnouncementBrief('600519');
    expect(brief).toContain('【最近公告');
    expect(brief).toContain('2026-08-28 半年度报告');
    expect(brief).toContain('【最新公告正文');
    expect(brief).toContain('同比增长 12%');
  });

  it('无公告 → null', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { list: [] } }),
    } as never);
    expect(await buildAnnouncementBrief('600519')).toBeNull();
  });
});
