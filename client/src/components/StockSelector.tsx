import { useState, useEffect, useRef, useCallback } from 'react';
import { searchStocks, getStockList } from '../api/client';

interface StockSelectorProps {
  onAnalyze: (code: string) => void;
  loading: boolean;
}

interface Stock {
  code: string;
  name: string;
}

export default function StockSelector({ onAnalyze, loading }: StockSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Stock[]>([]);
  const [hotStocks, setHotStocks] = useState<Stock[]>([]);
  const [selectedCode, setSelectedCode] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      if (!value) {
        setSelectedCode('');
        setSelectedName('');
      }
      return;
    }

    // If user is typing and it doesn't match current selection, clear selection
    if (value !== selectedName) {
      setSelectedCode('');
    }

    // Direct 6-digit code match
    if (/^\d{6}$/.test(value.trim())) {
      setSearchResults([{ code: value.trim(), name: '' }]);
      setShowDropdown(true);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchStocks(value.trim());
        if (Array.isArray(results)) {
          setSearchResults(results.slice(0, 8));
          setShowDropdown(true);
        }
      } catch {
        setSearchResults([]);
      }
    }, 300);
  }, [selectedName]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = searchQuery.trim();
      if (/^\d{6}$/.test(trimmed)) {
        selectStock({ code: trimmed, name: '' });
      } else if (searchResults.length > 0) {
        selectStock(searchResults[0]);
      }
    }
  };

  const selectStock = (stock: Stock) => {
    setSelectedCode(stock.code);
    setSelectedName(stock.name || stock.code);
    setSearchQuery(stock.name || stock.code);
    setShowDropdown(false);
    setSearchResults([]);
  };

  const handleAnalyze = () => {
    if (selectedCode) {
      onAnalyze(selectedCode);
    }
  };

  const isActive = (code: string) => selectedCode === code;

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <div className="navbar-brand">投研系统</div>
        <div className="navbar-search" ref={searchRef}>
          <div className="stock-search-container">
            <input
              type="text"
              className="stock-search-input"
              placeholder="输入股票代码或名称"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
              onKeyDown={handleKeyDown}
            />
            {showDropdown && searchResults.length > 0 && (
              <div className="stock-search-dropdown">
                {searchResults.map((stock) => (
                  <div
                    key={stock.code}
                    className="stock-search-item"
                    onClick={() => selectStock(stock)}
                  >
                    <span className="code">{stock.code}</span>
                    {stock.name && <span className="name">{stock.name}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          {hotStocks.length > 0 && (
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
        <button
          className="btn-primary"
          onClick={handleAnalyze}
          disabled={loading || !selectedCode}
        >
          {loading ? '分析中...' : '开始分析'}
        </button>
      </div>
    </nav>
  );
}
