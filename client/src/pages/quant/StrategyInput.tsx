import { useState, useMemo } from 'react';
import type { StrategyConfig } from './types';

interface Props {
  onSubmit: (config: StrategyConfig) => void;
  loading: boolean;
}

const STRATEGY_OPTIONS = [
  { value: 'ma_cross', label: '均线交叉' },
  { value: 'momentum', label: '动量策略' },
  { value: 'mean_reversion', label: '均值回归' },
] as const;

const PARAM_CONFIG: Record<
  string,
  { key: string; label: string; default: number; step?: number }[]
> = {
  ma_cross: [
    { key: 'shortPeriod', label: '短期均线天数', default: 5 },
    { key: 'longPeriod', label: '长期均线天数', default: 20 },
  ],
  momentum: [
    { key: 'lookback', label: '回看天数', default: 20 },
    { key: 'buyThreshold', label: '买入阈值 (%)', default: 5 },
    { key: 'sellThreshold', label: '卖出阈值 (%)', default: -3 },
  ],
  mean_reversion: [
    { key: 'maPeriod', label: '均线天数', default: 20 },
    { key: 'buyDeviation', label: '偏离买入阈值 (%)', default: -3 },
    { key: 'sellDeviation', label: '偏离卖出阈值 (%)', default: 3 },
  ],
};

function getDefaultEndDate(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function getDefaultStartDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

export default function StrategyInput({ onSubmit, loading }: Props) {
  const [strategyType, setStrategyType] = useState<'ma_cross' | 'momentum' | 'mean_reversion'>(
    'ma_cross',
  );
  const [stockCode, setStockCode] = useState('600519');
  const [startDate, setStartDate] = useState(getDefaultStartDate());
  const [endDate, setEndDate] = useState(getDefaultEndDate());
  const [initialCapital, setInitialCapital] = useState(1000000);
  const [commission, setCommission] = useState(0.0003);
  const [params, setParams] = useState<Record<string, number>>(() => {
    const defaults: Record<string, number> = {};
    for (const p of PARAM_CONFIG.ma_cross) defaults[p.key] = p.default;
    return defaults;
  });

  const paramFields = useMemo(() => PARAM_CONFIG[strategyType] ?? [], [strategyType]);

  const handleTypeChange = (type: 'ma_cross' | 'momentum' | 'mean_reversion') => {
    setStrategyType(type);
    const defaults: Record<string, number> = {};
    for (const p of PARAM_CONFIG[type] ?? []) defaults[p.key] = p.default;
    setParams(defaults);
  };

  const handleParamChange = (key: string, val: string) => {
    const num = parseFloat(val);
    if (!isNaN(num)) setParams((prev) => ({ ...prev, [key]: num }));
  };

  const strategyLabel = STRATEGY_OPTIONS.find((o) => o.value === strategyType)?.label ?? '';

  const handleSubmit = () => {
    onSubmit({
      name: `${strategyLabel}策略`,
      type: strategyType,
      stockCode: stockCode.trim(),
      params,
      startDate,
      endDate,
      initialCapital,
      commission,
    });
  };

  const isValid = stockCode.trim().length > 0 && startDate < endDate;

  return (
    <div className="quant-form">
      <div className="quant-form-group">
        <label>策略类型</label>
        <select
          value={strategyType}
          onChange={(e) => handleTypeChange(e.target.value as typeof strategyType)}
        >
          {STRATEGY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="quant-form-group">
        <label>股票代码</label>
        <input
          type="text"
          value={stockCode}
          onChange={(e) => setStockCode(e.target.value)}
          placeholder="如 600519"
        />
      </div>

      <div className="quant-form-group">
        <label>开始日期</label>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </div>

      <div className="quant-form-group">
        <label>结束日期</label>
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      </div>

      <div className="quant-form-divider" />

      {paramFields.map((field) => (
        <div className="quant-form-group" key={field.key}>
          <label>{field.label}</label>
          <input
            type="number"
            value={params[field.key] ?? field.default}
            step={field.step ?? 1}
            onChange={(e) => handleParamChange(field.key, e.target.value)}
          />
        </div>
      ))}

      <div className="quant-form-divider" />

      <div className="quant-form-group">
        <label>初始资金（元）</label>
        <input
          type="number"
          value={initialCapital}
          step={100000}
          onChange={(e) => setInitialCapital(parseFloat(e.target.value) || 0)}
        />
      </div>

      <div className="quant-form-group">
        <label>佣金率</label>
        <input
          type="number"
          value={commission}
          step={0.0001}
          onChange={(e) => setCommission(parseFloat(e.target.value) || 0)}
        />
      </div>

      <button
        className="btn-primary quant-start-btn"
        onClick={handleSubmit}
        disabled={loading || !isValid}
      >
        {loading ? '研究中...' : '开始研究'}
      </button>
    </div>
  );
}
