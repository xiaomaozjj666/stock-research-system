import { describe, it, expect } from 'vitest';
import {
  KnowledgeGraph,
  buildFinancialGraph,
  type GraphNode,
  type GraphEdge,
  type FinancialGraphData,
} from '../knowledgeGraph.js';

// ─── 测试用金融数据 ─────────────────────────────────────────────────
const SAMPLE_DATA: FinancialGraphData = {
  sectors: [
    { name: '白酒', avgPE: 28, avgPB: 7.5, avgROE: 22 },
    { name: '电池', avgPE: 35, avgPB: 5.0, avgROE: 18 },
  ],
  stocks: [
    { code: '600519', name: '贵州茅台', sector: '白酒', pe: 30, pb: 8.2, roe: 25, grossMargin: 91 },
    { code: '000858', name: '五粮液', sector: '白酒', pe: 25, pb: 6.5, roe: 20, grossMargin: 75 },
    { code: '300750', name: '宁德时代', sector: '电池', pe: 40, pb: 5.0, roe: 18, grossMargin: 22 },
    { code: '002594', name: '比亚迪', sector: '电池', pe: 30, pb: 4.5, roe: 16, grossMargin: 18 },
  ],
};

// ─── 节点/边增删查 ──────────────────────────────────────────────────
describe('节点/边增删查', () => {
  it('addNode + getNode 正常存取', () => {
    const g = new KnowledgeGraph();
    const node: GraphNode = {
      id: 'stock:600519',
      type: 'stock',
      name: '贵州茅台',
      properties: { code: '600519' },
    };
    g.addNode(node);
    expect(g.getNode('stock:600519')).toBe(node);
    expect(g.getNode('nonexistent')).toBeUndefined();
    expect(g.nodeCount()).toBe(1);
  });

  it('addEdge 后可通过 getEdges 查到', () => {
    const g = new KnowledgeGraph();
    g.addNode({ id: 'a', type: 'stock', name: 'A', properties: {} });
    g.addNode({ id: 'b', type: 'stock', name: 'B', properties: {} });
    const edge: GraphEdge = { source: 'a', target: 'b', type: 'competes_with' };
    g.addEdge(edge);
    expect(g.edgeCount()).toBe(1);
    const edges = g.getEdges('a');
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('a');
    expect(edges[0].target).toBe('b');
  });

  it('getNeighbors 双向边正反均返回', () => {
    const g = new KnowledgeGraph();
    g.addNode({ id: 'a', type: 'stock', name: 'A', properties: {} });
    g.addNode({ id: 'b', type: 'stock', name: 'B', properties: {} });
    // competes_with 是双向边：从 a 发出，b 也应能反查到 a
    g.addEdge({ source: 'a', target: 'b', type: 'competes_with' });
    const fromA = g.getNeighbors('a');
    expect(fromA.map((n) => n.id)).toContain('b');
    const fromB = g.getNeighbors('b');
    expect(fromB.map((n) => n.id)).toContain('a');
  });

  it('getNeighbors 单向边仅正向返回', () => {
    const g = new KnowledgeGraph();
    g.addNode({ id: 'stock', type: 'stock', name: 'S', properties: {} });
    g.addNode({ id: 'sector', type: 'sector', name: 'Sec', properties: {} });
    // belongs_to 是单向边：stock -> sector
    g.addEdge({ source: 'stock', target: 'sector', type: 'belongs_to' });
    const fromStock = g.getNeighbors('stock');
    expect(fromStock.map((n) => n.id)).toContain('sector');
    // sector 反向不应看到 stock（单向边）
    const fromSector = g.getNeighbors('sector');
    expect(fromSector.map((n) => n.id)).not.toContain('stock');
  });

  it('removeNode 同时移除关联边', () => {
    const g = new KnowledgeGraph();
    g.addNode({ id: 'a', type: 'stock', name: 'A', properties: {} });
    g.addNode({ id: 'b', type: 'stock', name: 'B', properties: {} });
    g.addEdge({ source: 'a', target: 'b', type: 'competes_with' });
    expect(g.removeNode('a')).toBe(true);
    expect(g.getNode('a')).toBeUndefined();
    expect(g.nodeCount()).toBe(1);
    expect(g.edgeCount()).toBe(0);
    // 再删不存在的节点返回 false
    expect(g.removeNode('a')).toBe(false);
  });

  it('removeEdge 按 source+target+type 精确删除', () => {
    const g = new KnowledgeGraph();
    g.addNode({ id: 'a', type: 'stock', name: 'A', properties: {} });
    g.addNode({ id: 'b', type: 'stock', name: 'B', properties: {} });
    g.addEdge({ source: 'a', target: 'b', type: 'competes_with' });
    g.addEdge({ source: 'a', target: 'b', type: 'correlated_with' });
    expect(g.edgeCount()).toBe(2);
    // 只删 competes_with
    const removed = g.removeEdge('a', 'b', 'competes_with');
    expect(removed).toBe(1);
    expect(g.edgeCount()).toBe(1);
    expect(g.getEdges('a')[0].type).toBe('correlated_with');
    // 不指定 type 删剩余
    g.removeEdge('a', 'b');
    expect(g.edgeCount()).toBe(0);
  });
});

// ─── findPath ──────────────────────────────────────────────────────
describe('findPath 路径查找', () => {
  function buildLinearGraph(): KnowledgeGraph {
    const g = new KnowledgeGraph();
    g.addNode({ id: 'a', type: 'concept', name: 'A', properties: {} });
    g.addNode({ id: 'b', type: 'concept', name: 'B', properties: {} });
    g.addNode({ id: 'c', type: 'concept', name: 'C', properties: {} });
    g.addNode({ id: 'd', type: 'concept', name: 'D', properties: {} });
    g.addEdge({ source: 'a', target: 'b', type: 'correlated_with' });
    g.addEdge({ source: 'b', target: 'c', type: 'correlated_with' });
    g.addEdge({ source: 'c', target: 'd', type: 'correlated_with' });
    return g;
  }

  it('正向找到路径', () => {
    const g = buildLinearGraph();
    const path = g.findPath('a', 'd');
    expect(path).not.toBeNull();
    expect(path!.nodeIds).toEqual(['a', 'b', 'c', 'd']);
    expect(path!.edges).toHaveLength(3);
  });

  it('反向也能找到路径（无向遍历）', () => {
    const g = buildLinearGraph();
    const path = g.findPath('d', 'a');
    expect(path).not.toBeNull();
    expect(path!.nodeIds).toEqual(['d', 'c', 'b', 'a']);
  });

  it('无路径返回 null', () => {
    const g = new KnowledgeGraph();
    g.addNode({ id: 'a', type: 'concept', name: 'A', properties: {} });
    g.addNode({ id: 'b', type: 'concept', name: 'B', properties: {} });
    // 两个孤立节点，无边相连
    const path = g.findPath('a', 'b');
    expect(path).toBeNull();
  });

  it('深度限制：路径存在但超深度返回 null', () => {
    const g = buildLinearGraph();
    // a->b->c->d 需 3 跳，maxDepth=2 应找不到
    expect(g.findPath('a', 'd', 2)).toBeNull();
    // maxDepth=3 刚好能找到
    const path = g.findPath('a', 'd', 3);
    expect(path).not.toBeNull();
    expect(path!.nodeIds).toHaveLength(4);
  });

  it('from === to 返回单节点路径', () => {
    const g = buildLinearGraph();
    const path = g.findPath('a', 'a');
    expect(path).not.toBeNull();
    expect(path!.nodeIds).toEqual(['a']);
    expect(path!.edges).toHaveLength(0);
  });

  it('节点不存在返回 null', () => {
    const g = buildLinearGraph();
    expect(g.findPath('a', 'nonexistent')).toBeNull();
    expect(g.findPath('nonexistent', 'a')).toBeNull();
  });
});

// ─── queryRelated ──────────────────────────────────────────────────
describe('queryRelated 关系查询', () => {
  it('"竞争对手" 查询返回同行业竞争关系', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.queryRelated('600519 竞争对手');
    // 应包含茅台及其竞争对手五粮液
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('stock:600519');
    expect(ids).toContain('stock:000858');
    // 不应包含电池行业股票
    expect(ids).not.toContain('stock:300750');
    // 应有 competes_with 边
    expect(result.edges.some((e) => e.type === 'competes_with')).toBe(true);
  });

  it('"同行业" 查询返回行业全体成员', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.queryRelated('600519 同行业');
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('stock:600519');
    expect(ids).toContain('stock:000858');
    // 白酒行业节点也应出现
    expect(ids).toContain('sector:白酒');
  });

  it('"行业" 关键词以行业名查询', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.queryRelated('白酒行业');
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('sector:白酒');
    expect(ids).toContain('stock:600519');
    expect(ids).toContain('stock:000858');
  });

  it('无匹配关键词返回空', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.queryRelated('完全无关的查询天气足球');
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('按股票名称匹配', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.queryRelated('茅台 竞争对手');
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('stock:600519');
    expect(ids).toContain('stock:000858');
  });
});

// ─── getSectorMembers ──────────────────────────────────────────────
describe('getSectorMembers 行业成员查询', () => {
  it('返回指定行业的全部股票', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const members = g.getSectorMembers('白酒');
    expect(members).toHaveLength(2);
    const codes = members.map((m) => m.properties.code);
    expect(codes).toContain('600519');
    expect(codes).toContain('000858');
  });

  it('行业不存在返回空数组', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    expect(g.getSectorMembers('不存在的行业')).toHaveLength(0);
  });
});

// ─── getCompetitors ────────────────────────────────────────────────
describe('getCompetitors 竞争对手查询', () => {
  it('返回同行业竞争对手', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const competitors = g.getCompetitors('600519');
    expect(competitors).toHaveLength(1);
    expect(competitors[0].properties.code).toBe('000858');
  });

  it('按股票代码（非完整 id）也能解析', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const competitors = g.getCompetitors('300750');
    expect(competitors).toHaveLength(1);
    expect(competitors[0].properties.code).toBe('002594');
  });

  it('股票不存在返回空数组', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    expect(g.getCompetitors('999999')).toHaveLength(0);
  });
});

// ─── getIndicators ─────────────────────────────────────────────────
describe('getIndicators 指标查询', () => {
  it('返回股票的全部指标节点', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const indicators = g.getIndicators('600519');
    expect(indicators).toHaveLength(4);
    const keys = indicators.map((i) => i.properties.key);
    expect(keys).toContain('pe');
    expect(keys).toContain('pb');
    expect(keys).toContain('roe');
    expect(keys).toContain('grossMargin');
  });

  it('指标节点包含正确的值', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const indicators = g.getIndicators('600519');
    const grossMargin = indicators.find((i) => i.properties.key === 'grossMargin');
    expect(grossMargin?.properties.value).toBe(91);
  });

  it('股票不存在返回空数组', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    expect(g.getIndicators('999999')).toHaveLength(0);
  });
});

// ─── comparePeers ──────────────────────────────────────────────────
describe('comparePeers 同行业对比', () => {
  it('指定指标对比毛利率', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.comparePeers('600519', '毛利率');
    expect(result).not.toBeNull();
    expect(result!.sector).toBe('白酒');
    expect(result!.indicator).toBe('grossMargin');
    expect(result!.peers).toHaveLength(2);
    // 茅台毛利率 91，五粮液 75
    const moutai = result!.peers.find((p) => p.code === '600519');
    const wuliangye = result!.peers.find((p) => p.code === '000858');
    expect(moutai?.indicators.grossMargin).toBe(91);
    expect(wuliangye?.indicators.grossMargin).toBe(75);
  });

  it('英文指标键也能识别', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.comparePeers('600519', 'pe');
    expect(result!.indicator).toBe('pe');
  });

  it('不指定指标返回全部指标', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.comparePeers('600519');
    expect(result!.indicator).toBeNull();
    const moutai = result!.peers.find((p) => p.code === '600519');
    expect(Object.keys(moutai!.indicators)).toHaveLength(4);
  });

  it('返回行业平均水平', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const result = g.comparePeers('600519');
    expect(result!.sectorAverages.pe).toBe(28);
    expect(result!.sectorAverages.pb).toBe(7.5);
    expect(result!.sectorAverages.roe).toBe(22);
  });

  it('股票不存在返回 null', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    expect(g.comparePeers('999999')).toBeNull();
  });
});

// ─── toContextString ───────────────────────────────────────────────
describe('toContextString 序列化', () => {
  it('全图序列化包含节点和关系', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const text = g.toContextString();
    expect(text).toContain('【知识图谱】');
    expect(text).toContain('节点:');
    expect(text).toContain('关系:');
    expect(text).toContain('贵州茅台');
    expect(text).toContain('belongs_to');
    expect(text).toContain('competes_with');
    expect(text).toContain('has_indicator');
  });

  it('子集序列化只含指定节点', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const text = g.toContextString(['stock:600519', 'sector:白酒']);
    expect(text).toContain('贵州茅台');
    expect(text).toContain('白酒');
    // 不应包含电池行业
    expect(text).not.toContain('宁德时代');
    // 600519 -> 白酒 的 belongs_to 边应在
    expect(text).toContain('belongs_to');
  });

  it('空图序列化', () => {
    const g = new KnowledgeGraph();
    expect(g.toContextString()).toBe('【知识图谱】(空)');
  });

  it('子集序列化不跨子集的边不出现', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    // 只有茅台和宁德时代，它们之间无边
    const text = g.toContextString(['stock:600519', 'stock:300750']);
    expect(text).toContain('贵州茅台');
    expect(text).toContain('宁德时代');
    // 它们不是竞争对手（不同行业），不应有 competes_with
    expect(text).not.toContain('competes_with');
  });
});

// ─── buildFinancialGraph 工厂 ──────────────────────────────────────
describe('buildFinancialGraph 工厂函数', () => {
  it('正确创建行业节点', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const sector = g.getNode('sector:白酒');
    expect(sector).toBeDefined();
    expect(sector!.type).toBe('sector');
    expect(sector!.properties.avgPE).toBe(28);
    expect(sector!.properties.avgROE).toBe(22);
  });

  it('正确创建股票节点及 belongs_to 边', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const stock = g.getNode('stock:600519');
    expect(stock).toBeDefined();
    expect(stock!.type).toBe('stock');
    expect(stock!.name).toBe('贵州茅台');
    // belongs_to 边
    const edges = g.getEdges('stock:600519');
    expect(edges.some((e) => e.type === 'belongs_to' && e.target === 'sector:白酒')).toBe(true);
  });

  it('为每只股票创建 4 个指标节点', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const indicators = g.getIndicators('600519');
    expect(indicators).toHaveLength(4);
    const pe = indicators.find((i) => i.properties.key === 'pe');
    expect(pe?.properties.value).toBe(30);
  });

  it('同行业股票间自动建立 competes_with 边', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    // 白酒：茅台 <-> 五粮液
    const competitors = g.getCompetitors('600519');
    expect(competitors).toHaveLength(1);
    expect(competitors[0].properties.code).toBe('000858');
    // 电池：宁德时代 <-> 比亚迪
    const batteryCompetitors = g.getCompetitors('300750');
    expect(batteryCompetitors).toHaveLength(1);
    expect(batteryCompetitors[0].properties.code).toBe('002594');
  });

  it('不同行业股票间无 competes_with 边', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    const edges = g.getEdges('stock:600519');
    const competitorTargets = edges
      .filter((e) => e.type === 'competes_with')
      .map((e) => (e.source === 'stock:600519' ? e.target : e.source));
    // 不应包含电池行业股票
    expect(competitorTargets).not.toContain('stock:300750');
    expect(competitorTargets).not.toContain('stock:002594');
  });

  it('节点与边总数符合预期', () => {
    const g = buildFinancialGraph(SAMPLE_DATA);
    // 2 行业 + 4 股票 + 4*4 指标 = 22 节点
    expect(g.nodeCount()).toBe(22);
    // 4 belongs_to + 4*4 has_indicator + 白酒(1) + 电池(1) competes_with = 22 边
    expect(g.edgeCount()).toBe(22);
  });
});
