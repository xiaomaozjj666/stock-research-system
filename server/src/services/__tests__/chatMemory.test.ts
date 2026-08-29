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

beforeEach(() => clearHistory(SID));
afterEach(() => clearHistory(SID));

describe('对话长期记忆持久化', () => {
  it('写入与读取历史', () => {
    appendTurn(SID, { role: 'user', content: 'a' });
    appendTurn(SID, { role: 'assistant', content: 'b' });
    const h = loadHistory(SID);
    expect(h.length).toBe(2);
    expect(h[0].content).toBe('a');
    expect(h[1].content).toBe('b');
  });

  it('超过上限截断最旧轮次', () => {
    const pairs = MAX_TURNS * 2 + 4;
    for (let i = 0; i < pairs; i++) {
      appendTurn(SID, { role: 'user', content: `m${i}` });
      appendTurn(SID, { role: 'assistant', content: `r${i}` });
    }
    const h = loadHistory(SID);
    expect(h.length).toBe(MAX_TURNS * 2);
    expect(h[0].content).toBe(`m${MAX_TURNS + 4}`); // 最旧的被截掉
  });

  it('清空指定 session', () => {
    appendTurn(SID, { role: 'user', content: 'a' });
    clearHistory(SID);
    expect(loadHistory(SID)).toEqual([]);
  });

  it('不同 session 互相隔离', () => {
    appendTurn(SID, { role: 'user', content: 'a' });
    expect(loadHistory('other-session')).toEqual([]);
  });
});

describe('sessionId 安全校验（原型链键防护）', () => {
  it.each(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])(
    '危险键 %s：读取安全返回空、写入被拒绝且不污染存储',
    (sid) => {
      expect(loadHistory(sid)).toEqual([]); // 不抛 TypeError（history is not iterable）
      expect(() => appendTurn(sid, { role: 'user', content: 'x' })).not.toThrow();
      expect(loadHistory(sid)).toEqual([]);
      // 存储文件中不得出现该键
      const raw = JSON.parse(require('node:fs').readFileSync(tmpFile, 'utf-8'));
      expect(Object.getOwnPropertyNames(raw)).not.toContain(sid);
    },
  );

  it.each(['a'.repeat(65), '包含空格', 'sess/../../etc', ''])('非法格式 %j：拒绝落盘', (sid) => {
    appendTurn(sid, { role: 'user', content: 'x' });
    expect(loadHistory(sid)).toEqual([]);
  });

  it('合法 sessionId 正常读写', () => {
    appendTurn('sess-abc123', { role: 'user', content: 'hi' });
    expect(loadHistory('sess-abc123')).toHaveLength(1);
  });
});
