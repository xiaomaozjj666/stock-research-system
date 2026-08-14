import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import echarts from '../lib/echarts';
import type { ECharts } from '../lib/echarts';

interface EChartProps {
  option: unknown;
  style?: CSSProperties;
  className?: string;
  onChartReady?: (instance: ECharts) => void;
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
export default function EChart({ option, style, className, onChartReady }: EChartProps) {
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
    chartRef.current?.setOption(option as never, { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey]);

  return <div ref={containerRef} className={className} style={style} />;
}
