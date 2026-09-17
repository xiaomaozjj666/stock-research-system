// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import NewsPostureHeatBar from '../NewsPostureHeatBar';
import type {
  NewsSignal,
  WatchlistNewsBacktestReport,
  WatchlistNewsBacktestRow,
} from '../../types';

/**
 * NewsPostureHeatBar 行为测试
 * ----------------------------------------------------------------------------
 * 组件本体只做三件事：把每只股票折算成一行（极性/影响强度/有无新闻/姿态）、按极性降序排、
 * 把颜色与 tooltip 文案交给 EChart。图表走 components/EChart → lib/echarts，
 * 这里按仓库既有约定 mock lib/echarts（init 返回可控实例），再直接调用 option 里的
 * formatter / 检查 series 颜色——即用户在图上真正看到的内容。
 *
 * 配色口径：红=看多、绿=看空、灰=无最新消息（见源码顶部注释）。
 */

const echartsMock = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('../../lib/echarts', () => ({
  default: { init: echartsMock.init },
}));

interface RowExtra {
  label: string;
  code: string;
  name: string | null;
  polarity: number;
  weightedImpact: number;
  bullishRatio: number;
  hasNews: boolean;
  posture: number | null;
}

interface BarDatum {
  value: number;
  itemStyle: { color: string };
  _extra: RowExtra;
}

interface CapturedOption {
  xAxis: { min: number; max: number; name: string };
  yAxis: { data: string[] };
  tooltip: { formatter: (p: { data: { _extra: RowExtra } }) => string };
  series: Array<{
    data: BarDatum[];
    label: { formatter: (p: { data: { _extra: RowExtra } }) => string };
    markLine: { data: Array<{ xAxis: number }>; label: { formatter: string } };
  }>;
}

function signal(over: Partial<NewsSignal> = {}): NewsSignal {
  return {
    polarity: 0.42,
    sentimentZ: 1.2,
    bullishRatio: 0.7,
    newsCount: 5,
    freshness: 0.9,
    weightedImpact: 0.5,
    items: [],
    hasNews: true,
    ...over,
  };
}

function row(over: Partial<WatchlistNewsBacktestRow> = {}): WatchlistNewsBacktestRow {
  return {
    code: '600519',
    name: '贵州茅台',
    newsSentiment: signal(),
    strategyList: [],
    simulatedKline: false,
    ...over,
  };
}

function report(results: WatchlistNewsBacktestRow[]): WatchlistNewsBacktestReport {
  return {
    generatedAt: '2026-09-15T10:00:00.000Z',
    count: results.length,
    withNewsCount: results.filter((r) => r.newsSentiment?.hasNews).length,
    results,
  };
}

let chart: {
  setOption: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getZr: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  chart = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    on: vi.fn(),
    getZr: vi.fn(() => ({ on: vi.fn() })),
  };
  echartsMock.init.mockReset();
  echartsMock.init.mockReturnValue(chart);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 组件交给 EChart 的 option（EChart 挂在首个 setOption 调用上） */
function captured(): CapturedOption {
  expect(chart.setOption).toHaveBeenCalledTimes(1);
  return chart.setOption.mock.calls[0][0] as CapturedOption;
}

/** EChart 渲染出来的容器：唯一一个带内联 height 的 div */
function chartBox(container: HTMLElement): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
    (d) => d.style.height !== '',
  );
  return el as HTMLElement;
}

describe('NewsPostureHeatBar —— 空态', () => {
  it('report 为 null 时不渲染任何内容', () => {
    const { container } = render(<NewsPostureHeatBar report={null} />);

    expect(container).toBeEmptyDOMElement();
    expect(echartsMock.init).not.toHaveBeenCalled();
  });

  it('results 为空数组时同样不渲染', () => {
    const { container } = render(<NewsPostureHeatBar report={report([])} />);

    expect(container).toBeEmptyDOMElement();
    expect(echartsMock.init).not.toHaveBeenCalled();
  });
});

describe('NewsPostureHeatBar —— 标题与图例', () => {
  it('渲染标题与三色图例文案（偏多红 / 偏空绿 / 无消息灰）及读图提示', () => {
    const { container } = render(<NewsPostureHeatBar report={report([row()])} />);

    const box = container.querySelector('.watchlist-heatbar') as HTMLElement;
    expect(box.querySelector('.section-title')).toHaveTextContent(
      '新闻姿态热力条（自选股批量回测总览）',
    );

    const legend = box.querySelector('.watchlist-heatbar-legend') as HTMLElement;
    expect(legend.textContent).toContain('偏多（红）');
    expect(legend.textContent).toContain('偏空（绿）');
    expect(legend.textContent).toContain('无最新消息（灰）');
    expect(legend.querySelector('.hb-hint')).toHaveTextContent(
      '颜色越深＝新闻影响越强；条长按极性，右多左空',
    );
    expect(legend.querySelectorAll('.hb-dot')).toHaveLength(3);
    expect(legend.querySelector('.hb-bull')).not.toBeNull();
    expect(legend.querySelector('.hb-bear')).not.toBeNull();
    expect(legend.querySelector('.hb-neutral')).not.toBeNull();
  });

  it('图表容器高度按行数增长，并夹在 240~560 之间', () => {
    const one = render(<NewsPostureHeatBar report={report([row()])} />);
    expect(chartBox(one.container).style.height).toBe('240px'); // 1*38+56=94 → 下限 240

    const ten = render(
      <NewsPostureHeatBar
        report={report(Array.from({ length: 10 }, (_, i) => row({ code: `00000${i}` })))}
      />,
    );
    expect(chartBox(ten.container).style.height).toBe('436px'); // 10*38+56=436

    const many = render(
      <NewsPostureHeatBar
        report={report(Array.from({ length: 20 }, (_, i) => row({ code: `0000${i}` })))}
      />,
    );
    expect(chartBox(many.container).style.height).toBe('560px'); // 20*38+56=816 → 上限 560
  });
});

describe('NewsPostureHeatBar —— 排序与标签', () => {
  it('按极性降序排列：看多在前、看空在后', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '000001', name: null, newsSentiment: signal({ polarity: -0.3 }) }),
          row({ code: '600519', name: '贵州茅台', newsSentiment: signal({ polarity: 0.42 }) }),
          row({ code: '000858', name: '五粮液', newsSentiment: signal({ polarity: 0.1 }) }),
        ])}
      />,
    );

    expect(captured().yAxis.data).toEqual(['600519 贵州茅台', '000858 五粮液', '000001']);
  });

  it('无新闻的股票极性记 0，只排在看空（负极性）之前——并非「自然排末尾」', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '600519', name: '贵州茅台', newsSentiment: signal({ polarity: 0.5 }) }),
          row({ code: '000001', name: '平安银行', newsSentiment: null }),
          row({ code: '000858', name: '五粮液', newsSentiment: signal({ polarity: -0.2 }) }),
        ])}
      />,
    );

    // 源码注释称「无新闻(极性0)自然排末尾」，但排序键就是极性本身：
    // 存在看空行时，0 会插在看空行之前。
    expect(captured().yAxis.data).toEqual(['600519 贵州茅台', '000001 平安银行', '000858 五粮液']);
    expect(captured().series[0].data.map((d) => d.value)).toEqual([0.5, 0, -0.2]);
  });

  it('全部为非负极性时，无新闻的行才落到底部', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '000001', name: '平安银行', newsSentiment: null }),
          row({ code: '600519', name: '贵州茅台', newsSentiment: signal({ polarity: 0.5 }) }),
          row({ code: '000858', name: '五粮液', newsSentiment: signal({ polarity: 0 }) }),
        ])}
      />,
    );

    // 三条极性 0/0.5/0：稳定排序 → 0.5 在最前，两个 0 保持入参顺序
    expect(captured().yAxis.data).toEqual(['600519 贵州茅台', '000001 平安银行', '000858 五粮液']);
  });

  it('条长取极性并保留三位小数', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '600519', newsSentiment: signal({ polarity: 0.4267 }) }),
          row({ code: '000858', newsSentiment: signal({ polarity: -0.1234 }) }),
        ])}
      />,
    );

    expect(captured().series[0].data.map((d) => d.value)).toEqual([0.427, -0.123]);
  });

  it('数据条右侧标签显示两位小数极性', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '600519', newsSentiment: signal({ polarity: 0.4267 }) }),
          row({ code: '000858', newsSentiment: signal({ polarity: -0.3 }) }),
        ])}
      />,
    );

    const formatter = captured().series[0].label.formatter;
    const bars = captured().series[0].data;
    expect(formatter({ data: bars[0] })).toBe('0.43');
    expect(formatter({ data: bars[1] })).toBe('-0.30');
  });
});

describe('NewsPostureHeatBar —— 配色语义', () => {
  it('看多为红：影响强度 0.5 → rgba(239,68,68,0.700)', () => {
    render(
      <NewsPostureHeatBar
        report={report([row({ newsSentiment: signal({ polarity: 0.4, weightedImpact: 0.5 }) })])}
      />,
    );

    expect(captured().series[0].data[0].itemStyle.color).toBe('rgba(239,68,68,0.700)');
  });

  it('看空为绿：极性为负时用绿色系', () => {
    render(
      <NewsPostureHeatBar
        report={report([row({ newsSentiment: signal({ polarity: -0.4, weightedImpact: 0.5 }) })])}
      />,
    );

    expect(captured().series[0].data[0].itemStyle.color).toBe('rgba(34,197,94,0.700)');
  });

  it('无最新消息为灰（固定 0.45 透明度，不受影响强度影响）', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '000001', newsSentiment: null }),
          row({
            code: '000858',
            newsSentiment: signal({ hasNews: false, weightedImpact: 0.9 }),
          }),
        ])}
      />,
    );

    const colors = captured().series[0].data.map((d) => d.itemStyle.color);
    expect(colors).toEqual(['rgba(100,116,139,0.45)', 'rgba(100,116,139,0.45)']);
  });

  it('影响强度决定深浅：0 → 0.400，1 → 1.000，越界 1.5 被钳到 1', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '600519', newsSentiment: signal({ polarity: 0.4, weightedImpact: 0 }) }),
          row({ code: '000858', newsSentiment: signal({ polarity: 0.4, weightedImpact: 1 }) }),
          row({ code: '000001', newsSentiment: signal({ polarity: 0.4, weightedImpact: 1.5 }) }),
        ])}
      />,
    );

    // 三行极性相同 → 排序稳定，保持入参顺序
    expect(captured().series[0].data.map((d) => d.itemStyle.color)).toEqual([
      'rgba(239,68,68,0.400)',
      'rgba(239,68,68,1.000)',
      'rgba(239,68,68,1.000)',
    ]);
  });

  it('有新闻但极性为 0 时被判成看空的绿色（现状：仅按 polarity > 0 分色）', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({ code: '600519', newsSentiment: signal({ polarity: 0, weightedImpact: 0.5 }) }),
        ])}
      />,
    );

    const datum = captured().series[0].data[0];
    expect(datum._extra.hasNews).toBe(true);
    expect(datum.value).toBe(0);
    expect(datum.itemStyle.color).toBe('rgba(34,197,94,0.700)');
  });

  it('hasNews=false 时即便带了极性数值也按「无消息」处理（极性归 0、走灰色）', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({
            code: '600519',
            newsSentiment: signal({ hasNews: false, polarity: 0.8, weightedImpact: 0.8 }),
          }),
        ])}
      />,
    );

    const datum = captured().series[0].data[0];
    expect(datum.value).toBe(0);
    expect(datum._extra.polarity).toBe(0);
    expect(datum.itemStyle.color).toBe('rgba(100,116,139,0.45)');
  });
});

describe('NewsPostureHeatBar —— tooltip 文案', () => {
  it('有新闻且带姿态时列出极性、影响强度、看多占比与新闻姿态', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({
            code: '600519',
            name: '贵州茅台',
            newsSentiment: signal({ polarity: 0.42, weightedImpact: 0.5, bullishRatio: 0.7 }),
            bestStrategy: {
              strategyType: 'ma_cross',
              totalReturn: 12,
              sharpeRatio: 1.2,
              maxDrawdown: 8,
              winRate: 55,
              newsAware: {
                totalReturn: 14,
                sharpeRatio: 1.4,
                maxDrawdown: 7,
                winRate: 58,
                posture: 0.62,
              },
            },
          }),
        ])}
      />,
    );

    const datum = captured().series[0].data[0];
    expect(captured().tooltip.formatter({ data: datum })).toBe(
      '<b>600519</b> 贵州茅台<br/>新闻极性：0.42<br/>影响强度：50%<br/>看多占比：70%<br/>新闻姿态：62%',
    );
  });

  it('没有 newsAware.posture 时新闻姿态显示破折号', () => {
    render(<NewsPostureHeatBar report={report([row({ code: '600519', name: '贵州茅台' })])} />);

    const datum = captured().series[0].data[0];
    expect(captured().tooltip.formatter({ data: datum })).toBe(
      '<b>600519</b> 贵州茅台<br/>新闻极性：0.42<br/>影响强度：50%<br/>看多占比：70%<br/>新闻姿态：—',
    );
  });

  it('无新闻时只给代码/名称与「无最新消息」', () => {
    render(
      <NewsPostureHeatBar
        report={report([row({ code: '600519', name: '贵州茅台', newsSentiment: null })])}
      />,
    );

    const datum = captured().series[0].data[0];
    expect(captured().tooltip.formatter({ data: datum })).toBe(
      '<b>600519</b> 贵州茅台<br/>无最新消息',
    );
  });

  it('名称为空（name 为 null）时 tooltip 与行标签都只用代码', () => {
    render(
      <NewsPostureHeatBar
        report={report([row({ code: '000001', name: null, newsSentiment: null })])}
      />,
    );

    const datum = captured().series[0].data[0];
    expect(datum._extra.label).toBe('000001');
    expect(captured().tooltip.formatter({ data: datum })).toBe('<b>000001</b> <br/>无最新消息');
  });

  it('有新闻但 name 为 null 时，tooltip 仍只给代码再换行列明细', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({
            code: '000001',
            name: null,
            newsSentiment: signal({ polarity: 0.42, weightedImpact: 0.5, bullishRatio: 0.7 }),
          }),
        ])}
      />,
    );

    const datum = captured().series[0].data[0];
    expect(datum._extra.label).toBe('000001');
    expect(captured().tooltip.formatter({ data: datum })).toBe(
      '<b>000001</b> <br/>新闻极性：0.42<br/>影响强度：50%<br/>看多占比：70%<br/>新闻姿态：—',
    );
  });

  it('姿态为 0 时显示 0% 而不是破折号', () => {
    render(
      <NewsPostureHeatBar
        report={report([
          row({
            bestStrategy: {
              strategyType: 'ma_cross',
              totalReturn: 1,
              sharpeRatio: 0.2,
              maxDrawdown: 30,
              winRate: 40,
              newsAware: {
                totalReturn: 0,
                sharpeRatio: 0,
                maxDrawdown: 30,
                winRate: 40,
                posture: 0,
              },
            },
          }),
        ])}
      />,
    );

    const datum = captured().series[0].data[0];
    expect(captured().tooltip.formatter({ data: datum })).toContain('新闻姿态：0%');
  });
});

describe('NewsPostureHeatBar —— 坐标轴与中性参考线', () => {
  it('X 轴固定 -1~1 且名为「新闻极性」', () => {
    render(<NewsPostureHeatBar report={report([row()])} />);

    expect(captured().xAxis.min).toBe(-1);
    expect(captured().xAxis.max).toBe(1);
    expect(captured().xAxis.name).toBe('新闻极性');
  });

  it('在中性位置画 x=0 的参考线并标注「中性」', () => {
    render(<NewsPostureHeatBar report={report([row()])} />);

    const markLine = captured().series[0].markLine;
    expect(markLine.data).toEqual([{ xAxis: 0 }]);
    expect(markLine.label.formatter).toBe('中性');
  });

  it('热力条没有读屏替代文本（EChart 未传 ariaLabel → 不生成 role=img）', () => {
    const { container } = render(<NewsPostureHeatBar report={report([row()])} />);

    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});
