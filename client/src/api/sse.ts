/**
 * SSE 流共享内核（个股分析 / 聊天 / 深度研究三处复用）
 * ----------------------------------------------------------------------------
 * 为什么单独抽一个文件：这三条流各自实现过 EventSource 的打开、首包看门狗、
 * 帧 JSON 解析与断线重连，行为已经悄悄分叉（例如只有个股分析会指数退避重连、
 * 只有聊天流在 settle 后丢弃队列中的帧）。这里只统一**可复用的机制**：
 *
 *  - 打开：EventSource 不能自定义请求头，令牌只能走 `?token=`，因此 URL 在
 *    构造时用 withTokenQuery 快照一次——重连沿用同一份令牌，与旧实现一致
 *    （旧实现的 url 也是在发起前算好，重连不重新读 localStorage）；
 *  - 解析：每帧 `JSON.parse`，失败交给 onParseError，由调用方决定文案与日志；
 *  - 看门狗：每次 open() 重新武装，收到任意帧即清除（含解析失败的帧）；
 *  - 重连：reconnectAfter 先断开旧连接再延迟 open，退避时长由调用方决定。
 *
 * **刻意不统一**的部分（保持各端点原有可观察行为）：
 *  - settle 语义与错误文案（AnalysisCancelledError / DeepResearchInterruptedError /
 *    聊天的 finish 事件）留在各自函数里；
 *  - 看门狗/onerror 的守卫条件（聊天按 settled，分析与研究按 received）；
 *  - 坏帧的可见化方式（聊天与分析 console.error 后回调 error 事件，研究只回调）；
 *  - close 之后已排进队列的帧仍会派发（旧实现如此），是否忽略由调用方自己的
 *    settled/cancelled 守卫决定。
 */
import { withTokenQuery } from './auth';

/** 首包看门狗时长：20 秒内一条帧都没收到即视为服务不可用（三条流共用） */
export const SSE_WATCHDOG_MS = 20000;

export interface SseSessionOptions {
  /** 已带业务 query 的请求路径；`?token=` 由本模块统一追加（EventSource 无自定义头） */
  path: string;
  /** 解析成功的帧（形状由调用方按端点契约断言） */
  onFrame: (data: unknown) => void;
  /** 帧 JSON 解析失败；本模块不写日志、不兜底文案 */
  onParseError?: (raw: string, err: unknown) => void;
  /** 传输层 error（EventSource.onerror）；重连或 settle 由调用方决定 */
  onTransportError?: () => void;
  /** 首包看门狗触发（尚未收到任何帧） */
  onWatchdogTimeout?: () => void;
  /** 看门狗毫秒；默认 SSE_WATCHDOG_MS，设 0 关闭 */
  watchdogMs?: number;
}

export class SseSession {
  private readonly url: string;
  private readonly watchdogMs: number;
  private es: EventSource | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private receivedAny = false;

  constructor(private readonly options: SseSessionOptions) {
    // 构造时快照令牌：重连不再重读 localStorage，与旧实现（先算 url 再连）等价
    this.url = withTokenQuery(options.path);
    this.watchdogMs = options.watchdogMs ?? SSE_WATCHDOG_MS;
  }

  /** 是否收到过任意一帧（含解析失败的帧）：用于区分「连不上」与「中途断开」 */
  get received(): boolean {
    return this.receivedAny;
  }

  /** 建立连接并重新武装首包看门狗（首次连接与每次重连都走这里） */
  open(): void {
    if (this.closed) return;
    const es = new EventSource(this.url);
    this.es = es;
    this.armWatchdog();
    es.onmessage = (event) => this.handleMessage(event);
    es.onerror = () => {
      this.options.onTransportError?.();
    };
  }

  /** 关闭当前连接并清掉看门狗；会话本身仍可再次 open()（重连路径用） */
  disconnect(): void {
    this.clearWatchdog();
    this.es?.close();
    this.es = null;
  }

  /**
   * 断线后延迟重连：先断开旧连接（避免同 URL 双连接与旧看门狗叠加），到点再 open()。
   * 退避时长由调用方计算（个股分析为 1s / 2s / 4s）。
   */
  reconnectAfter(delayMs: number): void {
    this.disconnect();
    if (this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delayMs);
  }

  /** 永久收尾：断开 + 取消待定重连；此后 open() 无效 */
  close(): void {
    this.closed = true;
    this.disconnect();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private handleMessage(event: { data: string }): void {
    // 解析失败的帧也算「收到过」：服务端在说话，只是帧坏了，不该触发重连
    this.receivedAny = true;
    this.clearWatchdog();
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      this.options.onParseError?.(String(event.data), err);
      return;
    }
    this.options.onFrame(data);
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.watchdogMs <= 0) return;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      this.options.onWatchdogTimeout?.();
    }, this.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
