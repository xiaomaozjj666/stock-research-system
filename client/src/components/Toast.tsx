import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type ToastType = 'success' | 'info' | 'error';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** 全局轻提示：导出/复制/删除等操作的即时反馈（2.5s 自动消失） */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'success') => {
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev.slice(-3), { id, type, message }]); // 最多同时 4 条
      const timer = setTimeout(() => dismiss(id), 2500);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  // 卸载时清掉所有待触发的自动消失定时器：泄漏的 timer 会在组件消失后
  // 触发 setState——测试环境里 jsdom 已卸载、后续文件是 node 环境时直接
  // 抛 "window is not defined"（2026-11-21 全仓测试实测 13 个 uncaught）。
  useEffect(() => {
    const pending = timersRef.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} role="status">
            {t.type === 'error' ? '⚠️ ' : t.type === 'success' ? '✓ ' : 'ℹ️ '}
            {t.message}
            <button className="toast-close" aria-label="关闭提示" onClick={() => dismiss(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
