import { useState, useEffect, useRef, useCallback } from 'react';
import { searchStocks } from '../api/client';

interface StockSearchInputProps {
  /** 选中（或解析）出一支股票时回调，传入代码与名称 */
  onSelect: (code: string, name: string) => void;
  placeholder?: string;
  /** 显式操作按钮文案；不传则不渲染按钮（由页面自行触发，如 Enter 仍可选中） */
  actionLabel?: string;
  disabled?: boolean;
  /** 最多展示的候选数量 */
  limit?: number;
  /** 搜索无结果且输入为合法 6 位代码时，是否允许直接按代码添加（离线也能用） */
  allowDirectCode?: boolean;
  inputClassName?: string;
  actionClassName?: string;
  ariaLabel?: string;
}

const CODE_RE = /^\d{6}$/;

/**
 * 股票搜索自动补全输入框：输入「代码」或「名称」都能解析出标的。
 *
 * - 输入即防抖查询 /api/stocks/search（东方财富 suggest，支持代码与名称）。
 * - 下拉展示候选（代码 + 名称），点击或回车即选中。
 * - 名称有歧义（多支匹配）时提示在下拉中选择，不直接臆测。
 * - 搜索服务不可用时，6 位代码仍可直接添加，保证离线可用。
 */
export default function StockSearchInput({
  onSelect,
  placeholder = '输入股票代码或名称，如 600519 / 贵州茅台',
  actionLabel,
  disabled = false,
  limit = 8,
  allowDirectCode = true,
  inputClassName = '',
  actionClassName = 'btn-primary',
  ariaLabel = '股票搜索',
}: StockSearchInputProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ code: string; name: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [hint, setHint] = useState('');

  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 请求序号：只接受最新一次请求，防止乱序响应覆盖 */
  const seqRef = useRef(0);

  // 点击外部关闭下拉
  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, []);

  // 卸载时清理防抖定时器
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const runSearch = useCallback(
    async (kw: string) => {
      const mySeq = ++seqRef.current;
      setSearching(true);
      setHint('');
      try {
        const list = await searchStocks(kw);
        if (mySeq !== seqRef.current) return;
        const cleaned = (Array.isArray(list) ? list : []).slice(0, limit);
        setResults(cleaned);
        setShowDropdown(true);
        setActiveIndex(-1);
        if (cleaned.length === 0) {
          setHint(`未找到「${kw}」对应的股票，请确认名称或改用 6 位代码`);
        }
      } catch {
        if (mySeq !== seqRef.current) return;
        // 搜索失败：6 位代码仍可直加，名称则提示改用代码。
        // 注意：下拉必须保持可见，否则「暂不可用」提示会被一并隐藏（非 6 位代码路径）。
        setResults([]);
        setShowDropdown(true);
        if (!CODE_RE.test(kw)) setHint('搜索服务暂不可用，请改用 6 位股票代码');
      } finally {
        if (mySeq === seqRef.current) setSearching(false);
      }
    },
    [limit],
  );

  const handleChange = (value: string) => {
    setQuery(value);
    setHint('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = value.trim();
    if (!trimmed) {
      seqRef.current++; // 作废在途请求
      setSearching(false);
      setResults([]);
      setShowDropdown(false);
      setActiveIndex(-1);
      return;
    }
    setShowDropdown(true);
    setSearching(true);
    debounceRef.current = setTimeout(() => runSearch(trimmed), 250);
  };

  /** 真正把一支股票交出去：清空内部状态并回调 */
  const commit = useCallback(
    (code: string, name: string) => {
      seqRef.current++; // 作废在途请求，避免选中后又被结果覆盖
      setQuery('');
      setResults([]);
      setShowDropdown(false);
      setActiveIndex(-1);
      setSearching(false);
      setHint('');
      onSelect(code, name);
    },
    [onSelect],
  );

  /** 解析当前输入：优先下拉高亮项 → 6 位代码直加 → 名称查询（唯一命中直加，多命中提示） */
  const resolveCommit = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    if (activeIndex >= 0 && results[activeIndex]) {
      const s = results[activeIndex];
      commit(s.code, s.name);
      return;
    }
    if (results.length === 1) {
      commit(results[0].code, results[0].name);
      return;
    }
    if (results.length > 1) {
      // 与异步提交路径一致：多命中不臆测第一个（本组件用于自选股/模拟盘等资金类操作）
      setShowDropdown(true);
      setActiveIndex(-1);
      setHint(`「${trimmed}」匹配到多支股票，请在下拉中选择`);
      return;
    }
    if (CODE_RE.test(trimmed)) {
      if (allowDirectCode) commit(trimmed, '');
      return;
    }
    // 名称查询：触发一次搜索再决定
    const mySeq = ++seqRef.current;
    setSearching(true);
    searchStocks(trimmed)
      .then((list) => {
        if (mySeq !== seqRef.current) return;
        const cleaned = (Array.isArray(list) ? list : []).slice(0, limit);
        if (cleaned.length === 1) {
          commit(cleaned[0].code, cleaned[0].name);
        } else if (cleaned.length === 0) {
          setResults([]);
          setShowDropdown(true);
          setHint(`未找到「${trimmed}」对应的股票，请确认名称或改用 6 位代码`);
        } else {
          setResults(cleaned);
          setShowDropdown(true);
          setActiveIndex(-1);
          setHint(`「${trimmed}」匹配到多支股票，请在下拉中选择`);
        }
      })
      .catch(() => {
        if (mySeq !== seqRef.current) return;
        setShowDropdown(true);
        setHint('搜索服务暂不可用，请改用 6 位股票代码');
      })
      .finally(() => {
        if (mySeq === seqRef.current) setSearching(false);
      });
  }, [query, activeIndex, results, limit, allowDirectCode, commit]);

  /**
   * 失焦自动提交：用户输入完整 6 位代码（或查询仅一个命中）后直接去点表单按钮，
   * 不应因「没回车/没点下拉」而丢掉显示中的选择——此前模拟盘下单会报
   * 「股票代码需为 6 位数字」，即显示与状态脱节。
   * 下拉选项用 onMouseDown 提交（先于 blur 触发），不会与本逻辑双触发；
   * 多命中不臆测（维持「请在下拉中选择」），空输入不提交。
   */
  const handleBlur = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (results.length === 1) {
      commit(results[0].code, results[0].name);
      return;
    }
    if (CODE_RE.test(trimmed) && allowDirectCode) {
      commit(trimmed, '');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && results.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
      return;
    }
    if (e.key === 'ArrowUp' && results.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
      return;
    }
    if (e.key === 'Escape') {
      setShowDropdown(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      resolveCommit();
    }
  };

  // 键盘导航时把高亮项滚动进可视区
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const showList = showDropdown && (searching || results.length > 0 || hint.length > 0);

  return (
    <div className="stock-search-input-wrap" ref={wrapRef}>
      <input
        type="text"
        className={inputClassName || 'stock-search-input'}
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          if (query.trim() && results.length > 0) setShowDropdown(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        role="combobox"
        aria-expanded={showList}
        aria-controls="stock-search-input-listbox"
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
      />
      {searching && <span className="search-inline-spinner" aria-hidden="true" />}

      {showList && (
        <div
          className="stock-search-dropdown"
          ref={listRef}
          id="stock-search-input-listbox"
          role="listbox"
        >
          {searching && <div className="search-status-row">正在检索「{query.trim()}」…</div>}
          {!searching &&
            results.map((s, idx) => (
              <div
                key={s.code}
                data-idx={idx}
                role="option"
                aria-selected={activeIndex === idx}
                className={`stock-search-item${activeIndex === idx ? ' kb-active' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s.code, s.name);
                }}
              >
                <span className="code">{s.code}</span>
                {s.name && <span className="name">{s.name}</span>}
              </div>
            ))}
          {!searching && hint && (
            <div className="search-empty">
              <div className="search-empty-hint">{hint}</div>
            </div>
          )}
        </div>
      )}

      {actionLabel && (
        <button
          type="button"
          className={actionClassName}
          onClick={resolveCommit}
          disabled={disabled}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
