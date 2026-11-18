import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeRunResult } from '../../test/researchFixture.js';
import {
  deleteResearchRun,
  getResearchLibraryDir,
  getResearchRun,
  listResearchRuns,
  saveResearchRun,
} from '../researchLibrary.js';

/**
 * 研究库的持久化行为
 * ----------------------------------------------------------------------------
 * 重点不在「能存能取」，而在几个会真实伤人的边界：
 *  - id 直接拼文件名，必须挡掉路径穿越；
 *  - 容量淘汰后，明细文件不能变成永远列不出来的孤儿；
 *  - 索引损坏 / 磁盘写失败时，读侧必须干净降级（研究本身已成功，不能连带报错）。
 */

let dir = '';

const makeResult = makeRunResult;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-research-library-'));
  process.env.RESEARCH_LIBRARY_DIR = dir;
});

afterEach(() => {
  delete process.env.RESEARCH_LIBRARY_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('researchLibrary 保存与读取', () => {
  it('保存后列表返回摘要，且不含报告正文', () => {
    const saved = saveResearchRun({
      question: '白酒行业竞争格局',
      scope: { industry: '白酒' },
      result: makeResult(),
    });
    expect(saved).not.toBeNull();

    const items = listResearchRuns();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: saved!.id,
      question: '白酒行业竞争格局',
      title: '白酒行业竞争格局研究',
      rounds: 2,
      evidenceCount: 3,
      conflictCount: 0,
      sectionCount: 1,
      confidenceLabel: '高',
      stopReason: 'all_p0_sufficient',
    });
    // 摘要里不应出现完整报告字段
    expect(Object.keys(items[0])).not.toContain('result');
  });

  it('按 id 读取到完整记录（含 scope 与事件轨迹）', () => {
    const saved = saveResearchRun({
      question: '白酒行业竞争格局',
      scope: { industry: '白酒', timeRange: '近两年' },
      result: makeResult(),
    })!;

    const run = getResearchRun(saved.id);
    expect(run).not.toBeNull();
    expect(run!.scope).toEqual({ industry: '白酒', timeRange: '近两年' });
    expect(run!.result.events).toHaveLength(1);
    expect(run!.result.report.title).toBe('白酒行业竞争格局研究');
    expect(run!.result.reportMarkdown).toContain('白酒行业');
  });

  it('列表按新 -> 旧排序', () => {
    const a = saveResearchRun({
      question: '问题一',
      scope: {},
      result: makeResult({
        report: { ...makeResult().report, generatedAt: '2026-11-18T01:00:00.000Z' },
      }),
    })!;
    const b = saveResearchRun({ question: '问题二', scope: {}, result: makeResult() })!;
    expect(listResearchRuns().map((i) => i.id)).toEqual([b.id, a.id]);
  });

  it('limit 非法时回落到默认 20 条（读侧不抛错）', () => {
    saveResearchRun({ question: '问题一', scope: {}, result: makeResult() });
    expect(listResearchRuns(0)).toHaveLength(1);
    expect(listResearchRuns(Number.NaN)).toHaveLength(1);
  });
});

describe('researchLibrary 删除', () => {
  it('删除后列表与明细都不再可读', () => {
    const saved = saveResearchRun({ question: '问题一', scope: {}, result: makeResult() })!;
    expect(deleteResearchRun(saved.id)).toBe(true);
    expect(listResearchRuns()).toHaveLength(0);
    expect(getResearchRun(saved.id)).toBeNull();
  });

  it('重复删除返回 false', () => {
    const saved = saveResearchRun({ question: '问题一', scope: {}, result: makeResult() })!;
    deleteResearchRun(saved.id);
    expect(deleteResearchRun(saved.id)).toBe(false);
  });
});

describe('researchLibrary 边界与降级', () => {
  it('拒绝路径穿越形态的 id', () => {
    expect(getResearchRun('../../etc/passwd')).toBeNull();
    expect(getResearchRun('a/b')).toBeNull();
    expect(getResearchRun('..')).toBeNull();
    expect(deleteResearchRun('../../etc/passwd')).toBe(false);
  });

  it('索引损坏时列表降级为空数组', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json', 'utf-8');
    expect(listResearchRuns()).toEqual([]);
  });

  it('明细文件损坏时读取返回 null（不让一条坏数据打断整个页面）', () => {
    const saved = saveResearchRun({ question: '问题一', scope: {}, result: makeResult() })!;
    fs.writeFileSync(path.join(dir, `${saved.id}.json`), '{ broken', 'utf-8');
    expect(getResearchRun(saved.id)).toBeNull();
  });

  it('超过容量后淘汰最旧一条，且其明细文件被清理', () => {
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) {
      const saved = saveResearchRun({ question: `问题 ${i}`, scope: {}, result: makeResult() });
      expect(saved).not.toBeNull();
      ids.push(saved!.id);
    }
    const items = listResearchRuns(50);
    expect(items).toHaveLength(30);
    expect(items[0].id).toBe(ids[30]);
    expect(fs.existsSync(path.join(dir, `${ids[0]}.json`))).toBe(false);
  });

  it('目录不可写时保存返回 null，且不抛错', () => {
    // 用「目录位置被一个普通文件占住」制造写失败
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'x', 'utf-8');
    process.env.RESEARCH_LIBRARY_DIR = blocked;
    expect(saveResearchRun({ question: '问题一', scope: {}, result: makeResult() })).toBeNull();
    expect(getResearchLibraryDir()).toBe(blocked);
  });
});
