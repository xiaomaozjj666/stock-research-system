import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 校准数据持久化的三个回归点（llm/ensemble.ts 的 readCalibration/writeCalibration）：
 *  1. 写改为 tmp + rename 原子替换——直写会让读者读到半截 JSON，
 *     而 readCalibration 的 catch 会**静默**返回空档，随后一次 recordModelOutcome
 *     就把「只剩一条统计」的结果写回，历史命中率被整份抹掉且无任何报错；
 *  2. 读按 mtimeMs + size 记忆化——修复前 modelWeight 每次调用都整读整解析，
 *     runEnsemble 按模型数 N 次调用 = 每请求 N 次全文件读 + N 次 JSON.parse，
 *     全部同步阻塞事件循环；
 *  3. 记忆化不能反过来丢数据——写后必须失效，否则连续 recordModelOutcome
 *     会基于陈旧快照累加，统计结果恒为 1。
 */

/**
 * ESM 命名空间不可 spy（Cannot redefine property），改为用委托式 mock：
 * 全部转发给真实 fs，只在包装层计数 / 可注入失败。这样断言的是**真实系统调用序列**，
 * 而不是 mock 自己编出来的行为。
 */
const syscalls = vi.hoisted(() => ({
  readFileSync: 0,
  writeFileSync: 0,
  renameSync: 0,
  lastRename: null as [string, string] | null,
  failRename: false,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const wrapper = {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      syscalls.readFileSync += 1;
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      syscalls.writeFileSync += 1;
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      syscalls.renameSync += 1;
      // 存成 string：renameSync 的入参是 PathLike（string | Buffer | URL），
      // 本用例只关心「从 tmp 路径换到目标路径」，统一转字符串后断言更直接
      syscalls.lastRename = [String(args[0]), String(args[1])];
      if (syscalls.failRename) throw new Error('rename 失败');
      return actual.renameSync(...args);
    },
  };
  return wrapper;
});

/** 每个用例一个独立文件：memo 以 file 为键，换路径即天然 miss，避免依赖 resetModules */
let fileSeq = 0;
let tmpFile = '';

function resetSyscalls(): void {
  syscalls.readFileSync = 0;
  syscalls.writeFileSync = 0;
  syscalls.renameSync = 0;
  syscalls.lastRename = null;
  syscalls.failRename = false;
}

beforeEach(() => {
  fileSeq += 1;
  tmpFile = path.join(os.tmpdir(), `calib-atomic-${process.pid}-${fileSeq}.json`);
  process.env.MODEL_CALIBRATION_FILE = tmpFile;
  resetSyscalls();
});

afterEach(() => {
  for (const f of fs.existsSync(os.tmpdir()) ? fs.readdirSync(os.tmpdir()) : []) {
    if (f.startsWith(path.basename(tmpFile))) {
      try {
        fs.unlinkSync(path.join(os.tmpdir(), f));
      } catch {
        /* 已不存在 */
      }
    }
  }
  delete process.env.MODEL_CALIBRATION_FILE;
});

/** 动态导入，保证拿到与当前 env 对应的模块实例 */
async function loadEnsemble() {
  vi.resetModules();
  return import('../ensemble.js');
}

describe('ensemble 校准数据：原子写', () => {
  it('写入经由 rename 从临时路径落到目标路径', async () => {
    const { recordModelOutcome } = await loadEnsemble();

    recordModelOutcome('m1', true);

    expect(syscalls.renameSync).toBe(1);
    const [from, to] = syscalls.lastRename!;
    expect(from).not.toBe(tmpFile); // 先写 tmp
    expect(from.startsWith(tmpFile)).toBe(true);
    expect(to).toBe(tmpFile); // 再 rename 到最终路径
    expect(JSON.parse(fs.readFileSync(tmpFile, 'utf-8'))).toEqual({
      models: { m1: { correct: 1, total: 1 } },
    });
  });

  it('写入失败时静默降级，不向上抛（校准数据不是数据源）', async () => {
    const { recordModelOutcome } = await loadEnsemble();
    syscalls.failRename = true;

    expect(() => recordModelOutcome('m1', true)).not.toThrow();
  });

  it('临时文件不残留在目标目录', async () => {
    const { recordModelOutcome, resetCalibration } = await loadEnsemble();
    recordModelOutcome('m1', true);
    resetCalibration();

    const leftovers = fs
      .readdirSync(os.tmpdir())
      .filter((f) => f.startsWith(path.basename(tmpFile)) && f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('ensemble 校准数据：读记忆化', () => {
  it('文件未变时不再读盘（后续权重查询零 IO）', async () => {
    const { recordModelOutcome, modelWeight, getModelWeights } = await loadEnsemble();
    recordModelOutcome('m1', true);

    resetSyscalls();
    const first = modelWeight('m1');
    const afterFirst = syscalls.readFileSync;
    const second = modelWeight('m1');
    const third = getModelWeights()['m1'];
    const afterRest = syscalls.readFileSync;

    // 首次可能命中也可能 miss（取决于是否刚写入），但后续查询必须完全不读盘
    expect(afterRest).toBe(afterFirst);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('外部改动文件后能读到新内容（mtime 变更即失效）', async () => {
    const { recordModelOutcome, modelWeight } = await loadEnsemble();
    recordModelOutcome('m1', true);
    expect(modelWeight('m1')).toBeCloseTo(2 / 3); // (1+1)/(1+2)

    // 模拟另一个进程/另一条链路直接改文件（绕过本模块的写路径）
    fs.writeFileSync(tmpFile, JSON.stringify({ models: { m1: { correct: 9, total: 9 } } }));

    expect(modelWeight('m1')).toBeCloseTo(10 / 11);
  });

  it('文件损坏时回落默认权重且不抛，修复后可恢复', async () => {
    const { modelWeight } = await loadEnsemble();
    fs.writeFileSync(tmpFile, '{ 这不是合法 JSON', 'utf-8');
    expect(modelWeight('m1')).toBe(0.5);

    // 损坏内容被修复后应重新读到（损坏分支不写记忆化缓存）
    fs.writeFileSync(tmpFile, JSON.stringify({ models: { m1: { correct: 1, total: 1 } } }));
    expect(modelWeight('m1')).toBeCloseTo(2 / 3);
  });

  it('文件不存在时返回默认权重，不抛', async () => {
    const { modelWeight } = await loadEnsemble();
    expect(modelWeight('never-seen')).toBe(0.5);
  });
});

describe('ensemble 校准数据：写后失效（记忆化不得丢数据）', () => {
  it('连续记录正确累加，不因记忆化恒为 1', async () => {
    const { recordModelOutcome, modelWeight } = await loadEnsemble();

    for (let i = 0; i < 5; i++) recordModelOutcome('m1', true);

    // Laplace：(5+1)/(5+2)；若记忆化没在写后失效，这里会停在 2/3
    expect(modelWeight('m1')).toBeCloseTo(6 / 7);
    expect(JSON.parse(fs.readFileSync(tmpFile, 'utf-8'))).toEqual({
      models: { m1: { correct: 5, total: 5 } },
    });
  });

  it('对错混合记录的比例正确', async () => {
    const { recordModelOutcome, modelWeight } = await loadEnsemble();

    recordModelOutcome('m1', true);
    recordModelOutcome('m1', false);
    recordModelOutcome('m1', true);

    expect(modelWeight('m1')).toBeCloseTo(3 / 5); // (2+1)/(3+2)
  });

  it('不同模型互不干扰', async () => {
    const { recordModelOutcome, getModelWeights } = await loadEnsemble();

    recordModelOutcome('a', true);
    recordModelOutcome('a', true);
    recordModelOutcome('b', true);

    const weights = getModelWeights();
    expect(weights.a).toBeCloseTo(3 / 4); // (2+1)/(2+2)
    expect(weights.b).toBeCloseTo(2 / 3); // (1+1)/(1+2)
  });

  it('resetCalibration 清空后权重回落默认', async () => {
    const { recordModelOutcome, modelWeight, resetCalibration } = await loadEnsemble();

    recordModelOutcome('m1', true);
    recordModelOutcome('m1', true);
    resetCalibration();

    expect(modelWeight('m1')).toBe(0.5);
  });

  it('空模型名不写入任何统计', async () => {
    const { recordModelOutcome, getModelWeights } = await loadEnsemble();

    recordModelOutcome('', true);

    expect(getModelWeights()).toEqual({});
  });
});
