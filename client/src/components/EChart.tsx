import { memo, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import echarts from '../lib/echarts';
import type { ECharts } from '../lib/echarts';

interface EChartProps {
  option: unknown;
  style?: CSSProperties;
  className?: string;
  onChartReady?: (instance: ECharts) => void;
  /**
   * 图表的文本替代（读屏用）。canvas 对辅助技术是不可见的，
   * 不传时该图表对读屏等于不存在——传一句话说明"这张图在表达什么"即可。
   */
  ariaLabel?: string;
}

/**
 * 轻量 ECharts 封装（自研，替代 echarts-for-react）
 * ----------------------------------------------------------------------------
 * 背景：echarts-for-react@3.0.7 被 npm 标记为 "published in error"（已废弃），
 * 其 esm/ 产物用 extensionless 导入（非规范 ESM），生产构建（Rolldown）下
 * default 互操作会得到模块对象，导致 React 报
 * "Element type is invalid: ... but got: object"（ChartsSection 渲染崩溃）。
 *
 * 本组件只依赖项目内按需注册的 echarts/core（lib/echarts），职责与
 * echarts-for-react 相同：挂载时 init、option 变化时 setOption、ResizeObserver
 * 自适应、卸载时 dispose。完全可控、无额外依赖。
 */
/**
 * 内容级比较的成本控制：option 由父组件用 useMemo 稳定引用（依赖不含悬停索引），
 * 因此 memo 能挡住父组件因悬停/滚动产生的重渲染，避免每帧重复 JSON.parse 级别的工作。
 */
function EChart({ option, style, className, onChartReady, ariaLabel }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);

  // 初始化一次（挂载时）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    onChartReady?.(chart);

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
      // 关键：React StrictMode 下组件会 mount→unmount→再 mount（开发模式），
      // 若不清除已比较的 optionKey，二次挂载的新图表实例会因"内容相同"跳过
      // setOption 而渲染空白。必须在卸载时重置，让二次挂载重新应用 option。
      prevOptionKeyRef.current = null;
    };
    // 仅挂载时初始化一次；option 由下方 effect 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // option 内容级比较：父组件（如滚动监听驱动的重渲染）每次会重建 option 对象，
  // 引用比较会反复触发全量 setOption 重绘；JSON 内容相同则跳过，内容变化才重绘。
  // option 为纯数据（无函数引用/循环），JSON 序列化开销（微秒级）远小于重绘开销。
  const optionKey = JSON.stringify(option);
  const prevOptionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevOptionKeyRef.current === optionKey) return;
    prevOptionKeyRef.current = optionKey;
    // notMerge:false + replaceMerge：切换周期/叠加 MA/BOLL/MACD 时按组件增量更新，
    // 而不是整图重建（此前 notMerge:true 会丢弃实例状态、每次全量重绘）。
    // 之所以仍列出 replaceMerge：调用方每次都传完整 option，系列数可能减少
    // （例如关掉 MACD），不 replace 会残留上一次的系列。
    chartRef.current?.setOption(option as never, {
      notMerge: false,
      replaceMerge: ['series', 'xAxis', 'yAxis', 'grid', 'dataZoom'],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={style}
      role="img"
      aria-label={ariaLabel}
      // 无 ariaLabel 时不生成 role（空名元素比没有更糟：读屏会念"图像"却无内容）
      {...(ariaLabel ? {} : { role: undefined, 'aria-label': undefined })}
    />
  );
}

export default memo(EChart);
