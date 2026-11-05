/**
 * 后台调度器统一注册表 + 优雅关闭处理器
 * ----------------------------------------------------------------------------
 * 背景（架构整改）：server/src/index.ts 启动时拉起 4 个后台调度器
 * （outcomeRefresher / quantCachePruner / digestScheduler / improvementScheduler），
 * 但关闭流程只停了 outcome 一个——其余定时器在关闭期间仍可能触发回填/写盘，
 * 既阻碍进程及时退出，也可能在连接关闭后写坏状态。
 *
 * 现在：所有调度器启动后统一 registerScheduler(name, stop)，关闭时
 * stopAllSchedulers() 逐个停止（单个失败不影响其余），createShutdownHandler
 * 把「停调度器 → 等连接关闭 → 超时强退」串成完整、可单测的关闭流程。
 */
import logger from '../utils/logger.js';

interface SchedulerEntry {
  name: string;
  stop: () => void;
}

const schedulers: SchedulerEntry[] = [];
let shutdownStarted = false;

/**
 * 注册一个后台调度器的停止函数。
 * 若关闭流程已开始（竞态：启动回调晚于关闭信号），立即停止该调度器而不是注册，
 * 保证「关闭之后不会再有存活的定时任务」。
 */
export function registerScheduler(name: string, stop: () => void): void {
  if (shutdownStarted) {
    try {
      stop();
    } catch (err) {
      logger.warn('[Shutdown] 关闭期间注册即停止调度器失败', { name, err });
    }
    return;
  }
  schedulers.push({ name, stop });
}

/**
 * 停止全部已注册调度器（幂等：重复调用不再执行任何 stop）。
 * 单个 stop 抛错只记日志，不中断其余调度器的清理。
 */
export function stopAllSchedulers(): void {
  shutdownStarted = true;
  for (const { name, stop } of schedulers.splice(0)) {
    try {
      stop();
      logger.info('[Shutdown] 调度器已停止', { name });
    } catch (err) {
      logger.warn('[Shutdown] 调度器停止失败（继续清理其余）', { name, err });
    }
  }
}

/** 测试专用：清空注册表与关闭标记（生产路径不应调用） */
export function resetSchedulerRegistryForTests(): void {
  schedulers.length = 0;
  shutdownStarted = false;
}

export interface ShutdownHandlerDeps {
  /** 包装 server.close：所有现有连接关闭后触发回调 */
  closeServer: (callback: (err?: Error) => void) => void;
  /** 强制退出超时（默认 30s，避免长连接阻塞关闭）；测试可缩短 */
  forceExitTimeoutMs?: number;
  /** 退出函数（默认 process.exit）；测试注入断言用 */
  exit?: (code: number) => void;
}

/**
 * 生成优雅关闭处理器（SIGTERM/SIGINT/uncaughtException 共用）：
 * 1. 停全部后台调度器（关闭期间不再触发回填/写盘）；
 * 2. 等 server.close（进行中的请求完成）；
 * 3. 超时强制退出。
 * 重复信号只处理一次。
 */
export function createShutdownHandler(deps: ShutdownHandlerDeps): (signal: string) => void {
  const { closeServer, forceExitTimeoutMs = 30_000, exit = (code) => process.exit(code) } = deps;
  let isShuttingDown = false;

  return function gracefulShutdown(signal: string): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('收到关闭信号，开始优雅关闭', { signal });
    logger.info('[Shutdown] 等待进行中的请求完成');

    // 停止全部后台定时任务（统一注册表），避免关闭期间再触发回填
    stopAllSchedulers();

    const forceExit = setTimeout(() => {
      logger.error('[Shutdown] 30秒超时，强制关闭');
      exit(1);
    }, forceExitTimeoutMs);

    closeServer((err) => {
      clearTimeout(forceExit);
      if (err) {
        logger.error('[Shutdown] 关闭出错', { err });
        exit(1);
        return;
      }
      logger.info('[Shutdown] 所有连接已关闭，优雅关闭完成');
      exit(0);
    });
  };
}
