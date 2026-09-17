/**
 * 审计日志落盘：轮转阈值夹紧与"轮转失败不能吞条目"
 * ----------------------------------------------------------------------------
 * 两个真实缺陷的回归测试（均不读运行时数据文件：AUDIT_LOG_FILE 指向进程专属临时目录）：
 *  1. AUDIT_LOG_MAX_BYTES=-1 时 `auditFileSize + bytes > -1` 恒真 → 每写一条都轮转，
 *     历史留痕被一条条冲掉；现改为对阈值加下界夹紧（显式小值仍生效）。
 *  2. 轮转 + append 整体包在 catch 里静默降级 → Windows 上 audit.log.1 被占用时该条
 *     无声消失；现改为：轮转失败降级为直接 append（先保证落地）+ logger.error；
 *     append 本身失败也记 error（金融监管留痕缺口必须可见）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { filePersistenceHook, type AuditEntry } from '../auditLog.js';
import logger from '../../utils/logger.js';

let tmpDir: string;
let logFile: string;
const origLogFile = process.env.AUDIT_LOG_FILE;
const origMaxBytes = process.env.AUDIT_LOG_MAX_BYTES;

/** 生成 n 行合法审计 JSON（每行可直接 JSON.parse） */
function logLines(n: number): string {
  return Array.from({ length: n }, (_, i) => JSON.stringify(entry(`seed-${i}`))).join('\n') + '\n';
}

function entry(id: string): AuditEntry {
  return {
    id,
    timestamp: 1_700_000_000_000,
    sessionId: 's1',
    action: 'data.read',
    category: 'data_access',
    detail: `留痕 ${id}`,
    riskLevel: 'info',
  };
}

function nonEmptyLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-persist-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origLogFile === undefined) delete process.env.AUDIT_LOG_FILE;
  else process.env.AUDIT_LOG_FILE = origLogFile;
  if (origMaxBytes === undefined) delete process.env.AUDIT_LOG_MAX_BYTES;
  else process.env.AUDIT_LOG_MAX_BYTES = origMaxBytes;
});

beforeEach(() => {
  // 每条用例一个独立文件：模块级大小缓存按路径失效，互不干扰
  logFile = path.join(
    tmpDir,
    `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`,
  );
  process.env.AUDIT_LOG_FILE = logFile;
});

describe('AUDIT_LOG_MAX_BYTES 夹紧', () => {
  it('AUDIT_LOG_MAX_BYTES=-1 不再每条轮转（历史留痕不被冲掉）', () => {
    process.env.AUDIT_LOG_MAX_BYTES = '-1';
    const seeded = logLines(2);
    fs.writeFileSync(logFile, seeded, 'utf-8');
    // 自校验前提：预置内容必须小于夹紧后的下界（1KB），否则"未轮转"另有原因
    expect(fs.statSync(logFile).size).toBeLessThan(1024);

    filePersistenceHook(entry('a'));
    filePersistenceHook(entry('b'));

    // 旧实现：max=-1 → 每条都轮转 → audit.log.1 被创建、预置留痕被冲走
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    const ids = nonEmptyLines(logFile).map((l) => JSON.parse(l).id);
    expect(ids).toEqual(['seed-0', 'seed-1', 'a', 'b']);
  });

  it('显式小阈值仍生效（夹紧不会吞掉"故意设小"的语义）', () => {
    process.env.AUDIT_LOG_MAX_BYTES = '1024';
    fs.writeFileSync(logFile, logLines(40), 'utf-8'); // ≈8KB > 1024
    expect(fs.statSync(logFile).size).toBeGreaterThan(1024);

    filePersistenceHook(entry('rot'));

    expect(fs.existsSync(`${logFile}.1`)).toBe(true); // 触发轮转
    expect(nonEmptyLines(`${logFile}.1`)).toHaveLength(40); // 历史整份搬走
    const current = nonEmptyLines(logFile);
    expect(current).toHaveLength(1);
    expect(JSON.parse(current[0]).id).toBe('rot');
  });

  it('阈值非数字时回落默认（5MB），小文件不轮转', () => {
    process.env.AUDIT_LOG_MAX_BYTES = 'abc';
    fs.writeFileSync(logFile, logLines(2), 'utf-8');
    filePersistenceHook(entry('c'));
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    expect(nonEmptyLines(logFile)).toHaveLength(3);
  });
});

describe('轮转/写入失败不得静默吞掉留痕', () => {
  it('轮转失败时降级为直接 append：条目仍落盘，且记 error 日志', () => {
    process.env.AUDIT_LOG_MAX_BYTES = '1024';
    const seeded = logLines(40);
    fs.writeFileSync(logFile, seeded, 'utf-8');
    // 构造确定性的轮转失败：轮转需要先 rm audit.log.3（因 audit.log.2 存在），
    // 而 audit.log.3 是非空目录 → rmSync 抛 ERR_FS_EISDIR（等价于 Windows 上 .1 被占用）
    fs.writeFileSync(`${logFile}.2`, 'old-rotation\n', 'utf-8');
    fs.mkdirSync(`${logFile}.3`);
    fs.writeFileSync(path.join(`${logFile}.3`, 'busy.txt'), 'busy', 'utf-8');

    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      filePersistenceHook(entry('must-land'));

      // 1) 该条不能消失（旧实现：轮转抛错 → 整段被 catch 吞掉，这条静默丢失）
      const ids = nonEmptyLines(logFile).map((l) => JSON.parse(l).id);
      expect(ids).toContain('must-land');
      // 2) 原有留痕不被冲掉（降级 = 直接追加，未做轮转）
      expect(ids.slice(0, 40)).toEqual(Array.from({ length: 40 }, (_, i) => `seed-${i}`));
      // 3) 留痕缺口必须可见：error 日志已记
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.some((c) => String(c[0]).includes('轮转失败'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('append 本身失败时记 error 日志（不再静默跳过）', () => {
    // AUDIT_LOG_FILE 指向一个目录：mkdir 父目录成功、appendFileSync 必然 EISDIR
    const blocked = path.join(tmpDir, 'blocked-as-dir');
    fs.mkdirSync(blocked, { recursive: true });
    process.env.AUDIT_LOG_FILE = blocked;

    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      expect(() => filePersistenceHook(entry('lost'))).not.toThrow(); // 不阻断审计主流程
      expect(spy.mock.calls.some((c) => String(c[0]).includes('落盘失败'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
