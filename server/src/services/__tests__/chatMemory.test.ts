import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHistory, appendTurn, clearHistory, MAX_TURNS } from '../chatMemory.js';

const SID = 'test-session-memory';

// 落盘重定向到进程专属临时文件，避免读写真实 server/src/data/chatHistory.json
const tmpDir = mkdtempSync(join(tmpdir(), 'chat-memory-'));
const tmpFile = join(tmpDir, 'chatHistory.json');
beforeAll(() => {
  process.env.CHAT_HISTORY_FILE = tmpFile;
});
afterAll(() => {
  delete process.env.CHAT_HISTORY_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearHistory(SID);
});
afterEach(async () => {
  await clearHistory(SID);
});

describe('对话长期记忆持久化', () => {
  it('写入与读取历史', async () => {
    await appendTurn(SID, { role: 'user', content: 'a' });
    await appendTurn(SID, { role: 'assistant', content: 'b' });
    const h = await loadHistory(SID);
    expect(h.length).toBe(2);
    expect(h[0].content).toBe('a');
    expect(h[1].content).toBe('b');
  });

  // 该用例做 168 次同步读+写（O(n²) 全文件重写），常态 ~730ms；
  // 极端负载下曾疑似逼近 vitest 默认 5s 超时，显式放宽到 30s 防误判。
  it('超过上限截断最旧轮次', { timeout: 30000 }, async () => {
    const pairs = MAX_TURNS * 2 + 4;
    for (let i = 0; i < pairs; i++) {
      await appendTurn(SID, { role: 'user', content: `m${i}` });
      await appendTurn(SID, { role: 'assistant', content: `r${i}` });
    }
    const h = await loadHistory(SID);
    expect(h.length).toBe(MAX_TURNS * 2);
    expect(h[0].content).toBe(`m${MAX_TURNS + 4}`); // 最旧的被截掉
  });

  it('清空指定 session', async () => {
    await appendTurn(SID, { role: 'user', content: 'a' });
    await clearHistory(SID);
    expect(await loadHistory(SID)).toEqual([]);
  });

  it('不同 session 互相隔离', async () => {
    await appendTurn(SID, { role: 'user', content: 'a' });
    expect(await loadHistory('other-session')).toEqual([]);
  });
});

describe('sessionId 安全校验（原型链键防护）', () => {
  it.each(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])(
    '危险键 %s：读取安全返回空、写入被拒绝且不污染存储',
    async (sid) => {
      expect(await loadHistory(sid)).toEqual([]); // 不抛 TypeError（history is not iterable）
      await appendTurn(sid, { role: 'user', content: 'x' }); // 非法键静默拒绝（不抛不落盘）
      expect(await loadHistory(sid)).toEqual([]);
      // 存储文件中不得出现该键
      const raw = JSON.parse(require('node:fs').readFileSync(tmpFile, 'utf-8'));
      expect(Object.getOwnPropertyNames(raw)).not.toContain(sid);
    },
  );

  it.each(['a'.repeat(65), '包含空格', 'sess/../../etc', ''])(
    '非法格式 %j：拒绝落盘',
    async (sid) => {
      await appendTurn(sid, { role: 'user', content: 'x' });
      expect(await loadHistory(sid)).toEqual([]);
    },
  );

  it('合法 sessionId 正常读写', async () => {
    await appendTurn('sess-abc123', { role: 'user', content: 'hi' });
    expect(await loadHistory('sess-abc123')).toHaveLength(1);
  });
});

describe('appendTurn 单条内容钳制（防快照膨胀）', () => {
  it('超过 8000 字的 content 落盘前截断并带标记', async () => {
    await appendTurn('clamp-test', { role: 'assistant', content: 'x'.repeat(9000) });
    const turns = await loadHistory('clamp-test');
    const stored = turns.at(-1)!;
    expect(stored.content.length).toBeLessThanOrEqual(8010);
    expect(String(stored.content)).toContain('已截断');
  });

  it('并发写（不同 session）经写队列串行化后互不覆盖', async () => {
    // 异步化的动机用例：appendTurn 是「读-改-写整个 store」，并发调用若无串行化
    // 会互相覆盖丢更新。写队列保证每个 session 的轮次都完整落盘。
    const sessions = Array.from({ length: 12 }, (_, i) => `conc-${i}`);
    await Promise.all(
      sessions.map((s, i) =>
        appendTurn(s, { role: 'user', content: `msg-${i}` }).then(() =>
          appendTurn(s, { role: 'assistant', content: `reply-${i}` }),
        ),
      ),
    );
    for (const [i, s] of sessions.entries()) {
      const h = await loadHistory(s);
      expect(h.map((t) => t.content)).toEqual([`msg-${i}`, `reply-${i}`]);
    }
  });
});
