import type { AuditReport } from './types';

interface Props {
  data: AuditReport;
}

function riskChipCls(level: 'low' | 'medium' | 'high'): string {
  if (level === 'low') return 'chip chip-positive';
  if (level === 'medium') return 'chip chip-neutral';
  return 'chip chip-negative';
}

function riskLabel(level: 'low' | 'medium' | 'high'): string {
  if (level === 'low') return '低';
  if (level === 'medium') return '中';
  return '高';
}

function severityIcon(severity: 'info' | 'warning' | 'critical'): string {
  if (severity === 'critical') return '✕';
  if (severity === 'warning') return '⚠';
  return 'ℹ';
}

function severityColor(severity: 'info' | 'warning' | 'critical'): string {
  if (severity === 'critical') return 'var(--color-negative)';
  if (severity === 'warning') return 'var(--color-warning)';
  return 'var(--color-info)';
}

export default function AuditPanel({ data }: Props) {
  return (
    <div className="card quant-panel">
      <h3 className="quant-panel-title">回测审计报告</h3>

      <div className="quant-audit-score-block">
        <div className="quant-audit-score">
          {data.riskScore}
          <span className="quant-audit-max">/100</span>
        </div>
        <div className="quant-audit-label">风险评分</div>
      </div>

      <div className="quant-audit-risks">
        <div className="quant-audit-risk-item">
          <span className="quant-audit-risk-label">未来函数</span>
          <span className={riskChipCls(data.futureFunctionRisk)}>
            {riskLabel(data.futureFunctionRisk)}
          </span>
        </div>
        <div className="quant-audit-risk-item">
          <span className="quant-audit-risk-label">过拟合</span>
          <span className={riskChipCls(data.overfittingRisk)}>
            {riskLabel(data.overfittingRisk)}
          </span>
        </div>
        <div className="quant-audit-risk-item">
          <span className="quant-audit-risk-label">幸存者偏差</span>
          <span className={riskChipCls(data.survivorshipBias)}>
            {riskLabel(data.survivorshipBias)}
          </span>
        </div>
      </div>

      {data.checks.length > 0 && (
        <div className="quant-audit-checks">
          <h4 className="quant-subtitle">检查项</h4>
          <ul className="quant-check-list">
            {data.checks.map((check, i) => (
              <li key={i} className="quant-check-item">
                <span
                  className="quant-check-icon"
                  style={{
                    color: check.passed ? 'var(--color-positive)' : severityColor(check.severity),
                  }}
                >
                  {check.passed ? '✓' : severityIcon(check.severity)}
                </span>
                <div className="quant-check-body">
                  <span className="quant-check-name">{check.name}</span>
                  <span className="quant-check-detail">{check.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.reliability && (
        <div className="quant-audit-reliability">
          <h4 className="quant-subtitle">可靠性评估</h4>
          <p>{data.reliability}</p>
        </div>
      )}
    </div>
  );
}
