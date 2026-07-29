import express from 'express';
import cors from 'cors';
import { runAnalysis } from './services/analysisPipeline.js';
import { getSupportedStocks, searchStocks } from './services/dataService.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 核心分析接口
app.post('/api/analyze', async (req, res) => {
  try {
    const { stockCode } = req.body;
    if (!stockCode || !/^\d{6}$/.test(stockCode)) {
      return res.status(400).json({ error: '请提供有效的6位股票代码' });
    }
    const result = await runAnalysis(stockCode);
    res.json(result);
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: '分析过程出错', detail: (error as Error).message });
  }
});

// 获取支持的股票列表
app.get('/api/stocks', async (req, res) => {
  try {
    const stocks = await getSupportedStocks();
    res.json(stocks);
  } catch (error) {
    res.json([{ code: '600519', name: '贵州茅台', industry: '白酒' }]);
  }
});

// 搜索股票
app.get('/api/stocks/search', async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || typeof keyword !== 'string') {
      return res.status(400).json({ error: '请提供搜索关键词' });
    }
    const results = await searchStocks(keyword);
    res.json(results);
  } catch (error) {
    res.json([]);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
