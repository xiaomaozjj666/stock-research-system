/**
 * 金融知识图谱（Financial Knowledge Graph）
 * ----------------------------------------------------------------------------
 * 在向量 + BM25 混合检索（rag.ts）之上补一层关系图谱，专门解决
 * "毛利率对比 / 行业平均 / 竞争对手 / 上下游"类关系型查询。
 *
 * 纯内存图，无外部依赖。支持节点/边增删查、路径查找、关系查询、
 * 同业对比，并可序列化为 LLM 可读上下文文本。
 */

/** 图节点类型 */
export type NodeType = 'stock' | 'sector' | 'indicator' | 'concept';

/** 图边类型 */
export type EdgeType =
  | 'belongs_to'
  | 'competes_with'
  | 'correlated_with'
  | 'supplier_of'
  | 'customer_of'
  | 'has_indicator';

/** 图节点 */
export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  properties: Record<string, unknown>;
}

/** 图边 */
export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  weight?: number;
  properties?: Record<string, unknown>;
}

/** 路径查找结果 */
export interface PathResult {
  /** 路径上的节点 id 序列 */
  nodeIds: string[];
  /** 沿途经过的边 */
  edges: GraphEdge[];
}

/** 关系查询结果 */
export interface QueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 同业对比结果 */
export interface PeerComparison {
  /** 行业名称 */
  sector: string;
  /** 指标键（pe / pb / roe / grossMargin），未指定时为 null */
  indicator: string | null;
  /** 行业平均水平 */
  sectorAverages: Record<string, number>;
  /** 同业股票及其指标 */
  peers: Array<{
    code: string;
    name: string;
    indicators: Record<string, number>;
  }>;
}

/** 结构化金融数据，用于构建图谱 */
export interface FinancialGraphData {
  stocks: Array<{
    code: string;
    name: string;
    sector: string;
    pe: number;
    pb: number;
    roe: number;
    grossMargin: number;
  }>;
  sectors: Array<{
    name: string;
    avgPE: number;
    avgPB: number;
    avgROE: number;
  }>;
}

/** 指标键 -> 中文标签映射 */
const INDICATOR_LABELS: Record<string, string> = {
  pe: '市盈率(PE)',
  pb: '市净率(PB)',
  roe: '净资产收益率(ROE)',
  grossMargin: '毛利率',
};

/** 标签 -> 指标键 反查 */
const LABEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(INDICATOR_LABELS).map(([k, v]) => [v, k]),
);

/** 双向边类型（无向）：竞争对手、相关性——正反方向均可遍历 */
const BIDIRECTIONAL_TYPES = new Set<EdgeType>(['competes_with', 'correlated_with']);

/** 关系查询意图 */
type QueryIntent = 'competitor' | 'sector' | 'upstream' | 'downstream' | 'general';

/**
 * 金融知识图谱。
 * 纯内存实现，节点用 Map 索引，边用邻接表 + 逆向邻接表加速遍历。
 */
export class KnowledgeGraph {
  /** 节点表：id -> node */
  private readonly nodes = new Map<string, GraphNode>();
  /** 边列表（保留插入顺序，便于序列化与调试） */
  private readonly edges: GraphEdge[] = [];
  /** 正向邻接表：nodeId -> [{ target, edge }] */
  private readonly adjacency = new Map<string, Array<{ target: string; edge: GraphEdge }>>();
  /** 逆向邻接表：nodeId -> [{ source, edge }]（用于反向遍历） */
  private readonly reverseAdjacency = new Map<string, Array<{ source: string; edge: GraphEdge }>>();

  // ─── 节点/边增删查 ───────────────────────────────────────────────

  /** 添加节点（已存在同 id 则覆盖） */
  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, []);
    if (!this.reverseAdjacency.has(node.id)) this.reverseAdjacency.set(node.id, []);
  }

  /** 添加边（不校验节点存在性，遍历时自动跳过悬挂引用） */
  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
    const out = this.adjacency.get(edge.source) ?? [];
    out.push({ target: edge.target, edge });
    this.adjacency.set(edge.source, out);

    const inc = this.reverseAdjacency.get(edge.target) ?? [];
    inc.push({ source: edge.source, edge });
    this.reverseAdjacency.set(edge.target, inc);
  }

  /** 删除节点及其所有关联边，返回是否删除成功 */
  removeNode(id: string): boolean {
    if (!this.nodes.delete(id)) return false;
    // 移除所有涉及该节点的边
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i];
      if (e.source === id || e.target === id) {
        this.edges.splice(i, 1);
      }
    }
    this.rebuildAdjacency();
    return true;
  }

  /** 删除边（按 source+target+type 匹配，type 可选），返回删除条数 */
  removeEdge(source: string, target: string, type?: EdgeType): number {
    let count = 0;
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i];
      if (e.source === source && e.target === target && (type === undefined || e.type === type)) {
        this.edges.splice(i, 1);
        count++;
      }
    }
    if (count > 0) this.rebuildAdjacency();
    return count;
  }

  /** 获取节点 */
  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** 获取所有节点 */
  getAllNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  /** 获取所有边 */
  getAllEdges(): GraphEdge[] {
    return [...this.edges];
  }

  /** 节点数量 */
  nodeCount(): number {
    return this.nodes.size;
  }

  /** 边数量 */
  edgeCount(): number {
    return this.edges.length;
  }

  // ─── 邻居与边查询 ────────────────────────────────────────────────

  /**
   * 获取邻居节点（含正/反向）。
   * 双向边类型（competes_with / correlated_with）正反均算；
   * 单向边按方向只在相邻方向出现。
   */
  getNeighbors(id: string): GraphNode[] {
    const result: GraphNode[] = [];
    const seen = new Set<string>();
    // 正向：当前节点发出的边
    for (const { target } of this.adjacency.get(id) ?? []) {
      if (seen.has(target)) continue;
      const n = this.nodes.get(target);
      if (n) {
        result.push(n);
        seen.add(target);
      }
    }
    // 反向：指向当前节点的边（仅双向类型计入）
    for (const { source, edge } of this.reverseAdjacency.get(id) ?? []) {
      if (seen.has(source)) continue;
      if (!BIDIRECTIONAL_TYPES.has(edge.type)) continue;
      const n = this.nodes.get(source);
      if (n) {
        result.push(n);
        seen.add(source);
      }
    }
    return result;
  }

  /** 获取与某节点相关的所有边（含正/反向） */
  getEdges(nodeId: string): GraphEdge[] {
    const out = (this.adjacency.get(nodeId) ?? []).map((e) => e.edge);
    const inc = (this.reverseAdjacency.get(nodeId) ?? []).map((e) => e.edge);
    return [...out, ...inc];
  }

  // ─── 路径查找 ────────────────────────────────────────────────────

  /**
   * BFS 查找两节点间关联路径。
   * 所有边均按无向处理（关系图谱重在"可达"），maxDepth 限制跳数。
   * 返回路径节点序列与沿途边；无路径返回 null。
   */
  findPath(from: string, to: string, maxDepth = 5): PathResult | null {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    if (from === to) return { nodeIds: [from], edges: [] };

    const visited = new Set<string>([from]);
    const queue: Array<{ nodeId: string; path: string[]; edges: GraphEdge[] }> = [
      { nodeId: from, path: [from], edges: [] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const { nodeId, path, edges } = current;
      // 已达深度上限，不再扩展
      if (path.length - 1 >= maxDepth) continue;

      // 正向遍历
      for (const { target, edge } of this.adjacency.get(nodeId) ?? []) {
        if (visited.has(target)) continue;
        const newPath = [...path, target];
        const newEdges = [...edges, edge];
        if (target === to) return { nodeIds: newPath, edges: newEdges };
        visited.add(target);
        queue.push({ nodeId: target, path: newPath, edges: newEdges });
      }
      // 反向遍历（含单向边的反向，用于发现"谁指向当前节点"的路径）
      for (const { source, edge } of this.reverseAdjacency.get(nodeId) ?? []) {
        if (visited.has(source)) continue;
        const newPath = [...path, source];
        const newEdges = [...edges, edge];
        if (source === to) return { nodeIds: newPath, edges: newEdges };
        visited.add(source);
        queue.push({ nodeId: source, path: newPath, edges: newEdges });
      }
    }
    return null;
  }

  // ─── 关系查询 ────────────────────────────────────────────────────

  /**
   * 根据查询关键词找相关节点与关系。
   * 支持"竞争对手"/"同行业"/"上下游"等关系查询意图识别。
   */
  queryRelated(query: string): QueryResult {
    const tokens = tokenize(query);
    if (tokens.length === 0) return { nodes: [], edges: [] };

    const intent = detectIntent(query);
    const seeds = this.findNodesByTokens(tokens);
    if (seeds.length === 0) return { nodes: [], edges: [] };

    const resultNodes = new Map<string, GraphNode>();
    const resultEdges = new Map<string, GraphEdge>();
    const edgeKey = (e: GraphEdge) => `${e.source}->${e.target}:${e.type}`;

    for (const seed of seeds) {
      resultNodes.set(seed.id, seed);

      if (intent === 'competitor') {
        // 竞争对手：沿 competes_with 扩展
        for (const edge of this.getEdges(seed.id)) {
          if (edge.type !== 'competes_with') continue;
          const otherId = edge.source === seed.id ? edge.target : edge.source;
          const other = this.nodes.get(otherId);
          if (other) {
            resultNodes.set(other.id, other);
            resultEdges.set(edgeKey(edge), edge);
          }
        }
      } else if (intent === 'sector') {
        // 同行业：若 seed 本身是行业节点直接取成员；否则先找所属行业再取成员
        if (seed.type === 'sector') {
          for (const { source, edge } of this.reverseAdjacency.get(seed.id) ?? []) {
            if (edge.type !== 'belongs_to') continue;
            const member = this.nodes.get(source);
            if (member) {
              resultNodes.set(member.id, member);
              resultEdges.set(edgeKey(edge), edge);
            }
          }
        } else {
          for (const { target, edge } of this.adjacency.get(seed.id) ?? []) {
            if (edge.type !== 'belongs_to') continue;
            const sector = this.nodes.get(target);
            if (!sector || sector.type !== 'sector') continue;
            resultNodes.set(sector.id, sector);
            resultEdges.set(edgeKey(edge), edge);
            // 获取行业所有成员
            for (const rev of this.reverseAdjacency.get(sector.id) ?? []) {
              if (rev.edge.type !== 'belongs_to') continue;
              const member = this.nodes.get(rev.source);
              if (member) {
                resultNodes.set(member.id, member);
                resultEdges.set(edgeKey(rev.edge), rev.edge);
              }
            }
          }
        }
      } else if (intent === 'upstream' || intent === 'downstream') {
        // 上下游：沿 supplier_of / customer_of 扩展
        const types: EdgeType[] = intent === 'upstream' ? ['supplier_of'] : ['customer_of'];
        for (const edge of this.getEdges(seed.id)) {
          if (!types.includes(edge.type)) continue;
          const otherId = edge.source === seed.id ? edge.target : edge.source;
          const other = this.nodes.get(otherId);
          if (other) {
            resultNodes.set(other.id, other);
            resultEdges.set(edgeKey(edge), edge);
          }
        }
      } else {
        // 默认：扩展所有直接邻居
        for (const edge of this.getEdges(seed.id)) {
          const otherId = edge.source === seed.id ? edge.target : edge.source;
          const other = this.nodes.get(otherId);
          if (other) {
            resultNodes.set(other.id, other);
            resultEdges.set(edgeKey(edge), edge);
          }
        }
      }
    }

    return { nodes: [...resultNodes.values()], edges: [...resultEdges.values()] };
  }

  /** 获取某行业所有成员 */
  getSectorMembers(sectorName: string): GraphNode[] {
    const sector = this.findNodeByName(sectorName, 'sector');
    if (!sector) return [];
    const members: GraphNode[] = [];
    for (const { source, edge } of this.reverseAdjacency.get(sector.id) ?? []) {
      if (edge.type !== 'belongs_to') continue;
      const member = this.nodes.get(source);
      if (member && member.type === 'stock') members.push(member);
    }
    return members;
  }

  /** 获取竞争对手列表 */
  getCompetitors(stockCode: string): GraphNode[] {
    const stock = this.resolveStock(stockCode);
    if (!stock) return [];
    const competitors: GraphNode[] = [];
    const seen = new Set<string>([stock.id]);
    for (const edge of this.getEdges(stock.id)) {
      if (edge.type !== 'competes_with') continue;
      const otherId = edge.source === stock.id ? edge.target : edge.source;
      if (seen.has(otherId)) continue;
      const other = this.nodes.get(otherId);
      if (other && other.type === 'stock') {
        competitors.push(other);
        seen.add(otherId);
      }
    }
    return competitors;
  }

  /** 获取某股票关联的指标（如毛利率/PE/ROE） */
  getIndicators(stockCode: string): GraphNode[] {
    const stock = this.resolveStock(stockCode);
    if (!stock) return [];
    const indicators: GraphNode[] = [];
    for (const { target, edge } of this.adjacency.get(stock.id) ?? []) {
      if (edge.type !== 'has_indicator') continue;
      const ind = this.nodes.get(target);
      if (ind && ind.type === 'indicator') indicators.push(ind);
    }
    return indicators;
  }

  /**
   * 同行业对比：返回同行业所有股票的指定指标（未指定则返回全部指标）。
   * 同时返回行业平均水平供对比参考。
   */
  comparePeers(stockCode: string, indicator?: string): PeerComparison | null {
    const stock = this.resolveStock(stockCode);
    if (!stock) return null;

    // 找到所属行业
    let sectorName = '';
    let sectorId = '';
    for (const { target, edge } of this.adjacency.get(stock.id) ?? []) {
      if (edge.type !== 'belongs_to') continue;
      const sector = this.nodes.get(target);
      if (sector && sector.type === 'sector') {
        sectorName = sector.name;
        sectorId = sector.id;
        break;
      }
    }
    if (!sectorId) return null;

    // 获取行业所有成员
    const members = this.getSectorMembers(sectorName);

    // 归一化指标键
    const indicatorKey = indicator ? this.resolveIndicatorKey(indicator) : null;

    // 提取行业平均水平
    const sectorNode = this.nodes.get(sectorId);
    const sectorAverages: Record<string, number> = {};
    if (sectorNode) {
      const props = sectorNode.properties;
      if (typeof props.avgPE === 'number') sectorAverages.pe = props.avgPE;
      if (typeof props.avgPB === 'number') sectorAverages.pb = props.avgPB;
      if (typeof props.avgROE === 'number') sectorAverages.roe = props.avgROE;
    }

    const peers = members.map((m) => ({
      code: String(m.properties.code ?? m.id),
      name: m.name,
      indicators: this.extractIndicators(m),
    }));

    return { sector: sectorName, indicator: indicatorKey, sectorAverages, peers };
  }

  // ─── 序列化 ──────────────────────────────────────────────────────

  /**
   * 把图谱子集序列化为 LLM 可读的上下文文本。
   * 若指定 nodeIds，只序列化这些节点及其之间的边。
   */
  toContextString(nodeIds?: string[]): string {
    let targetNodes: GraphNode[];
    let targetEdges: GraphEdge[];

    if (nodeIds) {
      const idSet = new Set(nodeIds);
      targetNodes = nodeIds
        .map((id) => this.nodes.get(id))
        .filter((n): n is GraphNode => n !== undefined);
      targetEdges = this.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    } else {
      targetNodes = [...this.nodes.values()];
      targetEdges = [...this.edges];
    }

    if (targetNodes.length === 0) return '【知识图谱】(空)';

    const lines: string[] = ['【知识图谱】', '节点:'];
    for (const node of targetNodes) {
      const props = formatProperties(node.properties);
      lines.push(`- [${node.type}] ${node.id} ${node.name}${props ? ` (${props})` : ''}`);
    }
    lines.push('关系:');
    for (const edge of targetEdges) {
      const src = this.nodes.get(edge.source);
      const tgt = this.nodes.get(edge.target);
      const srcLabel = src ? src.name : edge.source;
      const tgtLabel = tgt ? tgt.name : edge.target;
      const w = edge.weight !== undefined ? ` w=${edge.weight}` : '';
      lines.push(`- ${srcLabel} ->[${edge.type}${w}]-> ${tgtLabel}`);
    }
    return lines.join('\n');
  }

  // ─── 内部工具方法 ────────────────────────────────────────────────

  /** 重建邻接表（删除节点/边后调用） */
  private rebuildAdjacency(): void {
    this.adjacency.clear();
    this.reverseAdjacency.clear();
    for (const id of this.nodes.keys()) {
      this.adjacency.set(id, []);
      this.reverseAdjacency.set(id, []);
    }
    for (const edge of this.edges) {
      const out = this.adjacency.get(edge.source) ?? [];
      out.push({ target: edge.target, edge });
      this.adjacency.set(edge.source, out);

      const inc = this.reverseAdjacency.get(edge.target) ?? [];
      inc.push({ source: edge.source, edge });
      this.reverseAdjacency.set(edge.target, inc);
    }
  }

  /** 按名称或 id 查找节点（可限定类型） */
  private findNodeByName(name: string, type?: NodeType): GraphNode | undefined {
    for (const node of this.nodes.values()) {
      if (type && node.type !== type) continue;
      if (node.name === name || node.id === name) return node;
    }
    return undefined;
  }

  /** 按股票代码或 id 解析股票节点 */
  private resolveStock(stockCode: string): GraphNode | undefined {
    // 先按 id 精确匹配
    const byId = this.nodes.get(stockCode);
    if (byId && byId.type === 'stock') return byId;
    // 再按 properties.code 匹配
    for (const node of this.nodes.values()) {
      if (node.type === 'stock' && String(node.properties.code) === stockCode) {
        return node;
      }
    }
    return undefined;
  }

  /** 根据分词匹配节点（id / name / properties.code） */
  private findNodesByTokens(tokens: string[]): GraphNode[] {
    const tokenSet = new Set(tokens.map((t) => t.toLowerCase()));
    const result: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      // 匹配 id
      if (tokenSet.has(node.id.toLowerCase())) {
        result.push(node);
        continue;
      }
      // 匹配 name（中文按二元组）
      const nameTokens = new Set(tokenize(node.name));
      let matched = false;
      for (const t of tokenSet) {
        if (nameTokens.has(t)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        result.push(node);
        continue;
      }
      // 匹配 properties.code
      const code = String(node.properties.code ?? '');
      if (code && tokenSet.has(code.toLowerCase())) {
        result.push(node);
      }
    }
    return result;
  }

  /** 归一化指标键：支持英文键 / 中文标签 / 模糊匹配 */
  private resolveIndicatorKey(indicator: string): string | null {
    const lower = indicator.toLowerCase();
    if (INDICATOR_LABELS[lower]) return lower;
    if (LABEL_TO_KEY[indicator]) return LABEL_TO_KEY[indicator];
    // 模糊匹配
    if (indicator.includes('毛利')) return 'grossMargin';
    if (indicator.includes('PE') || indicator.includes('市盈')) return 'pe';
    if (indicator.includes('PB') || indicator.includes('市净')) return 'pb';
    if (indicator.includes('ROE') || indicator.includes('净资产收益')) return 'roe';
    return null;
  }

  /** 从股票节点的 has_indicator 边提取指标值 */
  private extractIndicators(stock: GraphNode): Record<string, number> {
    const result: Record<string, number> = {};
    for (const { target, edge } of this.adjacency.get(stock.id) ?? []) {
      if (edge.type !== 'has_indicator') continue;
      const ind = this.nodes.get(target);
      if (!ind || ind.type !== 'indicator') continue;
      const key = String(ind.properties.key ?? '');
      const value = Number(ind.properties.value);
      if (key && Number.isFinite(value)) {
        result[key] = value;
      }
    }
    return result;
  }
}

// ─── 模块级工具函数 ─────────────────────────────────────────────────

/** 简单分词：提取股票代码（6位数字）、英文词、中文二元组 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const codes = lower.match(/\d{6}/g) ?? [];
  const latin = lower.match(/[a-z]+/g) ?? [];
  const cjk = lower.match(/[一-龥]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...codes, ...latin, ...bigrams];
}

/** 从查询文本识别关系意图 */
function detectIntent(query: string): QueryIntent {
  if (query.includes('竞争对手') || query.includes('竞争')) return 'competitor';
  if (
    query.includes('同行业') ||
    query.includes('同行') ||
    query.includes('行业平均') ||
    query.includes('行业')
  ) {
    return 'sector';
  }
  if (query.includes('上游') || query.includes('供应商')) return 'upstream';
  if (query.includes('下游') || query.includes('客户')) return 'downstream';
  return 'general';
}

/** 把属性对象格式化为可读字符串 */
function formatProperties(props: Record<string, unknown>): string {
  return Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(', ');
}

// ─── 工厂函数 ───────────────────────────────────────────────────────

/**
 * 从结构化金融数据构建知识图谱。
 * - 创建行业节点（含平均 PE/PB/ROE）
 * - 创建股票节点 + belongs_to 行业 + has_indicator 指标
 * - 同行业股票间自动建立 competes_with 边
 */
export function buildFinancialGraph(data: FinancialGraphData): KnowledgeGraph {
  const graph = new KnowledgeGraph();

  // 1. 创建行业节点
  for (const sector of data.sectors) {
    graph.addNode({
      id: `sector:${sector.name}`,
      type: 'sector',
      name: sector.name,
      properties: {
        avgPE: sector.avgPE,
        avgPB: sector.avgPB,
        avgROE: sector.avgROE,
      },
    });
  }

  // 2. 创建股票节点 + belongs_to 边 + has_indicator 边
  for (const stock of data.stocks) {
    const stockId = `stock:${stock.code}`;
    graph.addNode({
      id: stockId,
      type: 'stock',
      name: stock.name,
      properties: {
        code: stock.code,
        sector: stock.sector,
      },
    });

    // belongs_to 行业
    const sectorId = `sector:${stock.sector}`;
    if (graph.getNode(sectorId)) {
      graph.addEdge({ source: stockId, target: sectorId, type: 'belongs_to' });
    }

    // has_indicator 指标节点
    const indicators: Array<[string, number]> = [
      ['pe', stock.pe],
      ['pb', stock.pb],
      ['roe', stock.roe],
      ['grossMargin', stock.grossMargin],
    ];
    for (const [key, value] of indicators) {
      const indId = `ind:${stock.code}:${key}`;
      graph.addNode({
        id: indId,
        type: 'indicator',
        name: INDICATOR_LABELS[key] ?? key,
        properties: { key, value, stock: stock.code },
      });
      graph.addEdge({
        source: stockId,
        target: indId,
        type: 'has_indicator',
        weight: value,
      });
    }
  }

  // 3. 同行业股票间添加 competes_with 边
  const sectorMap = new Map<string, string[]>();
  for (const stock of data.stocks) {
    const arr = sectorMap.get(stock.sector) ?? [];
    arr.push(stock.code);
    sectorMap.set(stock.sector, arr);
  }
  for (const codes of sectorMap.values()) {
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        graph.addEdge({
          source: `stock:${codes[i]}`,
          target: `stock:${codes[j]}`,
          type: 'competes_with',
        });
      }
    }
  }

  return graph;
}
