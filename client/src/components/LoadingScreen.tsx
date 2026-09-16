import { useEffect, useRef, useState } from 'react';
import type { AnalysisStage } from '../api/client';

// 阶段顺序与「进入该阶段时的进度」（与后端 AnalysisStage 对齐）
const STAGE_ORDER: { phase: AnalysisStage['phase']; label: string; progress: number }[] = [
  { phase: 'data', label: '数据获取', progress: 20 },
  { phase: 'experts', label: '专家独立研判', progress: 50 },
  { phase: 'arbitration', label: '辩论仲裁', progress: 70 },
  { phase: 'scoring', label: '量化打分', progress: 85 },
  { phase: 'strategy', label: '策略回测', progress: 95 },
];

/**
 * 阶段内渐近推进的时间常数（毫秒）：约 1 分钟走完「本阶段起点 → 下一阶段起点」的 63%。
 * 为什么需要它：后端只在阶段切换时推事件，最慢的 experts → arbitration 阶段可能几分钟
 * 没有任何更新，进度条停在第 50% 不动会被读成"卡死"（审计：进度条几乎静止）。
 * 用 1 - e^(-t/τ) 逼近下一阶段起点：始终在涨、越接近越慢、数学上永不抵达 ——
 * 既表达"仍在推进"，又不会虚假地跨进下一阶段的区间。
 */
const CREEP_TAU_MS = 60_000;

/** 最后一个阶段没有"下一阶段起点"，用 99 收口（真正完成时整屏会被结果替换，进度条无需显示 100%） */
const LAST_STAGE_CEILING = 99;

/** 尚未收到任何阶段事件时的进度起点（等待首个 SSE 事件） */
const IDLE_BASE = 5;

/** 本机历史阶段耗时的 localStorage 键名与每阶段保留样本数（取中位数，抗单次异常） */
const HISTORY_KEY = 'srs:analysis-stage-durations';
const HISTORY_MAX_SAMPLES = 5;

/** 样本有效区间：过短（StrictMode 双挂载 / 秒退重试）与过长（挂机）的样本不入库 */
const MIN_SAMPLE_MS = 1_000;
const MAX_SAMPLE_MS = 30 * 60 * 1000;

/** 无历史时的经验值（毫秒）：与"全程约 1-3 分钟"的对外口径同量级 */
const FALLBACK_STAGE_MS: Record<string, number> = {
  data: 8_000,
  experts: 45_000,
  arbitration: 20_000,
  scoring: 15_000,
  strategy: 25_000,
};

/** 完全没有可用历史时的兜底区间（毫秒）：沿用原有"1-3 分钟"的说法，并随已耗时递减 */
const NO_HISTORY_RANGE_MS = { low: 60_000, high: 180_000 };

type StageHistory = Partial<Record<AnalysisStage['phase'], number[]>>;

/** 读取本机历史：解析失败（被清空 / 手改 / 隐私模式）一律当作无历史，绝不让加载屏崩掉 */
function readHistory(): StageHistory {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: StageHistory = {};
    for (const { phase } of STAGE_ORDER) {
      const arr = parsed?.[phase];
      if (!Array.isArray(arr)) continue;
      const samples = arr
        .filter(
          (v): v is number =>
            typeof v === 'number' && Number.isFinite(v) && v >= MIN_SAMPLE_MS && v <= MAX_SAMPLE_MS,
        )
        .slice(-HISTORY_MAX_SAMPLES);
      if (samples.length > 0) out[phase] = samples;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 记录一次真实阶段耗时（阶段切换 / 整屏卸载时调用），供后续同阶段的 ETA 估算。
 * 只保留最近 N 次：机器负载与模型耗时会漂移，久远样本对"这次还要多久"参考价值低。
 */
function recordStageDuration(phase: AnalysisStage['phase'], ms: number): void {
  if (!Number.isFinite(ms) || ms < MIN_SAMPLE_MS || ms > MAX_SAMPLE_MS) return;
  try {
    const history = readHistory();
    const samples = [...(history[phase] ?? []), Math.round(ms)].slice(-HISTORY_MAX_SAMPLES);
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ ...history, [phase]: samples }));
  } catch {
    /* 隐私模式 / 配额满：历史只是优化项，失败静默 */
  }
}

/** 中位数（偶数个取中间两个均值）：比平均值抗单次异常样本 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 阶段内渐近推进：base → ceiling 单调递增、永不抵达 ceiling */
function creepProgress(base: number, ceiling: number, elapsedMs: number): number {
  if (ceiling <= base) return base;
  const t = Math.max(0, elapsedMs);
  return base + (ceiling - base) * (1 - Math.exp(-t / CREEP_TAU_MS));
}

/** 时长文案：秒级展示，超过 1 分钟给到「X 分 Y 秒」 */
function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} 分钟` : `${m} 分 ${rest} 秒`;
}

/** 固定区间文案（无历史时）：1-3 分钟随已耗时收窄为「不到 X 分钟」 */
function formatEtaRange(lowMs: number, highMs: number): string {
  const high = Math.ceil(highMs / 60_000);
  const low = Math.floor(lowMs / 60_000);
  if (high <= 1) return '不到 1 分钟';
  if (low <= 0) return `不到 ${high} 分钟`;
  if (low >= high) return `约 ${high} 分钟`;
  return `${low}-${high} 分钟`;
}

/**
 * 剩余耗时估算。
 * - 有本机历史：各阶段取历史中位数（缺样本的阶段回退经验值），当前阶段再减去已耗时 → 点估计
 * - 完全无历史：回退固定区间（1-3 分钟）并随已耗时递减
 * 后端只推阶段不推百分比，所以剩余时间只能由"本机同阶段历史耗时"推算，必然是估算值。
 */
function estimateRemaining(
  currentIndex: number,
  stageElapsedMs: number,
  history: StageHistory,
  elapsedMs: number,
): { lowMs: number; highMs: number; fromHistory: boolean } {
  let total = 0;
  let fromHistory = false;
  for (let i = Math.max(currentIndex, 0); i < STAGE_ORDER.length; i++) {
    const phase = STAGE_ORDER[i].phase;
    const med = median(history[phase] ?? []);
    if (med != null) fromHistory = true;
    const expected = med ?? FALLBACK_STAGE_MS[phase] ?? 20_000;
    total += i === currentIndex ? Math.max(0, expected - stageElapsedMs) : expected;
  }
  if (!fromHistory) {
    return {
      lowMs: Math.max(0, NO_HISTORY_RANGE_MS.low - elapsedMs),
      highMs: Math.max(0, NO_HISTORY_RANGE_MS.high - elapsedMs),
      fromHistory: false,
    };
  }
  return { lowMs: total, highMs: total, fromHistory: true };
}

interface Props {
  stage?: AnalysisStage | null;
}

export default function LoadingScreen({ stage }: Props) {
  const startedAtRef = useRef(Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  /** 本机历史阶段耗时：挂载时读一次，避免渲染期反复 JSON.parse localStorage */
  const historyRef = useRef<StageHistory | null>(null);
  if (historyRef.current === null) historyRef.current = readHistory();

  /** 当前阶段的索引与进入时刻：进度 = 从阶段起点渐近逼近下一阶段起点 */
  const trackedRef = useRef({ index: -1, startedAt: startedAtRef.current });
  const [tracked, setTracked] = useState(trackedRef.current);

  // 秒级 ticker：一次同时驱动「已耗时」与阶段内渐近进度。
  // 不用 requestAnimationFrame —— 进度每帧只涨零点几个百分点，1 秒一跳配合
  // .loading-progress-bar 的 width 过渡已足够平滑，也避免每帧 setState 造成的长任务。
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 阶段切换：结算上一阶段的真实耗时（写入本机历史，供后续 ETA 估算）
  useEffect(() => {
    const phase = stage?.phase;
    const index = phase ? STAGE_ORDER.findIndex((s) => s.phase === phase) : -1;
    // done / error / 未知阶段：保持当前刻度不回退（否则进度条会突然掉回起点）
    if (index < 0 || trackedRef.current.index === index) return;
    const now = Date.now();
    const prev = trackedRef.current;
    if (prev.index >= 0) recordStageDuration(STAGE_ORDER[prev.index].phase, now - prev.startedAt);
    trackedRef.current = { index, startedAt: now };
    setTracked(trackedRef.current);
    setNowMs(now); // 立即刷新：切阶段后进度不留 1 秒空窗
  }, [stage?.phase]);

  // 分析完成时本屏是被直接卸载的（拿不到"下一阶段"事件），只能在卸载时补记最后一阶段；
  // 只补记最后一个阶段：中途取消/失败会留下被截断的样本，若按阶段记会把后续 ETA 拉低。
  // MIN_SAMPLE_MS 会滤掉 StrictMode 双挂载与秒退重试产生的噪声样本。
  useEffect(() => {
    return () => {
      const cur = trackedRef.current;
      if (cur.index === STAGE_ORDER.length - 1) {
        recordStageDuration(STAGE_ORDER[cur.index].phase, Date.now() - cur.startedAt);
      }
    };
  }, []);

  const activeIndex = tracked.index >= 0 ? tracked.index : 0;
  const base = tracked.index >= 0 ? STAGE_ORDER[tracked.index].progress : IDLE_BASE;
  const ceiling =
    tracked.index + 1 < STAGE_ORDER.length
      ? STAGE_ORDER[tracked.index + 1].progress
      : LAST_STAGE_CEILING;
  const stageElapsedMs = Math.max(0, nowMs - tracked.startedAt);
  const elapsedMs = Math.max(0, nowMs - startedAtRef.current);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const stageElapsedSec = Math.floor(stageElapsedMs / 1000);
  const progress = creepProgress(base, ceiling, stageElapsedMs);
  /**
   * 展示用整数百分比 = min(渐近值, 本阶段刻度上限)。
   * 为什么要封顶：渐近值数学上永远到不了下一阶段起点，但四舍五入后（如 69.99% → 70%）
   * 会正好显示成下一阶段的刻度，让"还在专家研判"看起来已经进入辩论仲裁。
   * 取「下一阶段起点 - 1」即始终停在本阶段区间内；最后一阶段封顶 99（真正的 100% 由结果页接管）。
   */
  const ceilingPct =
    tracked.index + 1 < STAGE_ORDER.length
      ? STAGE_ORDER[tracked.index + 1].progress - 1
      : LAST_STAGE_CEILING;
  const shownPct = Math.min(Math.round(progress), ceilingPct);

  const estimate = estimateRemaining(tracked.index, stageElapsedMs, historyRef.current, elapsedMs);
  const etaText =
    estimate.highMs <= 0
      ? // 估算已用尽：明确"仍在运行"，避免用户把"没有进度"读成"已死"
        '已超出历史估算时长（分析仍在运行）'
      : estimate.highMs > estimate.lowMs
        ? `预计还需 ${formatEtaRange(estimate.lowMs, estimate.highMs)}（经验值估算）`
        : `预计还需 ${formatDuration(estimate.lowMs / 1000)}（估算）`;

  const stageMessage = stage?.message || '正在初始化分析...';

  return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-spinner" />

        <div className="loading-stages">
          {STAGE_ORDER.map((s, i) => {
            let cls = 'loading-stage-item';
            if (i === activeIndex) cls += ' active';
            if (i < activeIndex) cls += ' done';
            return (
              <div key={s.phase} className={cls}>
                <div className="loading-stage-dot" />
                <div className="loading-stage-text">
                  <span className="loading-stage-label">{s.label}</span>
                  {/* 阶段文案对读屏可见；aria-live 只挂在这里，下方「已耗时」每秒变化但不播报 */}
                  {i === activeIndex && (
                    <span className="loading-stage-sub" role="status" aria-live="polite">
                      {stageMessage}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="loading-progress"
          role="progressbar"
          aria-label="分析进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shownPct}
        >
          {/* 进度条宽度用未取整的渐近值：整数显示封了顶，但条子本身仍在极缓慢地推进 */}
          <div className="loading-progress-bar" style={{ width: `${progress}%` }}>
            <div className="loading-progress-shimmer" />
          </div>
        </div>
        {/* 本阶段秒表：阶段内进度增长越来越慢（渐近），秒表是"仍在推进"最直接的证据。
            这一行不挂 aria-live：每秒变化，播报会淹没阶段文案 */}
        <p className="loading-progress-text">
          {shownPct}% · 本阶段已耗时 {formatDuration(stageElapsedSec)}
        </p>

        <p
          className="loading-hint"
          title={
            estimate.fromHistory
              ? '按本机历史同阶段耗时中位数估算（每阶段取最近 5 次）；无样本的阶段回退经验值'
              : '尚无本机历史样本，按经验区间 1-3 分钟估算；完整跑完一次后会改用本机历史中位数'
          }
        >
          已耗时 {formatDuration(elapsedSec)} · {etaText}
        </p>
      </div>
    </div>
  );
}
