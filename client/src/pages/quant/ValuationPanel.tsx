/**
 * 估值建模面板：两阶段 EPS 贴现 DCF + 可比公司表。
 * 假设可缺省（自动从年报 EPS 推导），也可显式覆盖；局限声明照实展示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { runValuationModelApi, type ValuationModelResult } from '../../api/client';

function fmt(v: number | null | undefined, suffix = ''): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)}${suffix}` : '—';
}

function SensitivityTable({ r }: { r: NonNullable<ValuationModelResult['sensitivity']> }) {
  return (
    <div className="watchlist-table-wrap">
      <table className="watchlist-table">
        <thead>
          <tr>
            <th>公允价值（元）</th>
            {r.growthRates1.map((g) => (
              <th key={g}>{(g * 100).toFixed(1)}%</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.discountRates.map((rate, i) => (
            <tr key={rate}>
              <td className="mono">r = {(rate * 100).toFixed(1)}%</td>
              {r.matrix[i].map((v, j) => (
                <td key={j} className={Number.isFinite(v) ? 'mono' : 'mono ds-coverage'}>
                  {Number.isFinite(v) ? v.toFixed(2) : '发散'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ValuationPanel() {
  const [code, setCode] = useState('');
  const [growthRate1, setGrowthRate1] = useState('');
  const [discountRate, setDiscountRate] = useState('');
  const [growthRate2, setGrowthRate2] = useState('');
  const [result, setResult] = useState<ValuationModelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const handleRun = useCallback(async () => {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      setError('请输入 6 位股票代码');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const assumptions: Record<string, number> = {};
      for (const [key, raw] of [
        ['growthRate1', growthRate1],
        ['discountRate', discountRate],
        ['growthRate2', growthRate2],
      ] as const) {
        const v = Number(raw.trim());
        if (raw.trim() !== '' && Number.isFinite(v)) assumptions[key] = v;
      }
      const r = await runValuationModelApi({
        code: c,
        ...(Object.keys(assumptions).length > 0 ? { assumptions } : {}),
      });
      if (!aliveRef.current) return;
      setResult(r);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : '估值建模失败');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [code, growthRate1, discountRate, growthRate2]);

  const dcf = result?.dcf ?? null;
  const upside = result?.upsidePct ?? null;

  return (
    <div className="card quant-panel valuation-panel">
      <h3 className="quant-panel-title">估值建模（两阶段 EPS 贴现 + 可比公司表）</h3>
      <p className="batch-hint">
        假设留空时自动推导：基期 EPS 取最新年报，显性期增速取 EPS 3 年复合（钳制 [-20%,
        30%]），折现率 9%、永续 3%、显性期 5 年。模型为 EPS 贴现近似，局限随结果展示。
      </p>
      <div className="valuation-form">
        <input
          className="batch-input"
          placeholder="股票代码（6 位）"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={6}
        />
        <input
          className="batch-input"
          placeholder="显性期增速（如 0.12，留空自动）"
          value={growthRate1}
          onChange={(e) => setGrowthRate1(e.target.value)}
        />
        <input
          className="batch-input"
          placeholder="折现率（如 0.09，留空 9%）"
          value={discountRate}
          onChange={(e) => setDiscountRate(e.target.value)}
        />
        <input
          className="batch-input"
          placeholder="永续增速（如 0.03，留空 3%）"
          value={growthRate2}
          onChange={(e) => setGrowthRate2(e.target.value)}
        />
        <button type="button" className="btn-primary" onClick={handleRun} disabled={loading}>
          {loading ? '计算中…' : '开始建模'}
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div className="valuation-result">
          <div className="valuation-summary">
            <div className="paper-stat-card">
              <div className="paper-stat-label">每股内在价值</div>
              <div className="paper-stat-value">{fmt(result.fairValue, ' 元')}</div>
            </div>
            <div className="paper-stat-card">
              <div className="paper-stat-label">现价</div>
              <div className="paper-stat-value">{fmt(result.currentPrice, ' 元')}</div>
            </div>
            <div className="paper-stat-card">
              <div className="paper-stat-label">现价隐含溢价（正=高估）</div>
              <div className={`paper-stat-value ${upside !== null && upside > 0 ? 'neg' : 'pos'}`}>
                {upside !== null ? `${upside.toFixed(1)}%` : '—'}
              </div>
            </div>
            <div className="paper-stat-card">
              <div className="paper-stat-label">假设</div>
              <div className="paper-stat-value valuation-assumptions">
                g1 {(result.assumptions.growthRate1 * 100).toFixed(1)}%
                {result.assumptions.growthRate1Source === 'eps_cagr_3y' ? '（推导）' : ''} · r{' '}
                {(result.assumptions.discountRate * 100).toFixed(1)}% · g2{' '}
                {(result.assumptions.growthRate2 * 100).toFixed(1)}% ·{' '}
                {result.assumptions.explicitYears} 年
              </div>
            </div>
          </div>

          {dcf && (
            <div className="watchlist-table-wrap" style={{ marginTop: 10 }}>
              <table className="watchlist-table">
                <thead>
                  <tr>
                    <th>年份</th>
                    {dcf.cashFlows.map((c) => (
                      <th key={c.year}>第 {c.year} 年</th>
                    ))}
                    <th>终值现值</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="mono">EPS</td>
                    {dcf.cashFlows.map((c) => (
                      <td key={c.year} className="mono">
                        {c.eps.toFixed(3)}
                      </td>
                    ))}
                    <td className="mono">—</td>
                  </tr>
                  <tr>
                    <td className="mono">现值</td>
                    {dcf.cashFlows.map((c) => (
                      <td key={c.year} className="mono">
                        {c.presentValue.toFixed(2)}
                      </td>
                    ))}
                    <td className="mono">{dcf.discountedTerminalValue.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {result.sensitivity && <SensitivityTable r={result.sensitivity} />}

          <div className="watchlist-table-wrap" style={{ marginTop: 10 }}>
            <table className="watchlist-table">
              <thead>
                <tr>
                  <th>可比样本</th>
                  <th>PE 中位数</th>
                  <th>PB 中位数</th>
                  <th>本股 PE 折溢价</th>
                  <th>中位 PE 隐含价值</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{result.comparables.sampleSize} 家</td>
                  <td className="mono">{fmt(result.comparables.medianPe)}</td>
                  <td className="mono">{fmt(result.comparables.medianPb)}</td>
                  <td className="mono">
                    {result.comparables.pePremiumPct !== null
                      ? `${(result.comparables.pePremiumPct * 100).toFixed(1)}%`
                      : '—'}
                  </td>
                  <td className="mono">{fmt(result.comparables.impliedValueByMedianPe, ' 元')}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul className="digest-notes">
            {result.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
