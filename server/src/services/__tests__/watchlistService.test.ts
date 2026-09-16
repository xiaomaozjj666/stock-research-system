import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  setWatchlist,
  getWatchlistAlertsSnapshot,
  normalizeAlertsSnapshot,
  saveWatchlistAlertsSnapshot,
  MAX_ALERTS_PER_SNAPSHOT,
  DEFAULT_WATCHLIST_MAX,
  watchlistMax,
  type WatchlistAlertsSnapshot,
} from '../watchlistService.js';
import type { WatchlistAlert } from '../alerts.js';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(
    os.tmpdir(),
    `watchlist-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`,
  );
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

/* ============================================================================
 * 最近一次异动监控快照：落盘 → 读回 / 原子写 / 上限裁剪 / 空结构
 * ==========================================================================*/
describe('watchlistService 异动监控快照', () => {
  let alertsDir: string;
  let alertsFile: string;

  beforeEach(() => {
    alertsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-alerts-'));
    alertsFile = path.join(alertsDir, 'watchlistAlerts.json');
    process.env.WATCHLIST_ALERTS_FILE = alertsFile;
  });

  afterEach(() => {
    delete process.env.WATCHLIST_ALERTS_FILE;
    try {
      fs.rmSync(alertsDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function alert(code: string): WatchlistAlert {
    return {
      code,
      name: `股票${code}`,
      level: 'strong-bull',
      polarity: 0.8,
      weightedImpact: 0.5,
      detail: `${code} 新闻姿态强烈看多`,
    };
  }

  function snapshotWith(alerts: WatchlistAlert[]): WatchlistAlertsSnapshot {
    return normalizeAlertsSnapshot({
      generatedAt: '2026-09-15T10:00:00.000Z',
      monitored: alerts.length,
      alerts,
    });
  }

  it('无快照文件时返回稳定空结构（不抛、不 404）', () => {
    expect(getWatchlistAlertsSnapshot()).toEqual({ generatedAt: null, monitored: 0, alerts: [] });
  });

  it('落盘后可读回（刷新/复访回看的依据）', () => {
    expect(saveWatchlistAlertsSnapshot(snapshotWith([alert('600519')]))).toBe(true);
    const back = getWatchlistAlertsSnapshot();
    expect(back.generatedAt).toBe('2026-09-15T10:00:00.000Z');
    expect(back.monitored).toBe(1);
    expect(back.alerts).toHaveLength(1);
    expect(back.alerts[0]).toMatchObject({ code: '600519', level: 'strong-bull' });
  });

  it('只保留最近一次快照：二次写入覆盖前一次，文件不累积', () => {
    saveWatchlistAlertsSnapshot(snapshotWith([alert('600519')]));
    saveWatchlistAlertsSnapshot(snapshotWith([alert('000001')]));
    expect(getWatchlistAlertsSnapshot().alerts.map((a) => a.code)).toEqual(['000001']);
    // 目录里只有快照本身，没有历史归档文件
    expect(fs.readdirSync(alertsDir)).toEqual(['watchlistAlerts.json']);
  });

  it('原子写：写完不留 .tmp 残留，且覆盖时旧快照不会被写坏', () => {
    fs.writeFileSync(alertsFile, JSON.stringify({ generatedAt: 'old', monitored: 1, alerts: [] }));
    saveWatchlistAlertsSnapshot(snapshotWith([alert('600519')]));
    expect(fs.existsSync(`${alertsFile}.tmp`)).toBe(false);
    // 文件始终是完整可解析的 JSON（半写状态在 rename 语义下不可能被读到）
    expect(() => JSON.parse(fs.readFileSync(alertsFile, 'utf-8'))).not.toThrow();
  });

  it('落盘失败返回 false 且清理临时文件（如目标路径不可写）', () => {
    // 把快照路径指向一个目录：临时文件能写、rename 必失败
    process.env.WATCHLIST_ALERTS_FILE = alertsDir;
    expect(saveWatchlistAlertsSnapshot(snapshotWith([alert('600519')]))).toBe(false);
    expect(fs.existsSync(`${alertsDir}.tmp`)).toBe(false); // 失败也要清干净
    expect(getWatchlistAlertsSnapshot()).toEqual({ generatedAt: null, monitored: 0, alerts: [] });
  });

  it('条数上限：超出 MAX_ALERTS_PER_SNAPSHOT 的条目被裁剪（文件不无限增长）', () => {
    const many = Array.from({ length: MAX_ALERTS_PER_SNAPSHOT + 50 }, (_, i) =>
      alert(String(600000 + i)),
    );
    expect(saveWatchlistAlertsSnapshot(snapshotWith(many))).toBe(true);
    expect(getWatchlistAlertsSnapshot().alerts).toHaveLength(MAX_ALERTS_PER_SNAPSHOT);
  });

  it('文件损坏时降级为空结构（不抛）', () => {
    fs.writeFileSync(alertsFile, '{ not valid json', 'utf-8');
    expect(getWatchlistAlertsSnapshot()).toEqual({ generatedAt: null, monitored: 0, alerts: [] });
  });

  it('脏数据条目被丢弃，不把非法字段透给前端', () => {
    fs.writeFileSync(
      alertsFile,
      JSON.stringify({
        generatedAt: '2026-09-15T10:00:00.000Z',
        monitored: 4,
        alerts: [
          {
            code: '600519',
            level: 'strong-bull',
            detail: 'ok',
            polarity: 0.7,
            weightedImpact: 0.4,
          },
          { code: '000001', level: 'not-a-level', detail: 'bad level' },
          { level: 'strong-bear', detail: 'no code' },
          null,
        ],
      }),
      'utf-8',
    );
    const back = getWatchlistAlertsSnapshot();
    expect(back.alerts).toHaveLength(1);
    expect(back.alerts[0].code).toBe('600519');
    expect(back.alerts[0].name).toBeNull(); // 缺失字段收敛为 null，而非 undefined
  });

  it('requested/skipped 随快照落盘并可读回（上限裁剪如实披露）', () => {
    saveWatchlistAlertsSnapshot(
      normalizeAlertsSnapshot({
        generatedAt: '2026-09-15T10:00:00.000Z',
        monitored: 20,
        alerts: [],
        requested: 200,
        skipped: 180,
      }),
    );
    const back = getWatchlistAlertsSnapshot();
    expect(back.monitored).toBe(20);
    expect(back.requested).toBe(200);
    expect(back.skipped).toBe(180);
  });

  it('无裁剪时快照不含 requested/skipped（响应结构保持既有兼容）', () => {
    const snap = normalizeAlertsSnapshot({
      generatedAt: '2026-09-15T10:00:00.000Z',
      monitored: 3,
      alerts: [],
      requested: 3,
      skipped: 0,
    });
    expect(snap).not.toHaveProperty('skipped');
    expect(snap).not.toHaveProperty('requested');
    // 脏输入自相矛盾（跳过 9 只 / 共 3 只）时，跳过数被夹到请求数以内
    const clamped = normalizeAlertsSnapshot({
      generatedAt: null,
      monitored: 0,
      alerts: [],
      requested: 3,
      skipped: 9,
    });
    expect(clamped.skipped).toBe(3);
  });
});

/* ============================================================================
 * 清单容量上限（P1：自选股无上限）
 * ----------------------------------------------------------------------------
 * 上限的「可操作 400」在路由层（见 __tests__/watchlistCapacity.routes.test.ts）；
 * 这里锁定服务层自己的闸门：解析 env、满员不写入、幂等新增不算新增、
 * 批量设置（无 HTTP 出口）不越限写入。
 * ==========================================================================*/
describe('watchlistService 清单容量上限', () => {
  afterEach(() => {
    delete process.env.WATCHLIST_MAX;
  });

  it('默认上限 200；WATCHLIST_MAX 可调', () => {
    delete process.env.WATCHLIST_MAX;
    expect(DEFAULT_WATCHLIST_MAX).toBe(200);
    expect(watchlistMax()).toBe(200);

    process.env.WATCHLIST_MAX = '3';
    expect(watchlistMax()).toBe(3);
  });

  it('上限配置非法（NaN / 0 / 负数）回落默认值，不把写入口变成永远拒绝', () => {
    for (const bad of ['abc', '0', '-5', '']) {
      process.env.WATCHLIST_MAX = bad;
      expect(watchlistMax(), `WATCHLIST_MAX=${bad}`).toBe(DEFAULT_WATCHLIST_MAX);
    }
  });

  it('达到上限后 addToWatchlist 不再写入（返回原清单，不静默扩容）', () => {
    process.env.WATCHLIST_MAX = '2';
    addToWatchlist('600519');
    addToWatchlist('000001');

    const res = addToWatchlist('300750');

    expect(res).toEqual(['600519', '000001']);
    expect(getWatchlist()).toEqual(['600519', '000001']); // 磁盘也没有被改写
  });

  it('满员时重复添加已有代码仍是幂等成功（去重优先于容量）', () => {
    process.env.WATCHLIST_MAX = '1';
    addToWatchlist('600519');
    expect(addToWatchlist('600519')).toEqual(['600519']);
  });

  it('删掉一只后可以继续新增', () => {
    process.env.WATCHLIST_MAX = '1';
    addToWatchlist('600519');
    expect(addToWatchlist('000001')).toEqual(['600519']);

    removeFromWatchlist('600519');
    expect(addToWatchlist('000001')).toEqual(['000001']);
  });

  it('setWatchlist 批量导入不越限写入（保留前 N 只）', () => {
    process.env.WATCHLIST_MAX = '2';
    const res = setWatchlist(['600519', '000001', '300750', '600036']);
    expect(res).toEqual(['600519', '000001']);
    expect(getWatchlist()).toEqual(['600519', '000001']);
  });

  it('removeFromWatchlist 复用统一校验：非法代码按「不存在」处理且不写盘', () => {
    addToWatchlist('600519');
    expect(removeFromWatchlist('abc')).toEqual(['600519']);
    expect(removeFromWatchlist('600519&x=1')).toEqual(['600519']);
    expect(removeFromWatchlist('600519')).toEqual([]);
  });

  it('addToWatchlist 复用统一校验：含特殊字符/超长的代码被拒绝', () => {
    expect(addToWatchlist('600519&lmt=99999')).toEqual([]);
    expect(addToWatchlist('0'.repeat(30))).toEqual([]);
    expect(getWatchlist()).toEqual([]);
  });
});
