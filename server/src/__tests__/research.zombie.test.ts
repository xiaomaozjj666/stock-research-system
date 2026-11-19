/**
 * /api/research/deep 同步超时的僵尸 run 行为（路由执行期）
 * ----------------------------------------------------------------------------
 * 修复前：Promise.race 超时返回 500 后，orchestrator.run 继续在后台跑且无人认领
 * ——并发槽位在响应 finally 里提前归还（真实并发可超上限），完成的成果不归档
 * （分钟级研究整体丢弃）。修复后：run promise 单独持有，槽位按 run 真实结束
 * 归还，超时的 run 在后台完成时照常归档（成果不丢弃）。
 *
 * 注入点：直接 mock ResearchOrchestrator 类——僵尸 run 是**路由层**的
 * 生命周期问题，与编排器内部细节无关；用「固定延迟后返回合法的 AgentRunResult」
 * 即可精确复现「响应已超时而 run 还在跑」的时序。
 */
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 环境变量必须在模块加载前就位：SYNC_TIMEOUT_MS 与限流 max 都是模块加载期快照
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX_ANALYZE = '200';
  process.env.RESEARCH_TIMEOUT_MS = '120'; // 同步响应 120ms 截止
  process.env.DEEPSEEK_API_KEY = 'test-key-for-zombie'; // 放行 LLM 可用检查
});

// 慢编排器：run 固定 600ms 后返回合法结果——超过 120ms 同步截止即制造僵尸 run
vi.mock('../research-agent/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../research-agent/index.js')>();
  const { makeRunResult } = await import('../test/researchFixture.js');
  return {
    ...actual,
    ResearchOrchestrator: class {
      constructor(_deps: unknown) {}
      async run(question: string) {
        await new Promise((r) => setTimeout(r, 600));
        return makeRunResult({ report: { ...makeRunResult().report, title: question } });
      }
    },
  };
});

import { app as rawApp } from '../index.js';
import { listResearchRuns } from '../services/researchLibrary.js';
import { withContract } from '../test/contractSupertest.js';

const app = withContract(rawApp);

let LIB_DIR = '';
const origLibDir = process.env.RESEARCH_LIBRARY_DIR;

beforeEach(() => {
  LIB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-research-zombie-'));
  process.env.RESEARCH_LIBRARY_DIR = LIB_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origLibDir === undefined) delete process.env.RESEARCH_LIBRARY_DIR;
  else process.env.RESEARCH_LIBRARY_DIR = origLibDir;
  fs.rmSync(LIB_DIR, { recursive: true, force: true });
});

describe('POST /api/research/deep 同步超时 → 僵尸 run 的收尾', () => {
  it('超时如实 500；后台 run 完成后成果归档进研究库（不丢弃）', async () => {
    const res = await request(app)
      .post('/api/research/deep')
      .send({ question: '白酒行业慢速研究问题', config: { maxRounds: 1 } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).toContain('超时');

    // 僵尸 run 在后台继续跑（600ms）：完成后 archiveRun 必须落库
    await vi.waitFor(
      () => {
        const items = listResearchRuns(50);
        expect(items.some((r) => r.question.includes('白酒行业慢速研究问题'))).toBe(true);
      },
      { timeout: 8000, interval: 100 },
    );
  });

  it('槽位按 run 真实结束归还：僵尸 run 未结束前第三个请求如实 429，结束后放行', async () => {
    // 打满两个槽位（两个请求各自 120ms 超时返回 500，但 run 各需 600ms）
    const [res1, res2] = await Promise.all([
      request(app).post('/api/research/deep').send({ question: '僵尸研究问题甲' }),
      request(app).post('/api/research/deep').send({ question: '僵尸研究问题乙' }),
    ]);
    expect(res1.status).toBe(500);
    expect(res2.status).toBe(500);

    // 此刻两个僵尸 run 仍未结束 → 第三个请求如实 429（修复前槽位已提前归还，
    // 第三个会被放行，真实并发超过 MAX_CONCURRENT_RUNS=2）
    const third = await request(app)
      .post('/api/research/deep')
      .send({ question: '第三个并发请求' });
    expect(third.status).toBe(429);

    // 等两个僵尸 run 真正结束后，槽位归还 → 新请求不再 429
    await vi.waitFor(
      async () => {
        const after = await request(app)
          .post('/api/research/deep')
          .send({ question: '僵尸结束后的新研究请求' });
        expect(after.status).not.toBe(429);
      },
      { timeout: 8000, interval: 200 },
    );

    // 三个僵尸/正常 run 的成果均落库（超时不丢成果）
    await vi.waitFor(
      () => {
        expect(listResearchRuns(50).length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 8000, interval: 100 },
    );
  });
});
