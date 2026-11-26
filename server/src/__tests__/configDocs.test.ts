/**
 * 配置与文档一致性（防止「代码改了、文档没改」的自相矛盾）
 * ----------------------------------------------------------------------------
 * 研究历史容量与 Webhook 超时都有「默认值 + 允许范围」三个副本：
 * 代码常量、`.env.example`、README。任何一处漂移都会让用户按文档配置却被
 * 服务端拒绝（或反之）。这里直接读文档文本做断言——文案改动导致测试失败是
 * 有意的：同时更新常量或文档，才算一次完整变更。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HISTORY_MAX_ITEMS,
  HISTORY_MAX_ITEMS_HARD_LIMIT,
} from '../services/historyLimits.js';
import {
  MAX_HISTORY_MAX_ITEMS,
  MAX_WEBHOOK_TIMEOUT_MS,
  MIN_WEBHOOK_TIMEOUT_MS,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
} from '../services/settings.js';

// server/src/__tests__ → 仓库根
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf-8');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');

describe('配置常量与文档一致', () => {
  it('历史容量硬上限只有一个真源', () => {
    expect(MAX_HISTORY_MAX_ITEMS).toBe(HISTORY_MAX_ITEMS_HARD_LIMIT);
  });

  it('.env.example 的历史容量默认值与范围与代码一致', () => {
    expect(envExample).toContain(`默认 ${DEFAULT_HISTORY_MAX_ITEMS}`);
    expect(envExample).toContain(`1–${HISTORY_MAX_ITEMS_HARD_LIMIT}`);
  });

  it('.env.example 的 Webhook 超时默认值与范围与代码一致', () => {
    expect(envExample).toContain(`默认 ${DEFAULT_WEBHOOK_TIMEOUT_MS}`);
    expect(envExample).toContain(`[${MIN_WEBHOOK_TIMEOUT_MS}, ${MAX_WEBHOOK_TIMEOUT_MS}]`);
  });

  it('README 描述的历史容量与代码一致', () => {
    expect(readme).toContain(`默认保留 ${DEFAULT_HISTORY_MAX_ITEMS} 条`);
    expect(readme).toContain(`1–${HISTORY_MAX_ITEMS_HARD_LIMIT}`);
  });
});
