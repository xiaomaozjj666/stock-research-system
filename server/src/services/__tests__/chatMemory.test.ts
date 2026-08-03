import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadHistory, appendTurn, clearHistory, MAX_TURNS } from '../chatMemory.js';

const SID = 'test-session-memory';

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
