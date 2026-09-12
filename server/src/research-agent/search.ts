/**
 * 检索适配器接口
 * ------------------------------------------------------------------
 * 规划层不关心证据来自哪个渠道（通用搜索、金融数据库、内部知识库），
 * 只依赖 SearchAdapter。编排器按数组顺序将首个适配器视为主通道，
 * 其余为降级通道；任一适配器抛错都会被记录为可审计的获取路径。
 */

export interface SearchQuery {
  query: string;
  maxResults: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  publisher?: string;
  publishedAt?: string;
  /** 命中结果的来源类型；未知时由证据抽取阶段兜底为 unknown */
  sourceType?: import('./types.js').SourceType;
}

export interface FetchedDoc {
  url: string;
  title: string;
  /** 全文或主要文本（调用方负责截断） */
  text: string;
  publishedAt?: string;
}

export interface SearchAdapter {
  readonly name: string;
  search(q: SearchQuery): Promise<SearchHit[]>;
  fetch(url: string): Promise<FetchedDoc>;
}
