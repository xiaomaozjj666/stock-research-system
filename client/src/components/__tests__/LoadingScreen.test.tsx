// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import LoadingScreen from '../LoadingScreen';

const HISTORY_KEY = 'srs:analysis-stage-durations';

/** 读取本机历史（测试断言用） */
function stored(): Record<string, number[]> {
  return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}');
}

/** 进度条文本行：如 "63% · 本阶段已耗时 1 分钟" */
function progressText(): string {
  return screen.getByText(/% · 本阶段已耗时/).textContent ?? '';
}

/** 进度条百分比（整数） */
function shownPct(): number {
  return Number(/^(\d+)%/.exec(progressText())?.[1]);
}

function stage(
  phase: 'data' | 'experts' | 'arbitration' | 'scoring' | 'strategy',
  message = '进行中',
) {
  return { phase, message };
}

describe('LoadingScreen —— 进度不再"卡在固定百分比"', () => {
  beforeEach(() => {
    localStorage.clear();
    // 只伪造时钟与 interval：LoadingScreen 用秒级 ticker 驱动进度，
    // 不伪造 setTimeout，避免干扰 React 内部调度
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('等待首个阶段事件时从 5% 起（未收到阶段也不显示 0%）', () => {
    render(<LoadingScreen stage={null} />);
    expect(shownPct()).toBe(5);
    expect(screen.getByText('正在初始化分析...')).toBeInTheDocument();
  });

  it('进入阶段后从该阶段刻度起步（data = 20%）', () => {
    render(<LoadingScreen stage={stage('data')} />);
    expect(shownPct()).toBe(20);
  });

  it('阶段内渐近推进：专家阶段 1 分钟后约 63%（不再停在 50% 不动）', () => {
    render(<LoadingScreen stage={stage('experts')} />);
    expect(shownPct()).toBe(50);
    act(() => vi.advanceTimersByTime(60_000));
    // 50 + (70-50) * (1 - e^-1) ≈ 62.6 → 63
    expect(shownPct()).toBe(63);
  });

  it('越接近下一阶段越慢且永不跨进下一阶段刻度（10 分钟后仍是 69%，不是 70%）', () => {
    render(<LoadingScreen stage={stage('experts')} />);
    act(() => vi.advanceTimersByTime(600_000));
    expect(shownPct()).toBe(69);
    expect(shownPct()).toBeLessThan(70); // 70 = 辩论仲裁的起点
  });

  it('最后一阶段（策略回测）长时间运行也不显示 100%', () => {
    render(<LoadingScreen stage={stage('strategy')} />);
    act(() => vi.advanceTimersByTime(3_600_000));
    expect(shownPct()).toBe(99);
  });

  it('本阶段秒表随时间推进（"仍在运行"的直接证据）', () => {
    render(<LoadingScreen stage={stage('experts')} />);
    act(() => vi.advanceTimersByTime(42_000));
    expect(progressText()).toContain('本阶段已耗时 42 秒');
  });

  it('done / error 等非阶段事件不回退进度', () => {
    const { rerender } = render(<LoadingScreen stage={stage('strategy')} />);
    act(() => vi.advanceTimersByTime(30_000));
    const before = shownPct();
    rerender(<LoadingScreen stage={{ phase: 'done', message: '完成' }} />);
    expect(shownPct()).toBe(before);
  });
});

describe('LoadingScreen —— ETA 估算与文案', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('无历史时回退固定区间，并明确标注为估算', () => {
    render(<LoadingScreen stage={stage('data')} />);
    expect(screen.getByText(/已耗时 0 秒 · 预计还需 1-3 分钟（经验值估算）/)).toBeInTheDocument();
  });

  it('有本机历史时用同阶段耗时中位数给出剩余时间', () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify({
        data: [8000, 10000, 9000],
        experts: [50000, 60000],
        arbitration: [20000],
        // 中位数 = 40000（排序后取中间值），用于断言"取中位数而非平均/首项"
        strategy: [30000, 40000, 50000],
      }),
    );
    render(<LoadingScreen stage={stage('strategy')} />);
    expect(screen.getByText(/预计还需 40 秒（估算）/)).toBeInTheDocument();
    // 估算口径写在 title 里（不占用界面文案），"估算"二字必须在正文可见
    expect(screen.getByTitle(/按本机历史同阶段耗时中位数估算/)).toBeInTheDocument();
  });

  it('当前阶段超出历史中位数后仍明确"仍在运行"（不再显示 0 秒）', () => {
    render(<LoadingScreen stage={stage('experts')} />);
    act(() => vi.advanceTimersByTime(200_000)); // 已耗尽经验区间 1-3 分钟
    expect(screen.getByText(/已超出历史估算时长（分析仍在运行）/)).toBeInTheDocument();
  });

  it('阶段切换时把上一阶段真实耗时写入本机历史（供下次估算）', () => {
    const { rerender } = render(<LoadingScreen stage={stage('data')} />);
    act(() => vi.advanceTimersByTime(30_000));
    rerender(<LoadingScreen stage={stage('experts')} />);
    expect(stored().data).toEqual([30_000]);
  });

  it('过短的样本不入库（StrictMode 双挂载 / 秒退重试的噪声）', () => {
    const { rerender } = render(<LoadingScreen stage={stage('data')} />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<LoadingScreen stage={stage('experts')} />);
    expect(stored().data).toBeUndefined();
  });

  it('历史样本损坏（非 JSON / 非法值）时按无历史处理，不抛错', () => {
    localStorage.setItem(HISTORY_KEY, '{not json');
    render(<LoadingScreen stage={stage('data')} />);
    expect(screen.getByText(/经验值估算/)).toBeInTheDocument();
  });

  it('卸载时补记最后一个阶段（分析完成时拿不到"下一阶段"事件）', () => {
    const { unmount } = render(<LoadingScreen stage={stage('strategy')} />);
    act(() => vi.advanceTimersByTime(45_000));
    unmount();
    expect(stored().strategy).toEqual([45_000]);
  });
});
