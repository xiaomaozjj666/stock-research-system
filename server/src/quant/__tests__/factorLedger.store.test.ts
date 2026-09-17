/**
 * factorLedger 内存缓存 + 写入串行锁
 * ----------------------------------------------------------------------------
 * 背景：
 *  - GET /api/quant/factor/experiments 连读两遍（listFactorExperiments 与
 *    summarizeFactorExperiments 各自 readStore），台账满额（500 条 / 241KB）时每次 ≈ 2.0ms × 2；
 *  - recordFactorExperiments 是「readStore → 改 → writeStore」的读-改-写，writeStore 的
 *    tmp+rename 只防半写、不防丢更新：并发调用若交错，会各自基于旧台账整体覆盖，
 *    最多 500 条实验记录静默消失，而两边响应都声称写入成功。
 *
 * 本文件不读运行时数据文件：FACTOR_LEDGER_FILE 指向进程专属临时目录。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recordFactorExperiments,
  recordFactorExperimentsAsync,
  listFactorExperiments,
  summarizeFactorExperiments,
  clearFactorExperiments,
  withLedgerStoreLock,
  type FactorExperimentInput,
} from '../factorLedger.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-ledger-store-'));
const ledgerFile = path.join(tmpDir, 'ledger.json');
const origFile = process.env.FACTOR_LEDGER_FILE;

beforeAll(() => {
  process.env.FACTOR_LEDGER_FILE = ledgerFile;
});

afterAll(() => {
  if (origFile === undefined) delete process.env.FACTOR_LEDGER_FILE;
  else process.env.FACTOR_LEDGER_FILE = origFile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例从空台账开始（写空 + 缓存随即刷新）
  clearFactorExperiments();
});

function entry(over: Partial<FactorExperimentInput> = {}): FactorExperimentInput {
  return {
    source: 'expression',
    name: 'cs_test',
    universe: { requested: 6, included: 6 },
    horizon: 21,
    sampleSize: 400,
    icMean: 0.05,
    pValue: 0.01,
    oosStable: true,
    kept: true,
    ...over,
  };
}

function onDiskNames(): string[] {
  const parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')) as {
    items: { name: string }[];
  };
  return parsed.items.map((i) => i.name);
}

describe('factorLedger 并发写入（不丢记录）', () => {
  it('并发两次 record 后读回两条（内存与落盘都不丢）', async () => {
    const [first, second] = await Promise.all([
      recordFactorExperimentsAsync([entry({ name: 'first' })]),
      recordFactorExperimentsAsync([entry({ name: 'second' })]),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    const names = listFactorExperiments()
      .map((i) => i.name)
      .sort();
    expect(names).toEqual(['first', 'second']);
    expect(onDiskNames().sort()).toEqual(['first', 'second']); // 落盘同样是两条
  });

  it('多路并发（6 路）批量记录：一条不丢', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => recordFactorExperimentsAsync([entry({ name: `c${i}` })])),
    );
    expect(listFactorExperiments()).toHaveLength(6);
    expect(onDiskNames()).toHaveLength(6);
  });

  it('同步入口与异步入口混用也不丢条目', async () => {
    await Promise.all([
      recordFactorExperimentsAsync([entry({ name: 'async-1' })]),
      Promise.resolve().then(() => recordFactorExperiments([entry({ name: 'sync-1' })])),
      recordFactorExperimentsAsync([entry({ name: 'async-2' })]),
    ]);
    expect(
      listFactorExperiments()
        .map((i) => i.name)
        .sort(),
    ).toEqual(['async-1', 'async-2', 'sync-1']);
  });

  it('模块级互斥：并发的锁定段严格串行（读-改-写不会交错）', async () => {
    const order: string[] = [];
    const section = (tag: string, gapMs: number) =>
      withLedgerStoreLock(async () => {
        order.push(`${tag}-enter`);
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        order.push(`${tag}-exit`);
      });

    await Promise.all([section('a', 20), section('b', 0)]);

    // 没有锁时：a-enter → b-enter → b-exit → a-exit（交错）
    expect(order).toEqual(['a-enter', 'a-exit', 'b-enter', 'b-exit']);
  });

  it('锁定段内抛错不会让队列永久挂起（后续写入照常执行）', async () => {
    await expect(
      withLedgerStoreLock(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const added = await recordFactorExperimentsAsync([entry({ name: 'after-fail' })]);
    expect(added).toHaveLength(1);
    expect(listFactorExperiments().map((i) => i.name)).toEqual(['after-fail']);
  });
});

describe('factorLedger 内存缓存（同一请求只读一次）', () => {
  it('list 与 summarize 连续调用命中缓存：落盘文件消失后仍可读', () => {
    recordFactorExperiments([entry({ name: 'once' })]);
    expect(fs.existsSync(ledgerFile)).toBe(true);

    // 若两次调用各自再读一遍盘，此刻只会读到空台账
    fs.rmSync(ledgerFile);

    expect(listFactorExperiments().map((i) => i.name)).toEqual(['once']);
    const summary = summarizeFactorExperiments();
    expect(summary.total).toBe(1);
    expect(summary.kept).toBe(1);
    expect(summary.lastAt).toBeTruthy();
  });

  it('写盘失败返回 [] 且缓存失效：下次读盘重建（不拿失败的缓存继续跑）', () => {
    recordFactorExperiments([entry({ name: 'ok' })]);

    // 把台账文件指向一个目录：写入必然失败（rename 无法覆盖目录）
    process.env.FACTOR_LEDGER_FILE = tmpDir;
    expect(recordFactorExperiments([entry({ name: 'bad' })])).toEqual([]);
    process.env.FACTOR_LEDGER_FILE = ledgerFile;

    expect(listFactorExperiments().map((i) => i.name)).toEqual(['ok']);
  });
});
