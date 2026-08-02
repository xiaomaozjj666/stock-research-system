import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  setWatchlist,
} from '../watchlistService.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `watchlist-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  process.env.WATCHLIST_FILE = tmpFile;
});

afterEach(() => {
  delete process.env.WATCHLIST_FILE;
  try {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }
});

describe('watchlistService', () => {
  it('空清单时 getWatchlist 返回 []（文件不存在不抛）', () => {
    expect(getWatchlist()).toEqual([]);
  });

  it('非法代码被拒绝，不写入文件', () => {
    const res = addToWatchlist('abc');
    expect(res).toEqual([]);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('合法代码可添加并持久化到磁盘', () => {
    const res = addToWatchlist('600519');
    expect(res).toEqual(['600519']);
    expect(fs.existsSync(tmpFile)).toBe(true);
    // 重新读取（模拟进程重启）
    expect(getWatchlist()).toEqual(['600519']);
  });

  it('添加重复代码去重，保持顺序稳定', () => {
    addToWatchlist('600519');
    addToWatchlist('000001');
    const res = addToWatchlist('600519');
    expect(res).toEqual(['600519', '000001']);
  });

  it('removeFromWatchlist 移除指定代码且幂等', () => {
    addToWatchlist('600519');
    addToWatchlist('000001');
    const after = removeFromWatchlist('600519');
    expect(after).toEqual(['000001']);
    expect(removeFromWatchlist('600519')).toEqual(['000001']);
  });

  it('setWatchlist 校验并去重', () => {
    const res = setWatchlist(['600519', '600519', 'abc', '000001']);
    expect(res).toEqual(['600519', '000001']);
  });

  it('损坏的 JSON 文件降级为 []（不抛）', () => {
    fs.writeFileSync(tmpFile, '{ this is not json', 'utf-8');
    expect(getWatchlist()).toEqual([]);
  });
});
