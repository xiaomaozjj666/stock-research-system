/**
 * 限时包装：超时就 reject，用于不让尽力而为的网络抓取阻塞主流程。
 * index.ts、analysisPipeline.ts、watchlistBacktest.ts 均从本模块导入，
 * 避免 copy-paste 重复定义。
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
