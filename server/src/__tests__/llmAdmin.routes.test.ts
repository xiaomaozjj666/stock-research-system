/**
 * /api/llm/calibration 校准入参契约（此前该端点 POST 分支零覆盖）
 * ----------------------------------------------------------------------------
 * 动机（2026-11-20 子代理审查）：model 是外部可写的 JSON key，原先无长度/字符集
 * 上限；correct 缺省或写成 "true" 会被隐式记为 miss——Laplace 权重被永久拉低，
 * 而该权重直接参与 runEnsemble 的投票聚合。本文件把契约钉住。
 */
import request from 'supertest';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware.js')>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  // 本文件请求数（6 次）超过 quantLimiter 默认 5/min
  return { ...actual, quantLimiter: pass };
});

import { app as rawApp } from '../index.js';
import { resetCalibration } from '../llm/ensemble.js';

// 校准文件重定向到临时目录：getCalibrationFile 惰性读 env（每次调用时），
// 在 beforeAll 设置即可——不需要 vi.hoisted（那里拿不到已导入的 fs/path）
const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-admin-cal-'));
const app = rawApp;

beforeAll(() => {
  process.env.MODEL_CALIBRATION_FILE = path.join(calDir, 'calibration.json');
});
afterAll(() => {
  try {
    fs.rmSync(calDir, { recursive: true, force: true });
  } catch {
    /* 清理失败可忽略 */
  }
});

describe('POST /api/llm/calibration 契约', () => {
  it('缺少 correct → 400（不隐式记 miss，避免误降权重）', async () => {
    resetCalibration();
    const r = await request(app).post('/api/llm/calibration').send({ model: 'deepseek-chat' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('correct');
  });

  it('correct 为字符串 "true" → 400（不做隐式转换）', async () => {
    const r = await request(app)
      .post('/api/llm/calibration')
      .send({ model: 'deepseek-chat', correct: 'true' });
    expect(r.status).toBe(400);
  });

  it('model 超长/含非法字符 → 400（防垃圾键无界增长）', async () => {
    const long = await request(app)
      .post('/api/llm/calibration')
      .send({ model: 'm'.repeat(100), correct: true });
    expect(long.status).toBe(400);
    const spaced = await request(app)
      .post('/api/llm/calibration')
      .send({ model: 'a b', correct: true });
    expect(spaced.status).toBe(400);
  });

  it('合法请求 → 200 且权重随之更新（Laplace：1 次命中 = 2/3）', async () => {
    resetCalibration();
    const r = await request(app)
      .post('/api/llm/calibration')
      .send({ model: 'deepseek-chat', correct: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.weights['deepseek-chat']).toBeCloseTo(2 / 3, 5);
  });

  it('GET 校准结果包含已登记模型', async () => {
    const r = await request(app).get('/api/llm/calibration');
    expect(r.status).toBe(200);
    expect(r.body.weights).toHaveProperty('deepseek-chat');
  });
});
