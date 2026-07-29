import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
});

export async function analyzeStock(stockCode: string) {
  const response = await api.post('/analyze', { stockCode });
  return response.data;
}

export async function getStockList() {
  const response = await api.get('/stocks');
  return response.data;
}

export async function searchStocks(keyword: string) {
  const response = await api.get('/stocks/search', { params: { keyword } });
  return response.data;
}

export async function runQuantAnalysis(strategy: unknown) {
  const response = await api.post('/quant/analyze', { strategy });
  return response.data;
}
