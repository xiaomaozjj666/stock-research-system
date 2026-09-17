import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { searchStocks, getStockList } from '../api/client';

interface StockSelectorProps {
  onAnalyze: (code: string) => void;
  loading: boolean;
}

interface Stock {
  code: string;
  name: string;
}

interface HistoryItem {
  code: string;
  name: string;
  timestamp: number;
}

/** 下拉 id 必须唯一：历史与搜索结果各是一个 listbox，此前都写死同一个 id
 * （无效 HTML，且 aria-controls 只解析到文档首个，读屏会把候选列表指向"搜索历史"） */
const HISTORY_LISTBOX_ID = 'stock-search-history-listbox';
const HISTORY_KEY = 'stock_search_history';
const MAX_HISTORY = 20;
const CODE_RE = /^\d{6}$/;

export default function StockSelector({ onAnalyze, loading }: StockSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Stock[]>([]);
  const [hotStocks, setHotStocks] = useState<Stock[]>([]);
  const [selectedCode, setSelectedCode] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** 搜索请求进行中 —— 用于展示加载态，避免用户误以为「没搜到」 */
  const [searching, setSearching] = useState(false);
  /** 键盘导航高亮项索引，-1 表示未选中 */
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  /** 搜索结果下拉的 id：与历史下拉区分，否则同 id 会让 aria-controls 指向错误的列表 */
  const resultsListboxId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 请求序号：只接受最新一次请求的结果，防止乱序响应覆盖 */
  const seqRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Read search history from localStorage on mount
  const [searchHistory, setSearchHistory] = useState<HistoryItem[]>(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Save to history when a stock is selected
  function addToHistory(code: string, name: string) {
    const newItem: HistoryItem = { code, name, timestamp: Date.now() };
    setSearchHistory((prev) => {
      const filtered = prev.filter((h) => h.code !== code);
      const updated = [newItem, ...filtered].slice(0, MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  // Delete single history item
  function removeHistoryItem(code: string) {
    setSearchHistory((prev) => {
      const updated = prev.filter((h) => h.code !== code);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  // Clear all history
  function clearHistory() {
    setSearchHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  }

  // Load hot stocks on mount
  useEffect(() => {
    getStockList()
      .then((stocks) => {
        if (Array.isArray(stocks) && stocks.length > 0) {
          setHotStocks(stocks.slice(0, 10));
        } else {
          setHotStocks([{ code: '600519', name: '贵州茅台' }]);
        }
      })
      .catch(() => {
        setHotStocks([{ code: '600519', name: '贵州茅台' }]);
      });
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setShowHistory(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 组件卸载时清理未触发的防抖定时器
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /** 执行一次搜索，只有序号匹配（即最新请求）才写入状态 */
  const runSearch = useCallback(async (keyword: string, fallbackToCode: boolean) => {
    const mySeq = ++seqRef.current;
    setSearching(true);
    try {
      const results = await searchStocks(keyword);
      if (mySeq !== seqRef.current) return; // 已有更新的请求，丢弃本次结果
      const list = Array.isArray(results) ? results.slice(0, 8) : [];
      setSearchResults(list.length === 0 && fallbackToCode ? [{ code: keyword, name: '' }] : list);
    } catch {
      if (mySeq !== seqRef.current) return;
      setSearchResults(fallbackToCode ? [{ code: keyword, name: '' }] : []);
    } finally {
      if (mySeq === seqRef.current) {
        setSearching(false);
        setShowDropdown(true);
        setActiveIndex(-1);
      }
    }
  }, []);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!value.trim()) {
        seqRef.current++; // 作废在途请求
        setSearching(false);
        setSearchResults([]);
        setShowDropdown(false);
        setShowHistory(true);
        setActiveIndex(-1);
        setSelectedCode('');
        setSelectedName('');
        return;
      }

      setShowHistory(false);

      // 用户正在输入且与已选项不符时，清空已选中的代码
      if (value !== selectedName) {
        setSelectedCode('');
      }

      const trimmed = value.trim();
      const isCode = CODE_RE.test(trimmed);
      // 立刻进入加载态，让下拉框先出现 loading，而不是空白/无反馈
      setSearching(true);
      setShowDropdown(true);
      debounceRef.current = setTimeout(() => runSearch(trimmed, isCode), isCode ? 200 : 300);
    },
    [selectedName, runSearch],
  );

  const selectStock = useCallback((stock: Stock) => {
    const displayName = stock.name || stock.code;
    seqRef.current++; // 作废在途请求，避免选中后又被搜索结果覆盖
    setSelectedCode(stock.code);
    setSelectedName(displayName);
    setSearchQuery(displayName);
    setShowDropdown(false);
    setShowHistory(false);
    setSearching(false);
    setSearchResults([]);
    setActiveIndex(-1);
    addToHistory(stock.code, displayName);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const options = showHistory
      ? searchHistory.map((h) => ({ code: h.code, name: h.name }))
      : searchResults;

    if (e.key === 'ArrowDown' && options.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % options.length);
      return;
    }
    if (e.key === 'ArrowUp' && options.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? options.length - 1 : i - 1));
      return;
    }
    if (e.key === 'Escape') {
      setShowDropdown(false);
      setShowHistory(false);
      setActiveIndex(-1);
      return;
    }
    // Ctrl/⌘+Enter 是全局「直接分析」快捷键（见 App.tsx）：这里不再顺手选中下拉项，
    // 否则一次按键既改输入框内容又发起分析，行为不可预期
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const trimmed = searchQuery.trim();
      if (activeIndex >= 0 && options[activeIndex]) {
        selectStock(options[activeIndex]);
      } else if (CODE_RE.test(trimmed)) {
        // 直接输入 6 位代码，优先用搜到的带名称结果
        const hit = searchResults.find((s) => s.code === trimmed);
        selectStock(hit ?? { code: trimmed, name: '' });
      } else if (searchResults.length > 0) {
        selectStock(searchResults[0]);
      }
    }
  };

  // 键盘导航时把高亮项滚动进可视区
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  /** 允许直接对合法 6 位代码发起分析，即使用户没点选下拉项 */
  const effectiveCode =
    selectedCode || (CODE_RE.test(searchQuery.trim()) ? searchQuery.trim() : '');

  const handleAnalyze = () => {
    if (effectiveCode && !loading) onAnalyze(effectiveCode);
  };

  const handleFocus = () => {
    if (!searchQuery.trim()) {
      setShowHistory(true);
    } else if (searchResults.length > 0) {
      setShowDropdown(true);
    }
  };

  const isActive = (code: string) => selectedCode === code;
  const showEmptyState =
    showDropdown && !searching && searchResults.length === 0 && searchQuery.trim().length > 0;

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <div className="navbar-brand">投研系统</div>
        <div className="navbar-search" ref={searchRef}>
          <div className="stock-search-container">
            <input
              type="text"
              className="stock-search-input"
              // 该输入框只有 placeholder 没有可见 label，读屏需靠 aria-label 获得名称
              aria-label="股票代码或名称搜索"
              // id 供 App 的全局快捷键（Ctrl+K 聚焦 / Ctrl+Enter 分析）定位，两处需保持一致
              id="global-stock-search"
              // 当前「真正可分析的代码」：点选下拉项后输入框里显示的是名称，
              // 只读 input.value 会取到名称而失效，故把 effectiveCode 暴露给快捷键读
              data-stock-code={effectiveCode}
              placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              onFocus={handleFocus}
              onKeyDown={handleKeyDown}
              role="combobox"
              aria-expanded={showDropdown || showHistory}
              // 两个下拉互斥渲染：aria-controls 指向当前真正可见的那个 listbox
              aria-controls={showHistory ? HISTORY_LISTBOX_ID : resultsListboxId}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
            />
            {searching && <span className="search-inline-spinner" aria-hidden="true" />}

            {/* Search History */}
            {showHistory && searchHistory.length > 0 && (
              <div
                className="stock-search-dropdown"
                ref={listRef}
                id="stock-search-listbox"
                role="listbox"
              >
                <div className="search-history">
                  <div className="search-history-header">
                    <span>搜索历史</span>
                    <button className="search-history-clear" onClick={clearHistory}>
                      清空全部
                    </button>
                  </div>
                  <ul className="search-history-list">
                    {searchHistory.map((item, idx) => (
                      <li
                        key={item.code}
                        data-idx={idx}
                        role="option"
                        aria-selected={activeIndex === idx}
                        className={`search-history-item${activeIndex === idx ? ' kb-active' : ''}`}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => selectStock({ code: item.code, name: item.name })}
                      >
                        <span className="stock-name">{item.name}</span>
                        <span className="stock-code">{item.code}</span>
                        <button
                          className="delete-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeHistoryItem(item.code);
                          }}
                          // 可访问名不能取自内容「×」（读屏会念"乘号"，语音控制也喊不中），
                          // title 在触屏与部分读屏下不播报，必须用 aria-label
                          aria-label={`删除搜索历史 ${item.name || item.code}`}
                          title="删除"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Search Results / Loading / Empty */}
            {showDropdown && (searching || searchResults.length > 0 || showEmptyState) && (
              <div
                className="stock-search-dropdown"
                ref={listRef}
                id={resultsListboxId}
                role="listbox"
              >
                {searching && (
                  <div className="search-status-row">正在检索「{searchQuery.trim()}」…</div>
                )}
                {!searching &&
                  searchResults.map((stock, idx) => (
                    <div
                      key={stock.code}
                      data-idx={idx}
                      role="option"
                      aria-selected={activeIndex === idx}
                      className={`stock-search-item${activeIndex === idx ? ' kb-active' : ''}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => selectStock(stock)}
                    >
                      <span className="code">{stock.code}</span>
                      {stock.name && <span className="name">{stock.name}</span>}
                    </div>
                  ))}
                {showEmptyState && (
                  <div className="search-empty">
                    <div className="search-empty-title">未找到「{searchQuery.trim()}」</div>
                    <div className="search-empty-hint">
                      本系统覆盖 A 股上市公司。若未找到，可尝试：① 直接输入 <b>6 位股票代码</b>； ②
                      改用<b>上市集团简称</b>搜索（部分企业以集团/科技主体上市，如「长鑫科技
                      688825」而非品牌名「长鑫存储」）； ③ 查看相关行业 ETF 或其供应链上市公司。
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Hot Stocks — shown when no history dropdown and no search results */}
          {!showHistory && hotStocks.length > 0 && (
            <div className="hot-stocks">
              {hotStocks.map((stock) => (
                <button
                  key={stock.code}
                  className={`hot-stock-tag${isActive(stock.code) ? ' active' : ''}`}
                  onClick={() => selectStock(stock)}
                >
                  {stock.name || stock.code}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 快捷键提示与按钮同列：该列比左侧搜索列矮，不会撑高 sticky 导航栏
            （顶栏一旦变高，RevealSection 的 scrollMarginTop: 96 锚点偏移就会失效）。
            样式内联：本次改动不新增 index.css 规则 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <button
            className="btn-primary"
            onClick={handleAnalyze}
            disabled={loading || !effectiveCode}
            title={!effectiveCode ? '请先选择或输入 6 位股票代码' : `分析 ${effectiveCode}`}
          >
            {loading ? '分析中...' : '开始分析'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            Ctrl+K 搜索 · Ctrl+Enter 分析
          </span>
        </div>
      </div>
    </nav>
  );
}
