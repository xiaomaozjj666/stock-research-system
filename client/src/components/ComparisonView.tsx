import { useEffect, useRef, useState } from 'react';
import { AnalysisCancelledError, compareStocks } from '../api/client';
import StockSearchInput from '../components/StockSearchInput';
import { ErrorBoundary } from './ErrorBoundary';

interface StockData {
  stock_code: string;
  stock_name: string;
  industry: string;
  core_summary: string;
  total_score: number;
  rating: string;
  finance_metrics: {
    years: string[];
    revenue: number[];
    netProfit: number[];
    grossMargin: number[];
    netMargin: number[];
    roe: number[];
  };
  valuation: {
    currentPrice: number;
    pe: number;
    pb: number;
    ps: number;
    marketCap: number;
  };
  expert_opinions: {
    expert: string;
    overallSentiment: 'bullish' | 'neutral' | 'bearish';
    confidence: number;
  }[];
  strengths: string[];
  risk_list: string[];
}

type FormatType = 'score' | 'price' | 'pe' | 'pb' | 'cap' | 'percent' | 'text' | 'sentiment';

/**
 * 单元格取值：`null` = 因失败而缺值（渲染为「—」）。
 * 与"字段合法地等于 0"严格区分——0 会被读成真实数值（如 PE=0），必须区别于缺值。
 */
type CellValue = number | string | null;

interface RowConfig {
  label: string;
  accessor: (s: StockData) => CellValue;
  format: FormatType;
  higherIsBetter?: boolean;
}

const COMPARISON_ROWS: RowConfig[] = [
  { label: '综合评分', accessor: (s) => s.total_score, format: 'score', higherIsBetter: true },
  { label: '评级', accessor: (s) => s.rating, format: 'text' },
  { label: '行业', accessor: (s) => s.industry, format: 'text' },
  {
    label: '当前价格',
    // 缺值返回 null（渲染「—」）而不是 ?? 0：0 会被误读为"价格 0 元"这样的真实数值。
    // 注意这里只影响"缺值"路径，数值存在时的格式化逻辑不变。
    accessor: (s) => s.valuation?.currentPrice ?? null,
    format: 'price',
    higherIsBetter: false,
  },
  {
    label: 'PE（市盈率）',
    accessor: (s) => s.valuation?.pe ?? null,
    format: 'pe',
    higherIsBetter: false,
  },
  {
    label: 'PB（市净率）',
    accessor: (s) => s.valuation?.pb ?? null,
    format: 'pb',
    higherIsBetter: false,
  },
  {
    label: '市值（亿）',
    accessor: (s) => s.valuation?.marketCap ?? null,
    format: 'cap',
    higherIsBetter: false,
  },
  {
    label: 'ROE（%）',
    accessor: (s) => {
      const roe = s.finance_metrics?.roe;
      return roe && roe.length > 0 ? roe[roe.length - 1] : null;
    },
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: '毛利率（%）',
    accessor: (s) => {
      const gm = s.finance_metrics?.grossMargin;
      return gm && gm.length > 0 ? gm[gm.length - 1] : null;
    },
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: '净利率（%）',
    accessor: (s) => {
      const nm = s.finance_metrics?.netMargin;
      return nm && nm.length > 0 ? nm[nm.length - 1] : null;
    },
    format: 'percent',
    higherIsBetter: true,
  },
  {
    label: '专家情绪',
    accessor: (s) => {
      const opinions = s.expert_opinions ?? [];
      if (opinions.length === 0) return null;
      const bullishCount = opinions.filter((o) => o.overallSentiment === 'bullish').length;
      const bearishCount = opinions.filter((o) => o.overallSentiment === 'bearish').length;
      if (bullishCount > bearishCount) return 'bullish';
      if (bearishCount > bullishCount) return 'bearish';
      return 'neutral';
    },
    format: 'sentiment',
    higherIsBetter: true,
  },
];

function formatValue(v: CellValue, format: FormatType): string {
  // 因失败而缺值：显示「—」。0 会被读成真实数值（如 PE 0 倍），必须与缺值区分开。
  if (v === null) return '—';
  if (format === 'text') return String(v);
  if (format === 'sentiment') {
    const map: Record<string, string> = { bullish: '偏多', neutral: '中性', bearish: '偏空' };
    return map[v as string] ?? '中性';
  }
  const num = Number(v);
  if (isNaN(num)) return '—';
  switch (format) {
    case 'price':
      return `¥${num.toFixed(2)}`;
    case 'pe':
    case 'pb':
      return num.toFixed(2);
    case 'cap':
      return num >= 10000 ? `${(num / 10000).toFixed(2)}万亿` : `${num.toFixed(0)}亿`;
    case 'percent':
      return `${num.toFixed(2)}%`;
    case 'score':
      return `${num.toFixed(0)}/100`;
    default:
      return String(num);
  }
}

function ComparisonRow({
  label,
  values,
  format,
  higherIsBetter,
}: {
  label: string;
  values: CellValue[];
  format: FormatType;
  higherIsBetter?: boolean;
}) {
  // null（因失败缺值）不参与数值比较：既不能出现在 max/min，也不能被标成最优/最差
  const numericValues = values.filter((v): v is number => typeof v === 'number');
  const positiveValues = numericValues.filter((v) => v > 0);
  const maxVal = positiveValues.length > 0 ? Math.max(...positiveValues) : 0;
  const minVal = positiveValues.length > 0 ? Math.min(...positiveValues) : 0;

  const getCellClass = (v: CellValue) => {
    if (format === 'text' || format === 'sentiment') return '';
    const num = typeof v === 'number' ? v : 0;
    if (num <= 0) return '';
    if (higherIsBetter) {
      if (num === maxVal) return 'cell-best';
      if (num === minVal && maxVal !== minVal) return 'cell-worst';
    } else {
      if (num === minVal) return 'cell-best';
      if (num === maxVal && maxVal !== minVal) return 'cell-worst';
    }
    return '';
  };

  return (
    <tr>
      <td className="cmp-label">{label}</td>
      {values.map((v, i) => (
        <td key={i} className={`cmp-cell ${getCellClass(v)}`}>
          {format === 'sentiment' && v !== null && v !== '' ? (
            <span className={`sentiment-tag sentiment-${v}`}>{formatValue(v, format)}</span>
          ) : (
            formatValue(v, format)
          )}
        </td>
      ))}
    </tr>
  );
}

/** 把失败列表拼成一句可读中文（单只直接给原因，多只带代码前缀） */
function describeFailures(failures?: { code: string; error: string }[]): string {
  if (!failures || failures.length === 0) return '';
  if (failures.length === 1) return failures[0].error;
  return `部分股票分析失败：${failures.map((f) => `${f.code}（${f.error}）`).join('；')}`;
}

/** 两列全失败时「重试这一只」不可用的原因（按钮禁用 + 就地写明，不留死按钮） */
const RETRY_NEEDS_PARTNER_HINT =
  '需至少一只成功结果才能重试：单只重试要带一只已成功的股票凑够接口要求的 2 只。';

/**
 * 单列视图模型：一列对应请求里的一只股票，成功则带结果、失败则带可读原因。
 * 服务端只回成功项的 stocks（顺序与请求一致），这里按 code 与请求合并回原顺序，
 * 失败的列因此能留在它原来的位置，而不是被挤到末尾。
 */
interface CompareColumnSuccess {
  code: string;
  name: string;
  result: StockData;
  error?: undefined;
}
interface CompareColumnFailure {
  code: string;
  name: string;
  error: string;
  result?: undefined;
}
type CompareColumn = CompareColumnSuccess | CompareColumnFailure;

export function ComparisonView() {
  const [stocks, setStocks] = useState<string[]>([]);
  const [stockNames, setStockNames] = useState<Record<string, string>>({});
  const [results, setResults] = useState<CompareColumn[] | null>(null);
  const [loading, setLoading] = useState(false);
  /** 已耗时（秒）：多股对比是 1~3 分钟的纯 POST，只有静态"分析中"无法判断是否卡住 */
  const [elapsedSec, setElapsedSec] = useState(0);
  /** 单只重试中的股票代码：用于禁用该列的重试按钮，避免重复发起分钟级分析 */
  const [retryingCode, setRetryingCode] = useState<string | null>(null);
  const startAtRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 在途对比请求的中止器：三只股的完整分析约 1-3 分钟，用户应能中途撤回 */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // 对比期间真实计时（与量化面板的"已耗时"同写法）
  useEffect(() => {
    if (!loading) {
      if (tickerRef.current) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
      return;
    }
    startAtRef.current = Date.now();
    setElapsedSec(0);
    tickerRef.current = setInterval(() => {
      setElapsedSec(Math.round((Date.now() - startAtRef.current) / 1000));
    }, 1000);
    return () => {
      if (tickerRef.current) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
    };
  }, [loading]);
  const [error, setError] = useState('');
  /** 搜索框所在行：空占位点击时直接聚焦输入框 */
  const searchRowRef = useRef<HTMLDivElement>(null);
  const focusSearch = () => {
    searchRowRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  };

  const addStock = (code: string, name?: string) => {
    const c = code.trim();
    if (!c) return;
    if (stocks.includes(c)) {
      setError('该股票已添加');
      return;
    }
    if (stocks.length >= 3) return;
    setStocks((prev) => [...prev, c]);
    setStockNames((prev) => ({ ...prev, [c]: name || prev[c] || c }));
    setError('');
  };

  const removeStock = (code: string) => {
    setStocks((prev) => prev.filter((s) => s !== code));
  };

  /**
   * 把服务端响应合并回"按请求顺序的列"。
   * 失败项按 code 就地替换为失败列；服务端没提到的代码（旧后端只回 stocks）保持原样，
   * 因此旧后端下行为与改动前一致。
   */
  const buildColumns = (
    codes: string[],
    data: { stocks?: StockData[]; failures?: { code: string; error: string }[] },
    names: Record<string, string>,
  ): CompareColumn[] => {
    const byCode = new Map<string, StockData>();
    for (const s of data.stocks ?? []) {
      if (s && typeof s.stock_code === 'string') byCode.set(s.stock_code, s);
    }
    // failures 可能一词多报（理论上不会，但按最后一次为准，避免同列渲染两条原因）
    const errorByCode = new Map<string, string>();
    for (const f of data.failures ?? []) {
      if (f && typeof f.code === 'string') errorByCode.set(f.code, String(f.error ?? '分析失败'));
    }

    const columns: CompareColumn[] = [];
    for (const code of codes) {
      const result = byCode.get(code);
      const error = errorByCode.get(code);
      const name = names[code] || code;
      if (result) columns.push({ code, name: result.stock_name || name, result });
      else if (error) columns.push({ code, name, error });
    }
    // 服务端多返回了请求里没有的代码（理论不会）：补在末尾，至少不丢数据
    for (const [code, result] of byCode) {
      if (!codes.includes(code)) columns.push({ code, name: result.stock_name || code, result });
    }
    return columns;
  };

  const startCompare = async () => {
    if (stocks.length < 2) return;
    setLoading(true);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await compareStocks(stocks, controller.signal);
      const columns = buildColumns(stocks, data, stockNames);
      // 一只都没成功：不进入结果视图（不显示空表格），走下方既有错误提示路径
      if (columns.length === 0) {
        setError(describeFailures(data.failures) || '对比分析失败');
        return;
      }
      setResults(columns);
      // 部分失败：结果照常展示，同时把失败原因一并提示（失败列内也会各自标注）
      if (data.failures && data.failures.length > 0) setError(describeFailures(data.failures));
    } catch (e: unknown) {
      // 取消属用户主动行为：静默收尾（spinner 消失即反馈），不当失败渲染
      if (!(e instanceof AnalysisCancelledError)) {
        setError(e instanceof Error ? e.message : '对比分析失败');
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  };

  /**
   * 单只重试：接口要求一次 2-3 只（保留既有 400 校验，不改服务端契约），
   * 故带上同批一只**已成功**的股票凑数——它在服务端分析去重（inFlightAnalyses 见
   * analysisPipeline.runAnalysis）下不会重跑，等于只重试失败的那一只。
   *
   * 两列全失败时**没有任何可用伙伴**：此时按钮禁用并写明原因（见渲染处），
   * 不再像以前那样静默 return——点了没反应比按钮禁用更糟。
   * 重试同样是分钟级请求，接上与主对比一致的中止语义（abortRef + 卸载中止）。
   */
  const retryOne = async (code: string) => {
    if (!results || retryingCode) return;
    const partner = results.find(
      (c): c is CompareColumnSuccess => c.result !== undefined && c.code !== code,
    );
    if (!partner) return;
    setRetryingCode(code);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await compareStocks([code, partner.code], controller.signal);
      const retried = buildColumns([code, partner.code], data, stockNames)[0];
      if (retried && retried.result) {
        // 成功：就地替换该列（其余列与顺序不动）
        setResults((prev) => (prev ? prev.map((c) => (c.code === code ? retried : c)) : prev));
        setError('');
        return;
      }
      const reason =
        (retried && retried.error) || describeFailures(data.failures) || '仍未能完成分析';
      // 显式构造失败列：不能用 `{...c, error}` —— 当 c 是成功列（带 result）时，
      // 展开会得到同时含 result 与 error 的对象，不满足 CompareColumn 联合类型的判别式
      setResults((prev) =>
        prev
          ? prev.map((c) => (c.code === code ? { code: c.code, name: c.name, error: reason } : c))
          : prev,
      );
      setError(`「${stockNames[code] || code}」重试失败：${reason}`);
    } catch (e: unknown) {
      if (!(e instanceof AnalysisCancelledError)) {
        setError(e instanceof Error ? e.message : '重试失败');
      }
    } finally {
      // 只有本次重试仍是在途请求时才清空中止器，避免踩掉后来者的 controller
      if (abortRef.current === controller) abortRef.current = null;
      setRetryingCode(null);
    }
  };

  const cancelCompare = () => {
    abortRef.current?.abort();
  };

  const reset = () => {
    setResults(null);
    setStocks([]);
    setStockNames({});
    setError('');
    setRetryingCode(null);
  };

  if (results) {
    return (
      <ErrorBoundary>
        <div className="comparison-view">
          <div className="comparison-header">
            <h2 className="comparison-title">股票对比分析</h2>
            <button className="btn-back" onClick={reset}>
              重新对比
            </button>
          </div>

          {error && <div className="comparison-error">{error}</div>}

          <div className="comparison-table-wrap">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>对比指标</th>
                  {results.map((col) => {
                    if (col.result) {
                      return (
                        <th key={col.code} className="cmp-stock-header">
                          <div className="cmp-stock-name">{col.result.stock_name}</div>
                          <div className="cmp-stock-code">{col.result.stock_code}</div>
                        </th>
                      );
                    }
                    // 重试要凑一只已成功的伙伴；全失败时无伙伴可凑 → 禁用并写明原因，
                    // 而不是留一个点了没反应的死按钮
                    const hasPartner = results.some(
                      (c) => c.result !== undefined && c.code !== col.code,
                    );
                    const retryHint = hasPartner ? undefined : RETRY_NEEDS_PARTNER_HINT;
                    return (
                      // 失败列：留在原位置（不挤到末尾），标注「分析失败」+ 可读原因 + 单只重试
                      <th key={col.code} className="cmp-stock-header cmp-stock-header-failed">
                        <div className="cmp-stock-name">{col.name}</div>
                        <div className="cmp-stock-code">{col.code}</div>
                        <div className="cmp-fail-badge">分析失败</div>
                        <div className="cmp-fail-reason">{col.error}</div>
                        {/* 重试是屏幕上的补救动作：印在纸上只会让人以为报告还能点，
                            且「重试这一只」对纸质读者毫无信息量 → .no-print */}
                        <button
                          type="button"
                          className="btn-ghost cmp-fail-retry no-print"
                          onClick={() => void retryOne(col.code)}
                          disabled={retryingCode !== null || loading || !hasPartner}
                          title={retryHint}
                          data-testid={`retry-${col.code}`}
                        >
                          {retryingCode === col.code ? '重试中...' : '重试这一只'}
                        </button>
                        {retryHint && <div className="cmp-fail-hint no-print">{retryHint}</div>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row) => (
                  <ComparisonRow
                    key={row.label}
                    label={row.label}
                    // 失败列直接给 null：单元格显示「—」，且不参与最优/最差比较
                    values={results.map((col) => (col.result ? row.accessor(col.result) : null))}
                    format={row.format}
                    higherIsBetter={row.higherIsBetter}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="comparison-summaries">
            {results.map((col) =>
              col.result ? (
                <div key={col.code} className="comparison-summary-card">
                  <div className="comparison-summary-header">
                    <span className="comparison-summary-name">{col.result.stock_name}</span>
                    <span className="comparison-summary-score">{col.result.total_score}分</span>
                  </div>
                  <p className="comparison-summary-text">{col.result.core_summary}</p>
                  <div className="comparison-summary-meta">
                    <div className="comparison-summary-strengths">
                      <span className="meta-label">核心优势</span>
                      <ul>
                        {(col.result.strengths ?? []).slice(0, 3).map((st, i) => (
                          <li key={i}>{st}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="comparison-summary-risks">
                      <span className="meta-label">主要风险</span>
                      <ul>
                        {(col.result.risk_list ?? []).slice(0, 3).map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : (
                <div key={col.code} className="comparison-summary-card comparison-summary-failed">
                  <div className="comparison-summary-header">
                    <span className="comparison-summary-name">{col.name}</span>
                    <span className="comparison-summary-score">{col.code}</span>
                  </div>
                  <p className="comparison-summary-text">
                    分析失败：{col.error}
                    <br />
                    该股未纳入本次对比，可用上方「重试这一只」单独重跑。
                  </p>
                </div>
              ),
            )}
          </div>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <div className="comparison-setup">
      <h2 className="comparison-setup-title">股票对比</h2>
      <p className="comparison-setup-desc">
        添加 2–3 只股票，一键生成财务、估值、趋势的多维度横向对比报告
      </p>

      <div className="comparison-input-row" ref={searchRowRef}>
        <StockSearchInput
          onSelect={(code, name) => addStock(code, name)}
          actionLabel="＋ 添加"
          disabled={stocks.length >= 3}
          placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
          ariaLabel="对比股票搜索"
        />
      </div>

      <div className="comparison-tags">
        {stocks.map((code, idx) => (
          <span key={code} className="comparison-tag">
            <span className="tag-index">{idx + 1}</span>
            <span className="tag-name">{stockNames[code] || code}</span>
            <span className="tag-code">{code}</span>
            <button className="tag-remove" onClick={() => removeStock(code)}>
              ×
            </button>
          </span>
        ))}
        {Array.from({ length: 3 - stocks.length }).map((_, i) => (
          <button
            key={`empty-${i}`}
            type="button"
            className="comparison-tag comparison-tag-empty comparison-tag-add"
            onClick={() => focusSearch()}
            disabled={stocks.length >= 3}
          >
            ＋ 添加第 {stocks.length + i + 1} 只
          </button>
        ))}
      </div>

      {error && <div className="comparison-error">{error}</div>}

      <button
        className="btn-compare"
        onClick={startCompare}
        disabled={stocks.length < 2 || loading}
      >
        {loading ? (
          <span className="btn-compare-loading">
            <span className="loading-dot" />
            分析中...
          </span>
        ) : stocks.length < 2 ? (
          '请至少添加 2 只股票'
        ) : (
          `开始对比分析（${stocks.length}/3）`
        )}
      </button>
      {loading && (
        <button type="button" className="btn-ghost" onClick={cancelCompare}>
          取消对比
        </button>
      )}
      {loading && (
        <p className="batch-loading">正在逐只分析财务、估值与专家观点…（已耗时 {elapsedSec} 秒）</p>
      )}
    </div>
  );
}

export default ComparisonView;
