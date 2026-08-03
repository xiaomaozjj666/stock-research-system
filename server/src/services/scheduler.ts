/**
 * 主动监控自治循环（autonomous loop）
 * ----------------------------------------------------------------------------
 * 周期性运行自选股监控 + 异动检测，命中则触发 onAlert 回调（推送/落库）。
 * 纯调度，不含网络；监控逻辑由调用方注入（生产注入 runWatchlistNewsBacktest）。
 * 单次失败不终止循环；stop() 可安全退出。
 */
import { detectAlerts, type WatchlistAlert, type WatchlistAlertInput } from './alerts.js';

export interface MonitorReport {
  results: WatchlistAlertInput[];
  count: number;
  generatedAt: string;
}

export interface AutonomousOptions {
  /** 轮询间隔（毫秒），默认 5 分钟 */
  intervalMs?: number;
  /** 监控函数：返回批量新闻回测报告 */
  monitor: () => Promise<MonitorReport>;
  /** 命中异动时回调 */
  onAlert?: (alerts: WatchlistAlert[], report: { count: number; generatedAt: string }) => void | Promise<void>;
}

export interface AutonomousState {
  running: boolean;
  intervalMs: number;
  lastRunAt?: string;
  lastAlertCount: number;
  /** 已发起的监控轮次（含失败轮次） */
  runCount: number;
  /** 失败轮次数 */
  errorCount: number;
  /** 最近一次失败原因 */
  lastError?: string;
}

export interface AutonomousController {
  stop: () => void;
  getState: () => AutonomousState;
}

export function startAutonomousLoop(opts: AutonomousOptions): AutonomousController {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  const state: AutonomousState = {
    running: true,
    intervalMs,
    lastAlertCount: 0,
    runCount: 0,
    errorCount: 0,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    // 轮次先自增：失败轮次也应计入，便于观测「跑了几轮 / 错了几轮」
    state.runCount += 1;
    try {
      const report = await opts.monitor();
      state.lastRunAt = report.generatedAt;
      const alerts = detectAlerts(report.results);
      state.lastAlertCount = alerts.length;
      if (alerts.length > 0 && opts.onAlert) {
        await opts.onAlert(alerts, { count: report.count, generatedAt: report.generatedAt });
      }
    } catch (err) {
      // 单次监控失败：记录但不终止循环
      state.errorCount += 1;
      state.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (state.running) timer = setTimeout(tick, intervalMs);
    }
  };

  // 首次延迟一个间隔启动（避免与请求同步阻塞）；之后按间隔循环
  timer = setTimeout(tick, intervalMs);
  // 不阻止进程退出（生产由 HTTP 服务保活；测试可干净退出）
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop() {
      state.running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    getState: () => ({ ...state }),
  };
}
