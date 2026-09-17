import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 限时调用点的取消语义（源码级不变量）
 * ----------------------------------------------------------------------------
 * 为什么用源码断言而不是行为断言：这组不变量管的是「**哪些限时包法**被用在哪些调用点上」，
 * 而超时预算都是 3s~12s 量级——逐个起真实定时器验一遍会让套件慢上几十秒，且验到的仍是
 * 「本用例 mock 出来的 provider」。行为面另有两处更划算的覆盖：
 *   - withAbortableTimeout 本身：utils/__tests__/timeout.test.ts（假定时器 + 真 AbortController）
 *   - 端到端「超时 → 交给 fetch 的 signal 真的 aborted」：quant/__tests__/newsSignalAbort.test.ts
 * 本文件补的是最后一环：调用点确实接上了上面这套机制。同一手法在本仓库已有先例
 * （utils/__tests__/clientAbort.test.ts 的「两条路由共用同一份实现」）。
 *
 * 两类调用点，判据完全不同，**不要按名字统一**：
 *   A. 上游接受 signal（新闻抓取 / K线 / 评级回填）→ 必须用 withAbortableTimeout，
 *      否则超时只让调用方提前失败，底层请求照旧跑满（8s 端点 + 30s LLM）。
 *   B. 上游是共享缓存的 producer（一致预期 / 公告）→ **必须不传 controller**：
 *      同一 key 的 producer 由 withQuantCache 在并发调用方之间共享，abort 会连带打断
 *      别人那次取数；而超时后让它跑完反而把结果写进缓存，白烧变成预热。
 *      这条例外的成立前提是 B 类 provider 自带硬上限，故一并钉住（下一条用例）。
 */

const SRC = path.join(import.meta.dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('A 类：上游接受 signal 的限时点必须可取消', () => {
  it('新闻抓取：管线 / 批量回测 / 两条量化路由都用 withAbortableTimeout，不再裸 withTimeout', () => {
    for (const file of [
      'services/analysisPipeline.ts',
      'services/watchlistBacktest.ts',
      'routes/quant.ts',
    ]) {
      const src = read(file);
      expect(src, `${file} 应引用 withAbortableTimeout`).toContain('withAbortableTimeout');
      // 反断言：裸 withTimeout 包 newsSignal 取数 → 8s 端点 + 30s LLM 打分继续跑满
      expect(src, `${file} 不应再出现裸 withTimeout 包 extractNewsSignal`).not.toMatch(
        /withTimeout\(\s*extractNewsSignal/,
      );
      expect(src, `${file} 应把 signal 交给 extractNewsSignal`).toContain('extractNewsSignal(');
    }
  });

  it('K线取数与评级回填：时限到点后能收手，而不是白跑到 provider 自己的 15s 上限', () => {
    const pipeline = read('services/analysisPipeline.ts');
    expect(pipeline).toContain(
      'withAbortableTimeout((signal) => fetchPriceHistory(stockCode, signal)',
    );
    expect(pipeline).toContain('withAbortableTimeout((signal) => evaluateOutcomes(3, signal)');
  });

  it('三条服务函数确实接受并使用 signal（签名与透传都在）', () => {
    const news = read('quant/newsSignal.ts');
    expect(news).toContain('export interface NewsFetchOptions');
    // 端点自身 8s 预算与调用方取消合并，任一置位都断开连接
    expect(news).toMatch(/AbortSignal\.any\(\[outer, ctrl\.signal\]\)/);

    const pipeline = read('services/analysisPipeline.ts');
    expect(pipeline).toMatch(
      /async function fetchPriceHistory\(\s*stockCode: string,\s*signal\?: AbortSignal/,
    );
    expect(pipeline).toMatch(/fetchOHLCVData\(stockCode, fmt\(beg\), fmt\(end\), signal\)/);

    const tracker = read('services/outcomeTracker.ts');
    expect(tracker).toMatch(
      /export async function evaluateOutcomes\(limit = 3, signal\?: AbortSignal\)/,
    );
    expect(tracker).toMatch(/fetchOHLCVData\(code, fmt\(start\), fmt\(end\), signal\)/);
  });
});

describe('B 类：共享缓存 producer 的限时点刻意不取消', () => {
  const pipeline = read('services/analysisPipeline.ts');

  it('一致预期 / 公告两个 provider 不传 controller（传了会打断同 key 的并发调用方）', () => {
    expect(pipeline).toMatch(/withTimeout\(fetchConsensusSnapshot\(stockCode\), 6000\)/);
    expect(pipeline).toMatch(/withTimeout\(buildAnnouncementBrief\(stockCode\), 6000\)/);
    // 反断言：这两个调用点一旦开始传 controller/signal，例外的前提就不成立了
    expect(pipeline).not.toMatch(/withAbortableTimeout\([^)]*fetchConsensusSnapshot/);
    expect(pipeline).not.toMatch(/withAbortableTimeout\([^)]*buildAnnouncementBrief/);
  });

  it('例外成立的前提：两个 provider 各自带硬上限，不取消也不会无限挂住', () => {
    // 一致预期的网络出口是 eventProvider.fetchReportRows（15s）
    expect(read('quant/consensusProvider.ts')).toContain('fetchReportRows');
    expect(read('quant/eventProvider.ts')).toMatch(/AbortSignal\.timeout\(15000\)/);
    // 公告的出口是 announcementProvider.fetchJson（12s）
    expect(read('quant/announcementProvider.ts')).toMatch(/AbortSignal\.timeout\(12_000\)/);
  });

  it('共享 producer 语义本身未被改动（abort 一个调用方不得影响其他调用方）', () => {
    const cache = read('quant/quantCache.ts');
    // withQuantCache 的 producer 不接受 signal：这是「不能被单个调用方取消」的实现依据
    expect(cache).toMatch(
      /export async function withQuantCache<T>\(\s*key: string,\s*ttlMs: number,\s*producer: \(\) => Promise<T>/,
    );
  });
});
